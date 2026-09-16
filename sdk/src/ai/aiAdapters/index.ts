/**
 * The protocol registry: one adapter per wire shape.
 *
 * `chatRuntime` asks this table for a protocol and gets an object with the same
 * four operations it would otherwise branch on. Adding a provider is therefore
 * adding a file and a row -- not editing the chat loop, which is where a
 * protocol-specific branch would eventually be wrong for a request nobody
 * tested.
 */

import type { AiChatReply, AiChatRequest, AiStreamEvent } from "../aiChat";
import type { AiSseFrame, AiSseProblem } from "../aiSse";
import type { AiHttpRequest } from "../aiTransport";
import {
  buildOpenAiChatRequest,
  buildOpenAiEmbeddingRequest,
  openAiHeaders,
  parseOpenAiChunk,
  parseOpenAiEmbeddingReply,
  parseOpenAiReply,
  type AiAdapterAuth,
} from "./openai";
import {
  buildGeminiEmbeddingRequest,
  buildGeminiRequest,
  parseGeminiChunk,
  parseGeminiEmbeddingReply,
  parseGeminiReply,
} from "./gemini";
import { buildAnthropicRequest, parseAnthropicChunk, parseAnthropicReply } from "./anthropic";

export type AiProtocolId = "openai" | "gemini" | "anthropic";

export interface AiEmbeddingBuild {
  model: string;
  input: readonly string[];
  dimensions?: number;
}

export interface AiProtocolAdapter {
  protocol: AiProtocolId;
  build(baseUrl: string, request: AiChatRequest, auth: AiAdapterAuth): AiHttpRequest;
  parseReply(text: string): AiChatReply;
  parseChunk(frame: AiSseFrame, onError?: (problem: AiSseProblem) => void): AiStreamEvent[];
  /** Absent for protocols with no embedding endpoint (Anthropic). */
  buildEmbedding?(baseUrl: string, input: AiEmbeddingBuild, auth: AiAdapterAuth): AiHttpRequest;
  parseEmbeddingReply?(text: string): number[][];
}

/** The adapter for a wire protocol, or null when the host cannot speak it yet. */
export function adapterFor(protocol: string): AiProtocolAdapter | null {
  if (protocol === "openai") {
    return {
      protocol: "openai",
      build: (baseUrl, request, auth) => buildOpenAiChatRequest(baseUrl, request, auth),
      parseReply: parseOpenAiReply,
      parseChunk: parseOpenAiChunk,
      buildEmbedding: (baseUrl, input, auth) => buildOpenAiEmbeddingRequest(baseUrl, input, auth),
      parseEmbeddingReply: parseOpenAiEmbeddingReply,
    };
  }
  if (protocol === "gemini") {
    return {
      protocol: "gemini",
      build: (baseUrl, request, auth) => buildGeminiRequest(baseUrl, request, auth),
      parseReply: parseGeminiReply,
      parseChunk: parseGeminiChunk,
      buildEmbedding: (baseUrl, input, auth) => buildGeminiEmbeddingRequest(baseUrl, input, auth),
      parseEmbeddingReply: parseGeminiEmbeddingReply,
    };
  }
  if (protocol === "anthropic") {
    return {
      protocol: "anthropic",
      build: (baseUrl, request, auth) => buildAnthropicRequest(baseUrl, request, auth),
      parseReply: parseAnthropicReply,
      parseChunk: parseAnthropicChunk,
    };
  }
  return null;
}

export { openAiHeaders, type AiAdapterAuth };