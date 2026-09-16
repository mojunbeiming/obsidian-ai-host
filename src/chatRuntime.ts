/**
 * One assistant turn, from assembled messages to a saved reply.
 *
 * Pure in the way that matters: the transport is injected, so the whole
 * streaming path -- frame boundaries, reasoning deltas, usage, `[DONE]`, a
 * provider error frame, the user pressing stop -- is exercised by `node --test`
 * with scripted chunks instead of by a real model.
 *
 * ## What this deliberately does not do
 *
 * No tool loop and no RAG injection: the v1 host sends messages and reads text.
 * A tool-call frame is counted and ignored rather than answered halfway, because
 * answering one without the approval state machine would be an unattended write
 * path, which is exactly what the plan forbids at this stage.
 */

import { adapterFor } from "../sdk/src/ai/aiAdapters/index";
import { mergeToolCallDeltas } from "../sdk/src/ai/aiTools";
import { AiSseParser, type AiSseProblem } from "../sdk/src/ai/aiSse";
import { keepRecentMessages, type AiChatMessage, type AiStreamEvent, type AiToolCall, type AiToolDefinition, type AiUsage } from "../sdk/src/ai/aiChat";
import type { AiTransport } from "../sdk/src/ai/aiTransport";
import type { AiRuntimeConfig } from "./providerConfig";
import { redactSecrets } from "./diagnostics";

/**
 * The host's standing instructions.
 *
 * Short on purpose. The domain prompt (how to make cards, how to plan tasks)
 * belongs to the skill that knows the format; this is only the behaviour every
 * conversation needs, and the rule about writing is here because the model has
 * no write tool at all -- saying so prevents it from claiming it saved
 * something.
 */
export const AI_HOST_SYSTEM_PROMPT = [
  "你是 SFC 插件套件的 AI 助手，运行在用户的 Obsidian 库里。",
  "回答使用用户提问的语言；不确定就说不确定，不要编造笔记内容。",
  "你不能直接修改用户的笔记：需要写入时，先给出草稿并让用户确认。",
].join("\n");

export interface ChatTurnCallbacks {
  /** Called per text delta with the delta and the accumulated text. */
  onText?(delta: string, full: string): void;
  /** Called per reasoning delta, when the provider streams one. */
  onReasoning?(delta: string, full: string): void;
}

/** One plain step a run recorder may persist. */
export interface ChatRuntimeStep {
  kind: string;
  title: string;
  detail?: string;
  level?: "info" | "warn" | "error";
  status?: "running" | "ok" | "failed";
  meta?: Record<string, string | number | boolean>;
  at?: number;
}

export interface ChatRuntimeHooks {
  onStep?(step: ChatRuntimeStep): void;
}

export interface ChatTurnInput {
  config: AiRuntimeConfig;
  messages: AiChatMessage[];
  transport: AiTransport;
  signal?: AbortSignal;
  maxTokens?: number;
  /** Tools to offer this turn; the host builds them from its read-only registry. */
  tools?: AiToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  callbacks?: ChatTurnCallbacks;
  /** Optional run mirror: this module never imports the run store. */
  hooks?: ChatRuntimeHooks;
}

export interface ChatTurnResult {
  ok: boolean;
  text: string;
  reasoning: string;
  usage?: AiUsage;
  finishReason?: string;
  /** User-facing failure text; never contains the key (`redactSecrets` runs over it). */
  error?: string;
  aborted?: boolean;
  /** Frames the parser could not read; kept for the trace, not shown as an error. */
  malformedFrames?: AiSseProblem[];
  /** Tool calls the model requested, merged across streamed deltas. */
  toolCalls: AiToolCall[];
}

/**
 * Anthropic reports prompt and completion tokens in two events; OpenAI in one.
 * Taking the max per field keeps both from double-counting.
 */
function mergeUsage(previous: AiUsage | undefined, next: AiUsage): AiUsage {
  if (!previous) return next;
  const promptTokens = Math.max(previous.promptTokens, next.promptTokens);
  const completionTokens = Math.max(previous.completionTokens, next.completionTokens);
  return { promptTokens, completionTokens, totalTokens: Math.max(previous.totalTokens, next.totalTokens, promptTokens + completionTokens) };
}

/** Assemble the wire messages: one system turn, trimmed history, then the user turn. */
export function buildConversationMessages(input: {
  systemPrompt?: string;
  history: readonly AiChatMessage[];
  userText: string;
  maxContextMessages: number;
}): AiChatMessage[] {
  const system = [AI_HOST_SYSTEM_PROMPT, (input.systemPrompt ?? "").trim()].filter(Boolean).join("\n\n");
  const history = keepRecentMessages(input.history, input.maxContextMessages);
  const messages: AiChatMessage[] = [{ role: "system", content: system }, ...history];
  if (input.userText.trim()) messages.push({ role: "user", content: input.userText });
  return messages;
}

