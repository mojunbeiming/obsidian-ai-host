/**
 * Embeddings: settings plus transport become one batch-embed function.
 *
 * The indexer retries this function, so a failure has to carry its HTTP status;
 * a 429 that arrives as a plain "请求失败" would be retried as an unknown error
 * (or worse, not retried at all).
 */

import { adapterFor } from "../sdk/src/ai/aiAdapters/index";
import type { AiTransport } from "../sdk/src/ai/aiTransport";
import type { AiEmbedBatch } from "../sdk/src/ai/aiRag";
import { httpFailureMessage } from "./chatRuntime";
import type { AiRuntimeConfig } from "./providerConfig";
import type { ChatRuntimeStep } from "./chatRuntime";

/** Providers accept large batches; this keeps one request under a sane body size. */
const EMBED_BATCH_SIZE = 64;

export function createEmbeddingClient(
  config: AiRuntimeConfig,
  transport: AiTransport,
  hooks: { onStep?(step: ChatRuntimeStep): void } = {},
): AiEmbedBatch {
  const emit = (step: ChatRuntimeStep): void => {
    try {
      hooks.onStep?.({ ...step, at: step.at ?? Date.now() });
    } catch {
      /* a mirror that throws must not break the batch */
    }
  };
  const adapter = adapterFor(config.protocol);
  if (!adapter?.buildEmbedding || !adapter.parseEmbeddingReply) {
    throw new Error(`${config.label}（${config.protocol}）不提供嵌入接口。`);
  }
  const buildEmbedding = adapter.buildEmbedding.bind(adapter);
  const parseEmbeddingReply = adapter.parseEmbeddingReply.bind(adapter);
  return async (texts, signal) => {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      if (!batch.length) continue;
      emit({ kind: "request", title: `嵌入 ${batch.length} 段`, status: "running", meta: { model: config.model, count: batch.length } });
      const startedAt = Date.now();
      const request = buildEmbedding(config.baseUrl, { model: config.model, input: batch }, {
        apiKey: config.apiKey,
        authHeader: config.authHeader,
        authPrefix: config.authPrefix,
        extraHeaders: config.extraHeaders,
      });
      const response = await transport.send(request, { signal, timeoutMs: config.timeoutMs });
      if (response.status < 200 || response.status >= 300) {
        emit({ kind: "error", level: "error", status: "failed", title: `嵌入 HTTP ${response.status}`, detail: response.text.slice(0, 2000) });
        const error = new Error(httpFailureMessage(response.status, response.text));
        Object.assign(error, { status: response.status, body: response.text });
        throw error;
      }
      const parsed = parseEmbeddingReply(response.text);
      vectors.push(...parsed);
      emit({ kind: "response.raw", title: `嵌入返回 ${parsed.length} 个向量`, status: "ok", meta: { durationMs: Date.now() - startedAt, vectors: parsed.length } });
    }
    return vectors;
  };
}