/**
 * The Anthropic Messages protocol.
 *
 * Four differences from OpenAI, each of which fails in a way that reads like a
 * different problem: `system` is a top-level field (inside `messages` it is a
 * 400 about roles), `max_tokens` is required, images are base64 source objects
 * rather than data URLs, and a tool result is a `tool_result` block inside a
 * *user* turn -- not a `tool` role.
 *
 * Pure: request bodies in, normalized events out.
 */

import {
  imagesOf,
  messageText,
  messageWireContent,
  type AiChatMessage,
  type AiChatReply,
  type AiChatRequest,
  type AiStreamEvent,
  type AiUsage,
} from "../aiChat";
import { isDoneFrame, tryParseSseJson, type AiSseFrame, type AiSseProblem } from "../aiSse";
import type { AiHttpRequest } from "../aiTransport";
import { AiAdapterError, openAiHeaders, type AiAdapterAuth } from "./openai";

/** The Messages path hangs off `/v1` for every Anthropic-compatible service. */
export function anthropicMessagesUrl(baseUrl: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

/** `max_tokens` is mandatory; 4096 is comfortably above a full answer. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

export function buildAnthropicRequest(baseUrl: string, request: AiChatRequest, auth: AiAdapterAuth): AiHttpRequest {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens && request.maxTokens > 0 ? Math.floor(request.maxTokens) : ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: encodeAnthropicMessages(request.messages),
  };
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => messageText(message).trim())
    .filter(Boolean)
    .join("\n\n");
  if (system) body.system = system;
  if (typeof request.temperature === "number" && Number.isFinite(request.temperature)) body.temperature = request.temperature;
  if (request.stream) body.stream = true;
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
    body.tool_choice = request.toolChoice === "none" ? { type: "none" } : { type: "auto" };
  }
  return {
    url: anthropicMessagesUrl(baseUrl),
    method: "POST",
    headers: openAiHeaders(auth),
    body: JSON.stringify(body),
  };
}

/**
 * Turns with roles Anthropic accepts.
 *
 * Consecutive turns of the same role merge; tool_result blocks are collected
 * into the user turn that follows the assistant's tool_use, which is the only
 * arrangement the API accepts.
 */
export function encodeAnthropicMessages(messages: readonly AiChatMessage[]): unknown[] {
  const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId ?? "", content: messageText(message) };
      const last = out[out.length - 1];
      if (last && last.role === "user") last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const content: unknown[] = [];
    const text = messageText(message);
    if (text.trim()) content.push({ type: "text", text });
    for (const image of imagesOf(messageWireContent(message))) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } });
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: parseArguments(call.arguments) });
      }
    }
    if (!content.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}

function parseArguments(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseAnthropicReply(text: string): AiChatReply {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AiAdapterError("invalid-json", `端点返回的不是 JSON：${text.trim().slice(0, 200)}`);
  }
  if (!payload || typeof payload !== "object") throw new AiAdapterError("shape", "Anthropic 的回复不是一个 JSON 对象。");
  return anthropicReplyFromPayload(payload as Record<string, unknown>);
}

export function anthropicReplyFromPayload(payload: Record<string, unknown>): AiChatReply {
  if (payload.error) throw new AiAdapterError("provider-error", `Anthropic 返回错误：${describeError(payload.error)}`);
  const content = Array.isArray(payload.content) ? payload.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") reasoning += block.thinking;
    if (block.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `anthropic_call_${toolCalls.length + 1}`,
        name: block.name,
        arguments: JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}),
      });
    }
  }
  if (!text && !reasoning && !toolCalls.length) throw new AiAdapterError("shape", "Anthropic 的回复里没有文本或工具调用。");
  const usage = anthropicUsage(payload.usage);
  return {
    text,
    toolCalls,
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof payload.stop_reason === "string" ? { finishReason: payload.stop_reason } : {}),
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
  };
}

export function anthropicUsage(raw: unknown): AiUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const prompt = numberOrZero(record.input_tokens);
  const completion = numberOrZero(record.output_tokens);
  if (!prompt && !completion) return undefined;
  // `cache_read_input_tokens` counts input served from the prompt cache;
  // `input_tokens` excludes it, so the two are not double-counted here.
  const cached = numberOrZero(record.cache_read_input_tokens);
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, ...(cached ? { cachedTokens: cached } : {}) };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.type === "string") return record.type;
  }
  return "未知错误";
}

/** One SSE frame from the Messages stream. The `event:` name carries the shape. */
export function parseAnthropicChunk(frame: AiSseFrame, onError?: (problem: AiSseProblem) => void): AiStreamEvent[] {
  if (isDoneFrame(frame)) return [{ type: "done" }];
  const parsed = tryParseSseJson(frame, onError);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") return [];
  const payload = parsed.value as Record<string, unknown>;
  const kind = typeof payload.type === "string" ? payload.type : frame.event;
  const events: AiStreamEvent[] = [];
  switch (kind) {
    case "message_start": {
      const message = payload.message && typeof payload.message === "object" ? (payload.message as Record<string, unknown>) : {};
      const usage = anthropicUsage(message.usage);
      if (usage) events.push({ type: "usage", usage });
      break;
    }
    case "content_block_start": {
      const block = payload.content_block && typeof payload.content_block === "object" ? (payload.content_block as Record<string, unknown>) : null;
      const index = typeof payload.index === "number" ? payload.index : 0;
      if (block?.type === "tool_use" && typeof block.name === "string") {
        events.push({
          type: "tool_call",
          index,
          id: typeof block.id === "string" ? block.id : undefined,
          name: block.name,
        });
      }
      break;
    }
    case "content_block_delta": {
      const delta = payload.delta && typeof payload.delta === "object" ? (payload.delta as Record<string, unknown>) : null;
      const index = typeof payload.index === "number" ? payload.index : 0;
      if (delta?.type === "text_delta" && typeof delta.text === "string") events.push({ type: "text", text: delta.text });
      if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") events.push({ type: "reasoning", text: delta.thinking });
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        events.push({ type: "tool_call", index, arguments: delta.partial_json });
      }
      break;
    }
    case "message_delta": {
      const delta = payload.delta && typeof payload.delta === "object" ? (payload.delta as Record<string, unknown>) : null;
      if (delta && typeof delta.stop_reason === "string" && delta.stop_reason) events.push({ type: "finish", reason: delta.stop_reason });
      const usage = anthropicUsage(payload.usage);
      if (usage) events.push({ type: "usage", usage });
      break;
    }
    case "message_stop":
      events.push({ type: "done" });
      break;
    case "error":
      events.push({ type: "error", message: `Anthropic 返回错误：${describeError(payload.error)}` });
      break;
    default:
      // `ping` and any future event type are ignored rather than fatal.
      break;
  }
  return events;
}