/** Run one turn; never throws for a provider or transport failure. */
export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const { config, transport, signal } = input;
  const adapter = adapterFor(config.protocol);
  if (!adapter) {
    return failure(`宿主还不能使用 ${config.protocol} 协议。`);
  }
  const emit = (step: ChatRuntimeStep): void => {
    try {
      input.hooks?.onStep?.({ ...step, at: step.at ?? Date.now() });
    } catch {
      /* a mirror that throws must not break the turn it is watching */
    }
  };
  emit({
    kind: "request",
    title: `请求 ${config.model}`,
    status: "running",
    meta: { stream: config.stream, protocol: config.protocol, tools: input.tools?.length ?? 0 },
  });
  const request = {
    model: config.model,
    messages: input.messages,
    stream: config.stream,
    temperature: config.temperature,
    ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    ...(input.tools?.length ? { tools: input.tools, toolChoice: input.toolChoice ?? ("auto" as const) } : {}),
  };
  const httpRequest = adapter.build(config.baseUrl, request, {
    apiKey: config.apiKey,
    authHeader: config.authHeader,
    authPrefix: config.authPrefix,
    extraHeaders: config.extraHeaders,
  });

  if (!config.stream) {
    try {
      const response = await transport.send(httpRequest, { signal, timeoutMs: config.timeoutMs });
      if (response.status < 200 || response.status >= 300) {
        emit({ kind: "error", level: "error", status: "failed", title: `HTTP ${response.status}`, detail: response.text.slice(0, 2000) });
        return failure(httpFailureMessage(response.status, response.text));
      }
      const reply = adapter.parseReply(response.text);
      emit({ kind: "response.raw", title: "模型回复", detail: reply.text, status: "ok" });
      if (reply.usage) {
        emit({ kind: "usage", title: "用量", status: "ok", meta: { prompt: reply.usage.promptTokens, completion: reply.usage.completionTokens, total: reply.usage.totalTokens } });
      }
      return {
        ok: true,
        text: reply.text,
        reasoning: reply.reasoning ?? "",
        toolCalls: reply.toolCalls ?? [],
        ...(reply.usage ? { usage: reply.usage } : {}),
        ...(reply.finishReason ? { finishReason: reply.finishReason } : {}),
      };
    } catch (error) {
      const aborted = Boolean((error as { code?: unknown; name?: unknown } | null)?.code === "aborted" || (error as { name?: unknown } | null)?.name === "AbortError");
      emit({ kind: aborted ? "cancel" : "error", level: aborted ? "warn" : "error", status: aborted ? "ok" : "failed", title: aborted ? "已取消" : "请求失败", detail: error instanceof Error ? error.message : String(error) });
      return failureFrom(error);
    }
  }

  let text = "";
  let reasoning = "";
  let usage: AiUsage | undefined;
  let finishReason: string | undefined;
  let streamError: string | undefined;
  let sawDone = false;
  let frameCount = 0;
  const malformedFrames: AiSseProblem[] = [];
  const toolCallEvents: Extract<AiStreamEvent, { type: "tool_call" }>[] = [];
  const parser = new AiSseParser({ onError: (problem) => malformedFrames.push(problem) });

  const applyEvents = (events: AiStreamEvent[]): void => {
    for (const event of events) {
      switch (event.type) {
        case "text": {
          const first = !text;
          text += event.text;
          if (first) emit({ kind: "stream.first-token", title: "收到首段内容", status: "ok" });
          input.callbacks?.onText?.(event.text, text);
          break;
        }
        case "reasoning":
          reasoning += event.text;
          input.callbacks?.onReasoning?.(event.text, reasoning);
          break;
        case "usage":
          usage = mergeUsage(usage, event.usage);
          break;
        case "finish":
          finishReason = event.reason;
          break;
        case "done":
          sawDone = true;
          break;
        case "error":
          streamError = event.message;
          break;
        case "tool_call":
          toolCallEvents.push(event);
          break;
        case "annotation":
          // Citations are carried on the non-stream path; the stream UI does not
          // render them yet.
          break;
      }
    }
  };

  try {
    const stream = await transport.stream(httpRequest, { signal, timeoutMs: config.timeoutMs });
    if (stream.status < 200 || stream.status >= 300) {
      const body = await readSome(stream.chunks, 600);
      emit({ kind: "error", level: "error", status: "failed", title: `HTTP ${stream.status}`, detail: body });
      return failure(httpFailureMessage(stream.status, body));
    }
    for await (const chunk of stream.chunks) {
      const frames = parser.push(chunk);
      frameCount += frames.length;
      for (const frame of frames) applyEvents(adapter.parseChunk(frame, (problem) => {
        malformedFrames.push(problem);
        emit({ kind: "stream.frame", level: "warn", status: "ok", title: "跳过无法解析的数据帧", detail: problem.raw, meta: { reason: problem.reason } });
      }));
      if (sawDone || streamError) break;
    }
    if (!sawDone && !streamError) {
      // A server may close without `[DONE]`; whatever arrived is still the
      // answer, and `flush` recovers a final frame with no blank line.
      const rest = parser.flush();
      frameCount += rest.length;
      for (const frame of rest) applyEvents(adapter.parseChunk(frame, (problem) => {
        malformedFrames.push(problem);
        emit({ kind: "stream.frame", level: "warn", status: "ok", title: "跳过无法解析的数据帧", detail: problem.raw, meta: { reason: problem.reason } });
      }));
    }
  } catch (error) {
    const aborted = Boolean((error as { code?: unknown; name?: unknown } | null)?.code === "aborted" || (error as { name?: unknown } | null)?.name === "AbortError");
    emit({ kind: aborted ? "cancel" : "error", level: aborted ? "warn" : "error", status: aborted ? "ok" : "failed", title: aborted ? "已取消" : "流式请求失败", detail: error instanceof Error ? error.message : String(error) });
    return failureFrom(error);
  }

  if (streamError) {
    emit({ kind: "error", level: "error", status: "failed", title: "服务商返回错误", detail: streamError });
    return failure(streamError, { reasoning, usage, malformedFrames });
  }
  if (!text.trim() && !reasoning.trim()) {
    emit({ kind: "error", level: "error", status: "failed", title: "流式回复为空" });
    return failure(
      frameCount === 0
        ? "流式回复里没有收到任何数据帧。"
        : "流式回复结束了，但没有文本内容。",
      { reasoning, usage, malformedFrames },
    );
  }
  emit({ kind: "response.raw", title: "模型回复", detail: text || reasoning, status: "ok" });
  if (usage) {
    emit({ kind: "usage", title: "用量", status: "ok", meta: { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens } });
  }
  if (finishReason) emit({ kind: "finish", title: finishReason, status: "ok" });
  return {
    ok: true,
    text,
    reasoning,
    toolCalls: mergeToolCallDeltas(toolCallEvents),
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(malformedFrames.length ? { malformedFrames } : {}),
  };
}

