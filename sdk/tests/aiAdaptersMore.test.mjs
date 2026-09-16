/**
 * The Gemini and Anthropic adapters, plus the protocol registry.
 *
 * Each protocol's traps get one assertion each: the model lives in Gemini's URL,
 * Anthropic's `system` is top-level, tool results are user blocks there and
 * functionResponse parts here, and thinking arrives under two different names.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { adapterFor } from "../.build/ai/aiAdapters/index.js";
import {
  anthropicMessagesUrl,
  anthropicReplyFromPayload,
  buildAnthropicRequest,
  encodeAnthropicMessages,
  parseAnthropicChunk,
  parseAnthropicReply,
} from "../.build/ai/aiAdapters/anthropic.js";
import { AiAdapterError } from "../.build/ai/aiAdapters/openai.js";
import {
  buildGeminiEmbeddingRequest,
  buildGeminiRequest,
  encodeGeminiContents,
  geminiEmbedUrl,
  geminiGenerateUrl,
  parseGeminiChunk,
  parseGeminiEmbeddingReply,
  parseGeminiReply,
} from "../.build/ai/aiAdapters/gemini.js";

const AUTH = { apiKey: "sk-test", authHeader: "x-goog-api-key", authPrefix: "", extraHeaders: {} };

function bodyOf(request) {
  return JSON.parse(request.body);
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

test("Gemini puts the model in the URL, not the body", () => {
  assert.equal(geminiGenerateUrl("https://generativelanguage.googleapis.com", "gemini-2.0-flash", false), "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
  assert.equal(geminiGenerateUrl("https://generativelanguage.googleapis.com", "gemini-2.0-flash", true), "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse");
  const request = buildGeminiRequest("https://generativelanguage.googleapis.com", { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], stream: true }, AUTH);
  assert.ok(request.url.includes("streamGenerateContent?alt=sse"));
  assert.equal("model" in bodyOf(request), false);
  assert.equal(request.headers["x-goog-api-key"], "sk-test");
});

test("Gemini maps roles, images and system instructions correctly", () => {
  const body = bodyOf(
    buildGeminiRequest(
      "https://generativelanguage.googleapis.com",
      {
        model: "m",
        messages: [
          { role: "system", content: "规则" },
          { role: "user", content: "看图" },
          { role: "user", content: [{ type: "image", mediaType: "image/png", base64: "QUJD" }] },
          { role: "assistant", content: "看到了", toolCalls: [{ id: "gemini_call_1", name: "vault.search", arguments: '{"q":"x"}' }] },
          { role: "tool", content: "结果", name: "vault.search", toolCallId: "gemini_call_1" },
        ],
      },
      AUTH,
    ),
  );
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "规则" }] });
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.contents[0].parts[0].text, "看图");
  assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: "QUJD" } });
  assert.equal(body.contents[1].role, "model");
  assert.deepEqual(body.contents[1].parts[0], { text: "看到了" });
  assert.deepEqual(body.contents[1].parts[1], { functionCall: { name: "vault.search", args: { q: "x" } } });
  assert.equal(body.contents[2].role, "user");
  assert.equal(body.contents[2].parts[0].functionResponse.name, "vault.search");
});

test("encoding consecutive same-role turns merges them", () => {
  const contents = encodeGeminiContents([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  assert.equal(contents.length, 2);
  assert.deepEqual(contents[0].parts.map((part) => part.text), ["a", "b"]);
});

test("a Gemini reply becomes text, reasoning, tool calls and usage", () => {
  const reply = parseGeminiReply(
    JSON.stringify({
      modelVersion: "gemini-2.0-flash",
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "思考中", thought: true },
              { text: "答案是 42" },
              { functionCall: { name: "vault.search", args: { q: "x" } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    }),
  );
  assert.equal(reply.text, "答案是 42");
  assert.equal(reply.reasoning, "思考中");
  assert.equal(reply.toolCalls[0].name, "vault.search");
  assert.equal(reply.toolCalls[0].id, "gemini_call_1");
  assert.deepEqual(reply.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7 });
  assert.equal(reply.finishReason, "STOP");
  assert.equal(reply.model, "gemini-2.0-flash");
});

test("Gemini stream frames become the shared events", () => {
  const events = parseGeminiChunk({
    event: "message",
    id: "",
    data: JSON.stringify({
      candidates: [{ content: { parts: [{ text: "你" }, { text: "想", thought: true }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    }),
  });
  assert.deepEqual(events, [
    { type: "usage", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
    { type: "text", text: "你" },
    { type: "reasoning", text: "想" },
    { type: "finish", reason: "STOP" },
  ]);
  assert.deepEqual(parseGeminiChunk({ event: "message", id: "", data: "[DONE]" }), [{ type: "done" }]);
});

test("Gemini embeddings use batchEmbedContents for a list and embedContent for one", () => {
  assert.equal(geminiEmbedUrl("https://generativelanguage.googleapis.com", "m", 1), "https://generativelanguage.googleapis.com/v1beta/models/m:embedContent");
  assert.equal(geminiEmbedUrl("https://generativelanguage.googleapis.com", "m", 2), "https://generativelanguage.googleapis.com/v1beta/models/m:batchEmbedContents");
  const batch = bodyOf(
    buildGeminiEmbeddingRequest(
      "https://generativelanguage.googleapis.com",
      { model: "m", input: ["a", "b"], dimensions: 256 },
      AUTH,
    ),
  );
  assert.equal(batch.requests.length, 2);
  assert.equal(batch.requests[0].model, "models/m");
  assert.equal(batch.requests[0].outputDimensionality, 256);
  assert.deepEqual(parseGeminiEmbeddingReply(JSON.stringify({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] })), [
    [1, 2],
    [3, 4],
  ]);
  assert.deepEqual(parseGeminiEmbeddingReply(JSON.stringify({ embedding: { values: [5, 6] } })), [[5, 6]]);
});

test("Gemini errors and empty candidates are typed failures", () => {
  assert.throws(() => parseGeminiReply(JSON.stringify({ error: { message: "quota" } })), (error) => error.name === "AiAdapterError" && error.kind === "provider-error");
  assert.throws(() => parseGeminiReply(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })), /SAFETY/);
  assert.throws(() => parseGeminiReply("nope"), (error) => error.kind === "invalid-json");
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

test("Anthropic lifts system out and requires max_tokens", () => {
  assert.equal(anthropicMessagesUrl("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  assert.equal(anthropicMessagesUrl("https://api.deepseek.com/anthropic"), "https://api.deepseek.com/anthropic/v1/messages");
  const request = buildAnthropicRequest(
    "https://api.anthropic.com",
    { model: "claude", messages: [{ role: "system", content: "规则" }, { role: "user", content: "hi" }] },
    { apiKey: "k", authHeader: "x-api-key", authPrefix: "", extraHeaders: { "anthropic-version": "2023-06-01" } },
  );
  const body = bodyOf(request);
  assert.equal(body.system, "规则");
  assert.ok(body.max_tokens > 0);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
});

test("Anthropic tool results become tool_result blocks in a user turn", () => {
  const messages = encodeAnthropicMessages([
    { role: "user", content: "查一下" },
    { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "vault.search", arguments: '{"q":"x"}' }] },
    { role: "tool", content: "结果", toolCallId: "toolu_1", name: "vault.search" },
  ]);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content[0].type, "tool_use");
  assert.equal(messages[2].role, "user");
  assert.deepEqual(messages[2].content[0], { type: "tool_result", tool_use_id: "toolu_1", content: "结果" });
});

test("Anthropic replies parse text, thinking, tool_use and usage", () => {
  const reply = parseAnthropicReply(
    JSON.stringify({
      model: "claude-3-5-haiku",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "先查" },
        { type: "text", text: "我查一下。" },
        { type: "tool_use", id: "toolu_1", name: "vault.search", input: { q: "x" } },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    }),
  );
  assert.equal(reply.text, "我查一下。");
  assert.equal(reply.reasoning, "先查");
  assert.equal(reply.toolCalls[0].id, "toolu_1");
  assert.deepEqual(reply.usage, { promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  assert.equal(reply.finishReason, "tool_use");
});

test("Anthropic stream events cover start, deltas, stop and error", () => {
  const events = [
    ...parseAnthropicChunk({ event: "message_start", id: "", data: JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }) }),
    ...parseAnthropicChunk({ event: "content_block_start", id: "", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "vault.search" } }) }),
    ...parseAnthropicChunk({ event: "content_block_delta", id: "", data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } }) }),
    ...parseAnthropicChunk({ event: "content_block_delta", id: "", data: JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "想" } }) }),
    ...parseAnthropicChunk({ event: "content_block_delta", id: "", data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q"' } }) }),
    ...parseAnthropicChunk({ event: "message_delta", id: "", data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }) }),
    ...parseAnthropicChunk({ event: "message_stop", id: "", data: JSON.stringify({ type: "message_stop" }) }),
  ];
  assert.deepEqual(events[0], { type: "usage", usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 } });
  assert.deepEqual(events.find((event) => event.type === "tool_call" && event.name), { type: "tool_call", index: 0, id: "toolu_1", name: "vault.search" });
  assert.ok(events.some((event) => event.type === "text" && event.text === "你"));
  assert.ok(events.some((event) => event.type === "reasoning" && event.text === "想"));
  assert.ok(events.some((event) => event.type === "tool_call" && event.arguments === '{"q"'));
  assert.ok(events.some((event) => event.type === "finish" && event.reason === "end_turn"));
  assert.deepEqual(events[events.length - 1], { type: "done" });

  const error = parseAnthropicChunk({ event: "error", id: "", data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }) });
  assert.equal(error[0].type, "error");
  assert.ok(error[0].message.includes("busy"));
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("the registry resolves the three protocols and refuses the rest", () => {
  assert.equal(adapterFor("openai").protocol, "openai");
  assert.equal(adapterFor("gemini").protocol, "gemini");
  assert.equal(adapterFor("anthropic").protocol, "anthropic");
  assert.equal(adapterFor("dsh"), null);
  assert.equal(adapterFor("mystery"), null);
  assert.ok(adapterFor("openai").buildEmbedding);
  assert.ok(adapterFor("gemini").buildEmbedding);
  assert.equal(adapterFor("anthropic").buildEmbedding, undefined);
  assert.ok(adapterFor("gemini").parseEmbeddingReply(JSON.stringify({ embedding: { values: [1] } })).length === 1);
});

test("Anthropic replies can also be parsed from a payload object", () => {
  const reply = anthropicReplyFromPayload({ content: [{ type: "text", text: "hi" }] });
  assert.equal(reply.text, "hi");
  assert.equal(reply.toolCalls.length, 0);
});