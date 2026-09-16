/**
 * The Google Gemini protocol: generateContent, streamGenerateContent, embeddings.
 *
 * Three shapes differ from OpenAI in ways that read like different bugs when
 * mixed up: the model is part of the URL, not the body; the assistant role is
 * called `model`; and the API key travels in `x-goog-api-key` (the preset
 * declares that header, so the shared auth resolver needs no special case).
 * Tool results are `functionResponse` parts inside a user turn, and thinking
 * parts are flagged with `thought: true` rather than sent in a separate field.
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
  type AiToolCall,
  type AiToolDefinition,
  type AiUsage,
} from "../aiChat";
import { isDoneFrame, tryParseSseJson, type AiSseFrame, type AiSseProblem } from "../aiSse";
import type { AiHttpRequest } from "../aiTransport";
import { AiAdapterError, openAiHeaders, type AiAdapterAuth } from "./openai";

/** `https:///v1beta/models/<model>:generateContent` (or the SSE variant). */
export function geminiGenerateUrl(baseUrl: string, model: string, stream: boolean): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const suffix = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `${base}/v1beta/models/${encodeURIComponent(model)}:${suffix}`;
}

/** `:batchEmbedContents` for a list, `:embedContent` for exactly one text. */
export function geminiEmbedUrl(baseUrl: string, model: string, count: number): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return `${base}/v1beta/models/${encodeURIComponent(model)}:${count > 1 ? "batchEmbedContents" : "embedContent"}`;
}

export function buildGeminiRequest(
  baseUrl: string,
  request: AiChatRequest,
  auth: AiAdapterAuth,
  options: { stream?: boolean } = {},
): AiHttpRequest {
  const stream = options.stream ?? request.stream === true;
  const body: Record<string, unknown> = { contents: encodeGeminiContents(request.messages) };
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => messageText(message).trim())
    .filter(Boolean)
    .join("\n\n");
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const generationConfig: Record<string, unknown> = {};
  if (typeof request.temperature === "number" && Number.isFinite(request.temperature)) generationConfig.temperature = request.temperature;
  if (typeof request.maxTokens === "number" && request.maxTokens > 0) generationConfig.maxOutputTokens = Math.floor(request.maxTokens);
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map(toGeminiTool) }];
  return {
    url: geminiGenerateUrl(baseUrl, request.model, stream),
    method: "POST",
    headers: openAiHeaders(auth),
    body: JSON.stringify(body),
  };
}

function toGeminiTool(tool: AiToolDefinition): unknown {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Roles are `user`/`model`; tool results are user parts; images are inlineData. */
export function encodeGeminiContents(messages: readonly AiChatMessage[]): unknown[] {
  const out: { role: "user" | "model"; parts: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role: "user" | "model" = message.role === "assistant" ? "model" : "user";
    const parts: unknown[] = [];
    if (message.role === "tool") {
      parts.push({
        functionResponse: { name: message.name || "tool", response: { content: messageText(message) } },
      });
    } else {
      const text = messageText(message);
      if (text.trim()) parts.push({ text });
      for (const image of imagesOf(messageWireContent(message))) {
        parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: parseArguments(call.arguments) } });
      }
    }
    if (!parts.length) continue;
    const last = out[out.length - 1];
    // Consecutive same-role turns merge; Gemini rejects two user turns in a row
    // far more consistently than it accepts them.
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
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

export function parseGeminiReply(text: string): AiChatReply {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AiAdapterError("invalid-json", `端点返回的不是 JSON：${text.trim().slice(0, 200)}`);
  }
  if (!payload || typeof payload !== "object") throw new AiAdapterError("shape", "Gemini 的回复不是一个 JSON 对象。");
  return geminiReplyFromPayload(payload as Record<string, unknown>);
}

export function geminiReplyFromPayload(payload: Record<string, unknown>): AiChatReply {
  if (payload.error) throw new AiAdapterError("provider-error", `Gemini 返回错误：${describeError(payload.error)}`);
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = candidates[0] && typeof candidates[0] === "object" ? (candidates[0] as Record<string, unknown>) : null;
  if (!candidate) {
    const block = payload.promptFeedback && typeof payload.promptFeedback === "object" ? payload.promptFeedback : null;
    const reason = block && typeof (block as Record<string, unknown>).blockReason === "string" ? String((block as Record<string, unknown>).blockReason) : "";
    throw new AiAdapterError("shape", reason ? `Gemini 拒绝了这次请求：${reason}` : "Gemini 的回复里没有候选内容。");
  }
  const parts = geminiParts(candidate);
  const text = parts.filter((part) => part.kind === "text").map((part) => part.text).join("");
  const reasoning = parts.filter((part) => part.kind === "reasoning").map((part) => part.text).join("");
  const toolCalls: AiToolCall[] = parts
    .filter((part): part is { kind: "call"; name: string; args: Record<string, unknown> } => part.kind === "call")
    .map((part, index) => ({ id: `gemini_call_${index + 1}`, name: part.name, arguments: JSON.stringify(part.args ?? {}) }));
  if (!text && !reasoning && !toolCalls.length) throw new AiAdapterError("shape", "Gemini 的回复里没有文本或工具调用。");
  const usage = geminiUsage(payload.usageMetadata);
  return {
    text,
    toolCalls,
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof candidate.finishReason === "string" ? { finishReason: candidate.finishReason } : {}),
    ...(typeof payload.modelVersion === "string" ? { model: payload.modelVersion } : {}),
  };
}

type GeminiPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "call"; name: string; args: Record<string, unknown> };

function geminiParts(candidate: Record<string, unknown>): GeminiPart[] {
  const content = candidate.content && typeof candidate.content === "object" ? (candidate.content as Record<string, unknown>) : null;
  const rawParts = content && Array.isArray(content.parts) ? content.parts : [];
  const out: GeminiPart[] = [];
  for (const raw of rawParts) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    if (typeof part.text === "string" && part.text) out.push({ kind: part.thought === true ? "reasoning" : "text", text: part.text });
    if (part.functionCall && typeof part.functionCall === "object") {
      const call = part.functionCall as Record<string, unknown>;
      if (typeof call.name === "string" && call.name) {
        out.push({ kind: "call", name: call.name, args: call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {} });
      }
    }
  }
  return out;
}

export function geminiUsage(raw: unknown): AiUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const prompt = numberOrZero(record.promptTokenCount);
  const completion = numberOrZero(record.candidatesTokenCount);
  const total = numberOrZero(record.totalTokenCount) || prompt + completion;
  if (!prompt && !completion && !total) return undefined;
  const cached = numberOrZero(record.cachedContentTokenCount);
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total, ...(cached ? { cachedTokens: cached } : {}) };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "";
    const status = typeof record.status === "string" ? record.status : "";
    if (message || status) return message || status;
  }
  return "未知错误";
}

/** One SSE frame from `streamGenerateContent?alt=sse`. */
export function parseGeminiChunk(frame: AiSseFrame, onError?: (problem: AiSseProblem) => void): AiStreamEvent[] {
  if (isDoneFrame(frame)) return [{ type: "done" }];
  const parsed = tryParseSseJson(frame, onError);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") return [];
  const payload = parsed.value as Record<string, unknown>;
  const events: AiStreamEvent[] = [];
  if (payload.error) return [{ type: "error", message: `Gemini 返回错误：${describeError(payload.error)}` }];
  const usage = geminiUsage(payload.usageMetadata);
  if (usage) events.push({ type: "usage", usage });
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = candidates[0] && typeof candidates[0] === "object" ? (candidates[0] as Record<string, unknown>) : null;
  if (candidate) {
    geminiParts(candidate).forEach((part, index) => {
      if (part.kind === "text") events.push({ type: "text", text: part.text });
      else if (part.kind === "reasoning") events.push({ type: "reasoning", text: part.text });
      else events.push({ type: "tool_call", index, name: part.name, arguments: JSON.stringify(part.args ?? {}) });
    });
    if (typeof candidate.finishReason === "string" && candidate.finishReason) {
      events.push({ type: "finish", reason: candidate.finishReason });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface GeminiEmbedInput {
  model: string;
  input: readonly string[];
  dimensions?: number;
}

export function buildGeminiEmbeddingRequest(baseUrl: string, input: GeminiEmbedInput, auth: AiAdapterAuth): AiHttpRequest {
  const common = {
    model: `models/${input.model}`,
    ...(input.dimensions && input.dimensions > 0 ? { outputDimensionality: Math.floor(input.dimensions) } : {}),
  };
  const body =
    input.input.length > 1
      ? { requests: input.input.map((text) => ({ ...common, content: { parts: [{ text }] } })) }
      : { ...common, content: { parts: [{ text: input.input[0] ?? "" }] } };
  return {
    url: geminiEmbedUrl(baseUrl, input.model, input.input.length),
    method: "POST",
    headers: openAiHeaders(auth),
    body: JSON.stringify(body),
  };
}

export function parseGeminiEmbeddingReply(text: string): number[][] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AiAdapterError("invalid-json", `嵌入端点返回的不是 JSON：${text.trim().slice(0, 200)}`);
  }
  if (!payload || typeof payload !== "object") throw new AiAdapterError("shape", "嵌入端点的回复不是一个对象。");
  const record = payload as Record<string, unknown>;
  if (record.error) throw new AiAdapterError("provider-error", `Gemini 嵌入错误：${describeError(record.error)}`);
  const raw = Array.isArray(record.embeddings) ? record.embeddings : record.embedding ? [record.embedding] : [];
  const vectors: number[][] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const values = (item as Record<string, unknown>).values;
    if (!Array.isArray(values)) continue;
    const vector = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (vector.length) vectors.push(vector);
  }
  if (!vectors.length) throw new AiAdapterError("shape", "嵌入端点的回复里没有向量（embedding.values）。");
  return vectors;
}