function failure(error: string, extra: Partial<ChatTurnResult> = {}): ChatTurnResult {
  return { ok: false, text: "", reasoning: "", toolCalls: [], error: redactSecrets(error), ...extra };
}

function failureFrom(error: unknown): ChatTurnResult {
  const record = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (record && (record.code === "aborted" || record.name === "AbortError")) {
    return { ok: false, text: "", reasoning: "", toolCalls: [], aborted: true, error: "已取消。" };
  }
  const message = error instanceof Error ? error.message : String(error);
  return failure(message);
}

/** Read at most `limit` characters from a stream, for an error body. */
async function readSome(chunks: AsyncIterable<string>, limit: number): Promise<string> {
  let text = "";
  try {
    for await (const chunk of chunks) {
      text += chunk;
      if (text.length >= limit) break;
    }
  } catch {
    // The status is already known; an unreadable error body is not a new failure.
  }
  return text.slice(0, limit);
}

/**
 * A failed HTTP status, phrased as the change that would fix it.
 *
 * The status meanings are the ones a user can act on from this app: a rejected
 * key, a wrong path, a rate limit, a server that is not up. The body is attached
 * because providers put the real reason there, run through the same redaction as
 * diagnostics -- error bodies have been observed echoing the request.
 */
export function httpFailureMessage(status: number, body: string): string {
  const snippet = redactSecrets(body.replace(/\s+/g, " ").trim()).slice(0, 200);
  const trailer = snippet ? ` 返回：${snippet}` : "";
  if (status === 401 || status === 403) return `API Key 被拒绝了（${status}）。检查设置里的 Key 是否属于当前服务商。${trailer}`;
  if (status === 404) return `端点没有这个路径（404）。地址应写到服务商根或 /v1 为止。${trailer}`;
  if (status === 429) return `触发限流或额度用尽（429），稍后重试。${trailer}`;
  if (status >= 500) return `服务端错误（${status}），服务可能没起来或模型没加载。${trailer}`;
  return `请求失败（${status}）。${trailer}`;
}