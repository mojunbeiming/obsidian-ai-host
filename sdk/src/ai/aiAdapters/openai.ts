/**
 * The OpenAI-compatible protocol: request bodies, reply parsing, stream events.
 *
 * ## What "OpenAI-compatible" covers here
 *
 * Ollama, LM Studio, vLLM, DeepSeek, and most gateways speak
 * `POST {base}/v1/chat/completions`. The differences that matter are small and
 * additive: DeepSeek returns `reasoning_content` and expects it sent back on the
 * next turn of a tool loop; some servers omit `tool_calls[].type`; some send
 * usage only when asked via `stream_options.include_usage`. This adapter owns
 * all of those, in one pure function each.
 *
 * ## Why functions and not a class
 *
 * The request is a value, the reply is a value, and a frame becomes a list of
 * events. None of that needs an instance, and a class would tempt a caller into
 * keeping state across requests -- which is exactly how a reasoning field from
 * turn one leaks into turn two for a different model. The stream *event*
 * merging that does need state (tool-call deltas by index) lives in `aiTools.ts`
 * where the loop that consumes it can own it.
 *
 * ## Credentials
 *
 * The key arrives in `config` and leaves in a header the *caller* named; this
 * file never spells a header name of its own. That is what lets the same
 * builder serve `x-api-key` and a custom `X-Api-Token` without a branch, and it
 * is why the word for the default header appears only in `aiProviders.ts` as
 * table data.
 *
 * Pure: no socket, no clock, no globals.
 */

import {
  imagesOf,
  messageText,
  messageWireContent,
  type AiAnnotation,
  type AiChatMessage,
  type AiStreamEvent,
  type AiChatReply,
  type AiChatRequest,
  type AiContentPart,
  type AiToolCall,
  type AiToolDefinition,
  type AiUsage,
} from "../aiChat";
import { type AiSseFrame, isDoneFrame, type AiSseProblem, tryParseSseJson } from "../aiSse";
import type { AiHttpRequest } from "../aiTransport";

/** The auth fields an adapter needs. Values already resolved from a provider row. */
export interface AiAdapterAuth {
  apiKey?: string;
  /** Empty means the provider sends no credential. */
  authHeader?: string;
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
}

/** A response body that is not the shape the adapter promised. */
export class AiAdapterError extends Error {
  readonly kind: "invalid-json" | "provider-error" | "shape";

