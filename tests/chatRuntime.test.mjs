/**
 * One assistant turn against a scripted transport.
 *
 * The streaming tests feed bytes one character at a time on purpose: this path
 * has to survive a frame split at every offset, and a test that hands over whole
 * frames would pass even if the parser never buffered anything.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationMessages, httpFailureMessage, runChatTurn } from "../.build/chatRuntime.js";

const CONFIG = {
  providerId: "deepseek",
  label: "DeepSeek",
  protocol: "openai",
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test-model",
  apiKey: "sk-test",
  authHeader: "authorization",
  authPrefix: "Bearer ",
  extraHeaders: {},
  timeoutMs: 5000,
  maxImages: 0,
  stream: false,
  temperature: 0.2,
  needsKey: true,
};

function fakeTransport({ chunks = [], status = 200, reply = null, fail = null } = {}) {
  return {
    async send() {
      if (fail) throw fail;
      return { status, headers: {}, text: typeof reply === "string" ? reply : JSON.stringify(reply) };
    },
    async stream() {
      if (fail) throw fail;
      return {
        status,
        headers: {},
        chunks: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      };
    },
  };
}

test("a non-streamed reply comes back parsed, usage included", async () => {
  const result = await runChatTurn({
    config: CONFIG,
    messages: [{ role: "user", content: "hi" }],
    transport: fakeTransport({
      reply: { choices: [{ message: { content: "你好" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "你好");
  assert.deepEqual(result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal(result.finishReason, "stop");
});

test("a non-2xx reply is a readable failure, not a thrown exception", async () => {
  const result = await runChatTurn({
    config: CONFIG,
    messages: [{ role: "user", content: "hi" }],
    transport: fakeTransport({ status: 401, reply: '{"error":"invalid key sk-secret123456"}' }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("401"));
  assert.equal(result.error.includes("sk-secret123456"), false, "错误正文里的 key 必须脱敏");
});

test("a streamed reply is reassembled even when every chunk is one character", async () => {
  const stream =
    JSON.stringify({ choices: [{ delta: { reasoning_content: "想" }, finish_reason: null }] }).replace(/^/, "data: ") + "\n\n" +
    "data: " + JSON.stringify({ choices: [{ delta: { content: "你" }, finish_reason: null }] }) + "\n\n" +
    "data: " + JSON.stringify({ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }) + "\n\n" +
    "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) + "\n\n" +
    "data: [DONE]\n\n";
  const seen = [];
  const result = await runChatTurn({
    config: { ...CONFIG, stream: true },
    messages: [{ role: "user", content: "hi" }],
    transport: fakeTransport({ chunks: [...stream] }),
    callbacks: { onText: (delta) => seen.push(delta) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "你好");
  assert.equal(result.reasoning, "想");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  assert.deepEqual(seen, ["你", "好"]);
});

test("a malformed frame is recorded, and the stream that follows still succeeds", async () => {
  const chunks = ["data: {oops\n\n", 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"];
  const result = await runChatTurn({
    config: { ...CONFIG, stream: true },
    messages: [{ role: "user", content: "hi" }],
    transport: fakeTransport({ chunks }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "ok");
  assert.equal(result.malformedFrames.length, 1);
});

test("a provider error frame fails the turn with its message", async () => {
  const result = await runChatTurn({
    config: { ...CONFIG, stream: true },
    messages: [{ role: "user", content: "hi" }],
    transport: fakeTransport({ chunks: ['data: {"error":{"message":"quota exhausted"}}\n\n'] }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("quota exhausted"));
});

test("a stream with no usable content is a failure, not an empty success", async () => {
  const result = await runChatTurn({
    config: { ...CONFIG, stream: true },
    messages: [{ role: "user", content: "hi" }],
    transport: fakeTransport({ chunks: ["data: [DONE]\n\n"] }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("没有文本"));
});

test("an aborted request reports cancellation instead of an error banner", async () => {
  const result = await runChatTurn({
    config: CONFIG,
    messages: [{ role: "user", content: "hi" }],
    transport: fakeTransport({ fail: Object.assign(new Error("gone"), { code: "aborted" }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
});

test("a non-2xx stream reads a little of the body to explain itself", async () => {
  const result = await runChatTurn({
    config: { ...CONFIG, stream: true },
    messages: [{ role: "user", content: "hi" }],
    transport: fakeTransport({ status: 429, chunks: ["slow down, please"] }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("429"));
  assert.ok(result.error.includes("slow down"));
});

test("conversation messages are one system turn, trimmed history, then the user turn", () => {
  const history = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
    { role: "assistant", content: "d" },
  ];
  const messages = buildConversationMessages({ systemPrompt: "补充规则", history, userText: "新问题", maxContextMessages: 2 });
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes("补充规则"));
  assert.deepEqual(messages.slice(1).map((message) => message.content), ["c", "d", "新问题"]);
  // Empty input still carries the host system prompt and the trimmed history;
  // it just has no new user turn.
  const noUser = buildConversationMessages({ history, userText: "", maxContextMessages: 20 });
  assert.equal(noUser.length, 5);
  assert.equal(noUser[noUser.length - 1].content, "d");
});

test("HTTP failures name the change that fixes them", () => {
  assert.ok(httpFailureMessage(401, "").includes("API Key"));
  assert.ok(httpFailureMessage(404, "").includes("/v1"));
  assert.ok(httpFailureMessage(429, "").includes("限流"));
  assert.ok(httpFailureMessage(503, "").includes("服务端"));
  const redacted = httpFailureMessage(500, "token=abcdef1234567890 exploded");
  assert.equal(redacted.includes("abcdef1234567890"), false);
});