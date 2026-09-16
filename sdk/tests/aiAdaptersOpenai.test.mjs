/**
 * The OpenAI-protocol adapter: body in, reply out, frame by frame.
 *
 * The assertions that matter are on the *body*, because a malformed body and a
 * perfect one both come back as an error the user cannot tell apart. The
 * DeepSeek reasoning round trip gets its own tests because it is the one case
 * where dropping a field is not cosmetic: the tool loop requires it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AiAdapterError,
  annotationsFrom,
  buildOpenAiChatRequest,
  contentToText,
  encodeOpenAiMessages,
  normalizeToolCalls,
  openAiChatUrl,
  openAiEventsFromPayload,
  openAiHeaders,
  openAiModelsUrl,
  openAiReplyFromPayload,
  parseOpenAiChunk,
  parseOpenAiReply,
  wireModelId,
} from "../.build/ai/aiAdapters/openai.js";
import { apiUrlFor } from "../.build/ai.js";
import { AI_PROVIDERS } from "../.build/aiProviders.js";

function bodyOf(request) {
  return JSON.parse(request.body);
}

test("the chat and models URLs agree with the legacy builder on every openai-shaped preset", () => {
  for (const preset of AI_PROVIDERS) {
    if (!preset.baseUrl || preset.kind !== "openai") continue;
    assert.equal(openAiChatUrl(preset.baseUrl), apiUrlFor(preset.baseUrl, "openai"), preset.id);
    assert.equal(openAiModelsUrl(preset.baseUrl), apiUrlFor(preset.baseUrl, "openai", { models: true }), preset.id);
  }
  assert.equal(openAiChatUrl("https://gateway.example/v1/"), "https://gateway.example/v1/chat/completions");
  assert.equal(openAiChatUrl(""), "");
});

test("wireModelId strips a provider prefix, and only the last one", () => {
  assert.equal(wireModelId("deepseek-official/deepseek-flash"), "deepseek-flash");
  assert.equal(wireModelId("qwen2.5-vl"), "qwen2.5-vl");
  assert.equal(wireModelId("a/b/c"), "c");
});

test("the request merges systems to the front, merges same-role turns, and keeps tool calls distinct", () => {
  const request = buildOpenAiChatRequest(
    "https://api.deepseek.com",
    {
      model: "deepseek/deepseek-chat",
      stream: true,
      temperature: 0.3,
      maxTokens: 100,
      tools: [{ name: "vault.search", description: "查找", parameters: { type: "object" } }],
      messages: [
        { role: "system", content: "规则一" },
        { role: "system", content: "规则二" },
        { role: "user", content: "第一句" },
        { role: "user", content: "第二句" },
        { role: "assistant", content: "", reasoning: "想一下", toolCalls: [{ id: "call_1", name: "vault.search", arguments: '{"q":"x"}' }] },
        { role: "tool", content: "结果", toolCallId: "call_1", name: "vault.search" },
      ],
    },
    { apiKey: "sk-test", authHeader: "authorization", authPrefix: "Bearer ", extraHeaders: { "x-vendor-version": "1" } },
  );
  assert.equal(request.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["x-vendor-version"], "1");
  assert.equal(request.headers["authorization"], "Bearer sk-test");

  const body = bodyOf(request);
  assert.equal(body.model, "deepseek-chat");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 100);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "vault.search");

  assert.deepEqual(body.messages[0], { role: "system", content: "规则一\n\n规则二" });
  assert.deepEqual(body.messages[1], { role: "user", content: "第一句\n\n第二句" });
  const assistant = body.messages[2];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.reasoning_content, "想一下", "DeepSeek 工具循环要求把 reasoning_content 原样发回");
  assert.equal(assistant.tool_calls[0].id, "call_1");
  assert.equal(assistant.tool_calls[0].function.name, "vault.search");
  assert.equal(assistant.tool_calls[0].function.arguments, '{"q":"x"}');
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "call_1", content: "结果" });
});

test("a request with no tools and no stream omits those fields entirely", () => {
  const request = buildOpenAiChatRequest(
    "http://127.0.0.1:11434",
    { model: "qwen2.5-vl", messages: [{ role: "user", content: "hi" }] },
    { authHeader: "", authPrefix: "" },
  );
  const body = bodyOf(request);
  assert.equal("stream" in body, false);
  assert.equal("tools" in body, false);
  assert.equal("temperature" in body, false);
  assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal("authorization" in request.headers, false, "没有鉴权头就不发鉴权头");
});

test("passReasoning: false drops the round-trip field for gateways that reject it", () => {
  const messages = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a", reasoning: "think" },
  ];
  const withReasoning = encodeOpenAiMessages(messages);
  assert.equal(withReasoning[1].reasoning_content, "think");
  const without = encodeOpenAiMessages(messages, { passReasoning: false });
  assert.equal("reasoning_content" in without[1], false);
});

test("images become data URLs, and text-only messages stay plain strings", () => {
  const messages = encodeOpenAiMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", mediaType: "image/png", base64: "QUJD" },
      ],
    },
  ]);
  assert.deepEqual(messages[0].content, [
    { type: "text", text: "看图" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
  const plain = encodeOpenAiMessages([{ role: "user", content: "只有字" }]);
  assert.equal(plain[0].content, "只有字");
});

test("promptContent wins over content, which is the whole point of the pair", () => {
  const messages = encodeOpenAiMessages([{ role: "user", content: "@笔记名", promptContent: "笔记的正文" }]);
  assert.equal(messages[0].content, "笔记的正文");
});

test("a non-streamed reply is parsed into text, reasoning, tools, usage and citations", () => {
  const reply = parseOpenAiReply(
    JSON.stringify({
      model: "deepseek-flash",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "答案",
            reasoning_content: "推理过程",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "vault.search", arguments: '{"q":"x"}' } },
              { id: "c2", type: "other", function: { name: "not-a-function" } },
            ],
            annotations: [
              { type: "url_citation", url_citation: { url: "https://example.com/a", title: "A", start_index: 0, end_index: 3 } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      citations: ["https://example.com/b"],
    }),
  );
  assert.equal(reply.text, "答案");
  assert.equal(reply.reasoning, "推理过程");
  assert.equal(reply.model, "deepseek-flash");
  assert.equal(reply.finishReason, "stop");
  assert.deepEqual(reply.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.equal(reply.toolCalls.length, 1, "非 function 类型的 tool_call 必须被丢掉");
  assert.equal(reply.toolCalls[0].id, "c1");
  assert.deepEqual(reply.annotations.map((entry) => entry.url), ["https://example.com/a", "https://example.com/b"]);
});

test("tool calls tolerate an omitted type and a missing id, but not a missing name", () => {
  const calls = normalizeToolCalls([
    { function: { name: "a", arguments: { q: 1 } } },
    { id: "x", type: "function", function: { name: "b", arguments: '{"q":2}' } },
    { id: "y", type: "function", function: { arguments: "{}" } },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, "tool_call_1", "缺 id 时给一个可关联的合成 id");
  assert.equal(calls[0].arguments, '{"q":1}', "对象形式的 arguments 要序列化回字符串");
  assert.equal(calls[1].arguments, '{"q":2}');
});

test("content parts are joined, and a reply with nothing usable is a shape error", () => {
  assert.equal(contentToText([{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }]), "ab");
  assert.throws(() => parseOpenAiReply(JSON.stringify({ choices: [{}] })), (error) => error instanceof AiAdapterError && error.kind === "shape");
  assert.throws(() => parseOpenAiReply("not json"), (error) => error.kind === "invalid-json");
  assert.throws(
    () => parseOpenAiReply(JSON.stringify({ error: { message: "insufficient balance" } })),
    (error) => error.kind === "provider-error" && error.message.includes("insufficient balance"),
  );
});

test("stream frames become normalized events, including usage and finish reasons", () => {
  const frame = {
    event: "message",
    id: "",
    data: JSON.stringify({
      choices: [
        {
          delta: {
            content: "He",
            reasoning_content: "why",
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "vault.search" } },
              { index: 0, function: { arguments: '{"q"' } },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  };
  const events = parseOpenAiChunk(frame);
  assert.deepEqual(events, [
    { type: "usage", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
    { type: "text", text: "He" },
    { type: "reasoning", text: "why" },
    { type: "tool_call", index: 0, id: "call_1", name: "vault.search" },
    { type: "tool_call", index: 0, arguments: '{"q"' },
  ]);

  const finished = parseOpenAiChunk({ event: "message", id: "", data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) });
  assert.deepEqual(finished, [{ type: "finish", reason: "tool_calls" }]);
  assert.deepEqual(parseOpenAiChunk({ event: "message", id: "", data: "[DONE]" }), [{ type: "done" }]);
});

test("a malformed stream frame is reported and skipped", () => {
  const problems = [];
  const events = parseOpenAiChunk({ event: "message", id: "", data: "{broken" }, (problem) => problems.push(problem));
  assert.deepEqual(events, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, "json");
});

test("a streamed provider error becomes an error event instead of an empty answer", () => {
  const events = parseOpenAiChunk({ event: "message", id: "", data: JSON.stringify({ error: { message: "rate limited", code: "429" } }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.ok(events[0].message.includes("rate limited"));
});

test("annotations from citations and url_citation are normalized once", () => {
  const annotation = annotationsFrom(
    { annotations: [{ type: "url_citation", url_citation: { url: "https://a" } }] },
    { citations: ["https://a", "https://b"] },
  );
  assert.deepEqual(annotation.annotations.map((entry) => entry.url), ["https://a", "https://b"]);
});

test("openAiHeaders attaches nothing without a header name, and uses the caller's pair verbatim", () => {
  assert.deepEqual(openAiHeaders({ apiKey: "k" }), { "content-type": "application/json" });
  assert.deepEqual(openAiHeaders({ apiKey: "k", authHeader: "x-api-key", authPrefix: "" }), {
    "content-type": "application/json",
    "x-api-key": "k",
  });
});