  constructor(kind: "invalid-json" | "provider-error" | "shape", message: string) {
    super(message);
    this.name = "AiAdapterError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * The chat-completions URL for a base address.
 *
 * The rule mirrors `apiUrlFor()` in `ai.ts`: a base that already ends in `/v1`
 * is used as-is (OpenAI's own documented base), and anything else gets one
 * `/v1` added (DeepSeek's documented base is the bare host, and the naive
 * concatenation produced a 404 there). Two copies exist while the old core
 * still ships; a test asserts they agree on every preset address.
 */
export function openAiChatUrl(baseUrl: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** The models probe URL, following the same rule. */
export function openAiModelsUrl(baseUrl: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/** The model id to send, with any `provider/` prefix stripped. Matches `openAiModelId`. */
export function wireModelId(model: string): string {
  const at = model.lastIndexOf("/");
  return at < 0 ? model : model.slice(at + 1);
}

/** Headers: JSON, the provider's own required ones, then the credential last. */
export function openAiHeaders(auth: AiAdapterAuth): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(auth.extraHeaders ?? {}) };
  const key = typeof auth.apiKey === "string" ? auth.apiKey.trim() : "";
  const header = typeof auth.authHeader === "string" ? auth.authHeader.trim() : "";
  const prefix = typeof auth.authPrefix === "string" ? auth.authPrefix : "";
  if (key && header) headers[header] = `${prefix}${key}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface OpenAiBuildOptions {
  /**
   * Send `reasoning_content` back on assistant turns.
   *
   * Defaults to true, and only a message that actually carries `reasoning` is
   * affected: a provider that never returned the field never sees it. DeepSeek's
   * tool loop requires the field on the assistant message that requested the
   * tool, and dropping it turns the next turn into a 400 or a model that
   * re-reasons from scratch -- which is why the round trip is tested rather
   * than assumed.
   */
  passReasoning?: boolean;
}

/** Build one chat-completions request. `request.stream` decides the stream flags. */
export function buildOpenAiChatRequest(
  baseUrl: string,
  request: AiChatRequest,
  auth: AiAdapterAuth,
  options: OpenAiBuildOptions = {},
): AiHttpRequest {
  const stream = request.stream === true;
  const body: Record<string, unknown> = {
    model: wireModelId(request.model),
    messages: encodeOpenAiMessages(request.messages, { passReasoning: options.passReasoning !== false }),
  };
  if (stream) {
    body.stream = true;
    // Without this, OpenAI-shaped streams send no usage at all, and a turn that
    // cannot say what it cost is a turn the trace has to label "unknown".
    body.stream_options = { include_usage: true };
  }
  if (typeof request.temperature === "number" && Number.isFinite(request.temperature)) {
    body.temperature = request.temperature;
  }
  if (typeof request.maxTokens === "number" && Number.isFinite(request.maxTokens) && request.maxTokens > 0) {
    body.max_tokens = Math.floor(request.maxTokens);
  }
  if (request.tools?.length) {
    body.tools = request.tools.map(toOpenAiTool);
    body.tool_choice = request.toolChoice ?? "auto";
  }
  return {
    url: openAiChatUrl(baseUrl),
    method: "POST",
    headers: openAiHeaders(auth),
    body: JSON.stringify(body),
  };
}

function toOpenAiTool(tool: AiToolDefinition): unknown {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

/**
 * Messages in the order the wire wants them.
 *
 * Two normalizations the reference implementation also had to do, because
 * gateways differ:
 *
 * * **System turns collapse into one leading message.** OpenAI accepts several;
 *   a stricter gateway rejects a system message after a user turn, and merging
 *   costs nothing.
 * * **Consecutive same-role turns merge.** A tool loop produces assistant
 *   fragments and user follow-ups that some gateways reject when adjacent.
 *   Assistant turns carrying tool calls are the exception: merging them would
 *   have to renumber call ids, and a wrong id is a 400 that names the field
 *   rather than the merge.
 */
export function encodeOpenAiMessages(
  messages: readonly AiChatMessage[],
  options: { passReasoning?: boolean } = {},
): unknown[] {
  const out: Record<string, unknown>[] = [];
  const systemTexts: string[] = [];
  const ordered: AiChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = messageText(message).trim();
      if (text) systemTexts.push(text);
      continue;
    }
    ordered.push(message);
  }
  if (systemTexts.length) out.push({ role: "system", content: systemTexts.join("\n\n") });

  for (const message of ordered) {
    const previous = out[out.length - 1];
    const mergeable =
      previous &&
      previous.role === message.role &&
      (message.role === "user" || message.role === "assistant") &&
      !message.toolCalls?.length &&
      !Array.isArray(previous.tool_calls);
    if (mergeable) {
      previous.content = mergeContent(previous.content, encodeContent(message));
      continue;
    }
    out.push(encodeOpenAiMessage(message, options));
  }
  return out;
}

function encodeOpenAiMessage(message: AiChatMessage, options: { passReasoning?: boolean }): Record<string, unknown> {
  const content = encodeContent(message);
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: messageText(message) };
  }
  const entry: Record<string, unknown> = { role: message.role, content };
  if (message.role === "assistant" && message.toolCalls?.length) {
    entry.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments ?? "{}" },
    }));
  }
  if (message.role === "assistant" && options.passReasoning !== false && typeof message.reasoning === "string" && message.reasoning) {
    entry.reasoning_content = message.reasoning;
  }
  return entry;
}

/** A message as string content, or as content parts when it carries images. */
function encodeContent(message: AiChatMessage): unknown {
  const wire = messageWireContent(message);
  const images = imagesOf(wire);
  if (!images.length) return messageText(message);
  const parts: unknown[] = [];
  const text = messageText(message);
  if (text) parts.push({ type: "text", text });
  for (const image of images) {
    parts.push({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } });
  }
  return parts;
}

function mergeContent(base: unknown, next: unknown): unknown {
  if (typeof base === "string" && typeof next === "string") return `${base}${base && next ? "\n\n" : ""}${next}`;
  const baseParts = Array.isArray(base) ? base : typeof base === "string" && base ? [{ type: "text", text: base }] : [];
  const nextParts = Array.isArray(next) ? next : typeof next === "string" && next ? [{ type: "text", text: next }] : [];
  return [...baseParts, ...nextParts];
}

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

/** Parse a non-streamed chat-completions body. Throws `AiAdapterError` for a bad shape. */
export function parseOpenAiReply(text: string): AiChatReply {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AiAdapterError("invalid-json", `端点返回的不是 JSON：${text.trim().slice(0, 200)}`);
  }
  return openAiReplyFromPayload(payload);
}

/** The same parsing, for a caller that already has the payload object. */
export function openAiReplyFromPayload(payload: unknown): AiChatReply {
  if (!payload || typeof payload !== "object") {
    throw new AiAdapterError("shape", "端点的回复不是一个 JSON 对象。");
  }
  const record = payload as Record<string, unknown>;
  if (record.error) {
    throw new AiAdapterError("provider-error", describeProviderError(record.error));
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  const textValue = contentToText(message.content);
  const reasoning = firstString(message.reasoning_content, message.reasoning);
  const toolCalls = normalizeToolCalls(message.tool_calls);
  if (!textValue && !toolCalls.length && !reasoning) {
    throw new AiAdapterError("shape", "端点的回复里没有找到文本内容或工具调用（choices[0].message）。");
  }
  const usage = parseUsage(record.usage);
  return {
    text: textValue,
    toolCalls,
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof first.finish_reason === "string" ? { finishReason: first.finish_reason } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(annotationsFrom(message, record) ?? {}),
  };
}

/** `content` as a string, joining text parts; non-text parts are ignored. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : null))
    .filter((part): part is string => typeof part === "string")
    .join("");
}

/**
 * Tool calls in the normalized `AiToolCall` shape.
 *
 * `type` is checked when present but not required: most servers send
 * `type: "function"`, a few compatible ones omit it, and refusing the omitted
 * form is refusing a gateway for spelling. A missing id gets a stable synthetic
 * one so the tool loop can still correlate its tool message -- a call without an
 * id cannot be answered, and "cannot be answered" is worse than "answered under
 * a name we made up".
 */
export function normalizeToolCalls(raw: unknown): AiToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: AiToolCall[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (record.type !== undefined && record.type !== "function") return;
    const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : record;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) return;
    const argsValue = fn.arguments;
    const args =
      typeof argsValue === "string"
        ? argsValue
        : argsValue === undefined || argsValue === null
          ? "{}"
          : JSON.stringify(argsValue);
    out.push({
      id: typeof record.id === "string" && record.id ? record.id : `tool_call_${index + 1}`,
      name,
      arguments: args,
    });
  });
  return out;
}

function parseUsage(raw: unknown): AiUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const prompt = numberOrZero(record.prompt_tokens);
  const completion = numberOrZero(record.completion_tokens);
  const total = numberOrZero(record.total_tokens) || prompt + completion;
  if (!prompt && !completion && !total) return undefined;
  // DeepSeek reports `prompt_cache_hit_tokens`; OpenAI nests it under
  // `prompt_tokens_details.cached_tokens`. Both answer "how much of the input
  // came from cache", which is the only thing the stats bar asks.
  const details =
    record.prompt_tokens_details && typeof record.prompt_tokens_details === "object"
      ? (record.prompt_tokens_details as Record<string, unknown>)
      : {};
  const cached = numberOrZero(record.prompt_cache_hit_tokens) || numberOrZero(details.cached_tokens);
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total, ...(cached ? { cachedTokens: cached } : {}) };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * URL citations, from whichever field the provider uses.
 *
 * OpenAI puts `url_citation` entries in `message.annotations`; Perplexity puts
 * bare URLs in a top-level `citations` array. Both are normalized to the same
 * shape so the UI has one thing to render -- and so a future provider adds a
 * source instead of a list of sources plus a special case.
 */
export function annotationsFrom(message: Record<string, unknown>, payload: Record<string, unknown>): { annotations: AiAnnotation[] } | null {
  const out: AiAnnotation[] = [];
  if (Array.isArray(message.annotations)) {
    for (const item of message.annotations) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (record.type !== "url_citation") continue;
      const citation = record.url_citation && typeof record.url_citation === "object" ? (record.url_citation as Record<string, unknown>) : record;
      const url = typeof citation.url === "string" ? citation.url : "";
      if (!url) continue;
      out.push({
        type: "url_citation",
        url,
        ...(typeof citation.title === "string" ? { title: citation.title } : {}),
        ...(typeof citation.start_index === "number" ? { startIndex: citation.start_index } : {}),
        ...(typeof citation.end_index === "number" ? { endIndex: citation.end_index } : {}),
      });
    }
  }
  if (Array.isArray(payload.citations)) {
    for (const url of payload.citations) {
      if (typeof url === "string" && url && !out.some((entry) => entry.url === url)) {
        out.push({ type: "url_citation", url });
      }
    }
  }
  return out.length ? { annotations: out } : null;
}

function describeProviderError(error: unknown): string {
  if (typeof error === "string") return `服务端返回错误：${error}`;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "";
    const code = typeof record.code === "string" ? record.code : "";
    if (message || code) return `服务端返回错误：${message || code}`;
  }
  return "服务端返回了一个错误对象。";
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

// `AiStreamEvent` is shared by every protocol adapter and re-exported below.

/**
 * Turn one SSE frame into zero or more events.
 *
 * A malformed frame reports through `onError` and yields nothing: the stream
 * often recovers, and killing a response over a keep-alive line that happened to
 * start with `data:` is the failure this signature exists to avoid. `[DONE]` is
 * its own event so the consumer can close the loop without string comparisons
 * scattered through it.
 */
export function parseOpenAiChunk(frame: AiSseFrame, onError?: (problem: AiSseProblem) => void): AiStreamEvent[] {
  if (isDoneFrame(frame)) return [{ type: "done" }];
  const parsed = tryParseSseJson(frame, onError);
  if (!parsed.ok) return [];
  const payload = parsed.value;
  if (!payload || typeof payload !== "object") return [];
  return openAiEventsFromPayload(payload as Record<string, unknown>);
}

/** The payload half of `parseOpenAiChunk`, for a caller that already parsed JSON. */
export function openAiEventsFromPayload(payload: Record<string, unknown>): AiStreamEvent[] {
  const events: AiStreamEvent[] = [];
  if (payload.error) {
    events.push({ type: "error", message: describeProviderError(payload.error) });
    return events;
  }
  const usage = parseUsage(payload.usage);
  if (usage) events.push({ type: "usage", usage });
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : null;
  if (!choice) return events;
  const delta = choice.delta && typeof choice.delta === "object" ? (choice.delta as Record<string, unknown>) : choice.message && typeof choice.message === "object" ? (choice.message as Record<string, unknown>) : {};
  const text = contentToText(delta.content);
  if (text) events.push({ type: "text", text });
  const reasoning = firstString(delta.reasoning_content, delta.reasoning);
  if (reasoning) events.push({ type: "reasoning", text: reasoning });
  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls.forEach((item, fallbackIndex) => {
      if (!item || typeof item !== "object") return;
      const record = item as Record<string, unknown>;
      if (record.type !== undefined && record.type !== "function") return;
      const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : {};
      const index = typeof record.index === "number" && Number.isFinite(record.index) ? record.index : fallbackIndex;
      const event: Extract<AiStreamEvent, { type: "tool_call" }> = { type: "tool_call", index };
      if (typeof record.id === "string" && record.id) event.id = record.id;
      if (typeof fn.name === "string" && fn.name) event.name = fn.name;
      if (typeof fn.arguments === "string" && fn.arguments) event.arguments = fn.arguments;
      events.push(event);
    });
  }
  if (typeof choice.finish_reason === "string" && choice.finish_reason) {
    events.push({ type: "finish", reason: choice.finish_reason });
  }
  const annotations = annotationsFrom(delta, payload);
  if (annotations) {
    for (const annotation of annotations.annotations) events.push({ type: "annotation", annotation });
  }
  return events;
}

/** Re-exported so a caller needs one import for the whole stream pipeline. */
export type { AiContentPart, AiSseFrame, AiStreamEvent };
// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/** The embeddings path, following the same `/v1` rule as chat completions. */
export function openAiEmbeddingsUrl(baseUrl: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/v1$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
}

export interface OpenAiEmbeddingInput {
  model: string;
  input: readonly string[];
  /** Optional truncation, for models that support it (text-embedding-3-*). */
  dimensions?: number;
}

export function buildOpenAiEmbeddingRequest(baseUrl: string, input: OpenAiEmbeddingInput, auth: AiAdapterAuth): AiHttpRequest {
  const body: Record<string, unknown> = {
    model: wireModelId(input.model),
    input: input.input.length === 1 ? input.input[0] : [...input.input],
  };
  if (input.dimensions && input.dimensions > 0) body.dimensions = Math.floor(input.dimensions);
  return {
    url: openAiEmbeddingsUrl(baseUrl),
    method: "POST",
    headers: openAiHeaders(auth),
    body: JSON.stringify(body),
  };
}

/**
 * `data[].embedding`, ordered by `index`.
 *
 * Some gateways return the list out of order when the request was batched; a
 * vector assigned to the wrong chunk is a retrieval bug that only shows up as
 * "the answer cites the wrong note", so the order is restored here.
 */
export function parseOpenAiEmbeddingReply(text: string): number[][] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AiAdapterError("invalid-json", `嵌入端点返回的不是 JSON：${text.trim().slice(0, 200)}`);
  }
  if (!payload || typeof payload !== "object") throw new AiAdapterError("shape", "嵌入端点的回复不是一个对象。");
  const record = payload as Record<string, unknown>;
  if (record.error) throw new AiAdapterError("provider-error", `嵌入错误：${describeProviderError(record.error)}`);
  const data = Array.isArray(record.data) ? record.data : [];
  const ordered = data
    .map((item, fallback) => {
      const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const vector = Array.isArray(entry.embedding) ? entry.embedding.filter((value): value is number => typeof value === "number" && Number.isFinite(value)) : [];
      return { index: typeof entry.index === "number" ? entry.index : fallback, vector };
    })
    .filter((entry) => entry.vector.length > 0)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.vector);
  if (!ordered.length) throw new AiAdapterError("shape", "嵌入端点的回复里没有向量（data[].embedding）。");
  return ordered;
}