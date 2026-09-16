/**
 * The tool loop: merge, approvals, limits, and the no-write guarantee.
 *
 * The property that matters most: a tool that is not `readOnly` never executes
 * automatically, even when the conversation allowed it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executeApprovedTool,
  mergeToolCallDeltas,
  parseToolArguments,
  runToolLoop,
  toolResultMessages,
} from "../.build/ai/aiTools.js";

function tool(name, options = {}) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object" },
    readOnly: options.readOnly ?? true,
    execute: options.execute ?? (async () => `${name} result`),
  };
}

function call(id, name, args = "{}") {
  return { id, name, arguments: args };
}

test("streamed tool-call deltas merge by index", () => {
  const merged = mergeToolCallDeltas([
    { type: "tool_call", index: 0, id: "call_1", name: "vault.search" },
    { type: "tool_call", index: 0, arguments: '{"q"' },
    { type: "tool_call", index: 0, arguments: ':"x"}' },
    { type: "tool_call", index: 1, name: "vault.read" },
    { type: "tool_call", index: 1, arguments: "{}" },
  ]);
  assert.deepEqual(merged, [
    { id: "call_1", name: "vault.search", arguments: '{"q":"x"}' },
    { id: "tool_call_2", name: "vault.read", arguments: "{}" },
  ]);
});

test("arguments that are not a JSON object become an explicit message", () => {
  assert.deepEqual(parseToolArguments(call("c", "t", '{"a":1}')), { ok: true, args: { a: 1 } });
  assert.equal(parseToolArguments(call("c", "t", "[1]")).ok, false);
  assert.equal(parseToolArguments(call("c", "t", "{oops")).ok, false);
});

test("a read-only allowed tool runs, its result is fed back, and the loop ends on text", async () => {
  const seen = [];
  const updates = [];
  const result = await runToolLoop({
    messages: [{ role: "user", content: "查一下" }],
    request: async (messages) => {
      seen.push(messages.length);
      if (seen.length === 1) {
        return { text: "", toolCalls: [call("c1", "vault.search", '{"q":"x"}')] };
      }
      const toolMessage = messages[messages.length - 1];
      assert.equal(toolMessage.role, "tool");
      assert.equal(toolMessage.content, "vault.search result");
      return { text: "找到了", toolCalls: [] };
    },
    options: {
      tools: [tool("vault.search")],
      maxAutoIterations: 2,
      isAllowed: () => true,
      onToolUpdate: (state) => updates.push(state.status),
    },
  });
  assert.equal(result.stopped, "done");
  assert.equal(result.iterations, 2);
  assert.equal(result.messages[result.messages.length - 1].content, "找到了");
  assert.deepEqual(updates, ["running", "success"]);
});

test("a disallowed tool waits for approval and does not send a tool message", async () => {
  let requests = 0;
  const result = await runToolLoop({
    messages: [{ role: "user", content: "q" }],
    request: async () => {
      requests += 1;
      return { text: "", toolCalls: [call("c1", "vault.search")] };
    },
    options: { tools: [tool("vault.search")], isAllowed: () => false },
  });
  assert.equal(result.stopped, "pending_approval");
  assert.equal(result.toolStates[0].status, "pending_approval");
  assert.equal(requests, 1, "等待审批时不能偷偷再问一轮");
  assert.equal(result.messages.some((message) => message.role === "tool"), false);
});

test("a writing tool is never auto-run, even when the allow-list says yes", async () => {
  let executed = 0;
  const result = await runToolLoop({
    messages: [{ role: "user", content: "q" }],
    request: async () => ({ text: "", toolCalls: [call("c1", "vault.write")] }),
    options: {
      tools: [tool("vault.write", { readOnly: false, execute: async () => (executed += 1, "ok") })],
      isAllowed: () => true,
    },
  });
  assert.equal(result.stopped, "pending_approval");
  assert.equal(executed, 0);
});

test("an unknown tool is an error state rather than a crash", async () => {
  const result = await runToolLoop({
    messages: [{ role: "user", content: "q" }],
    request: async () => ({ text: "", toolCalls: [call("c1", "nope")] }),
    options: { tools: [], isAllowed: () => true },
  });
  assert.equal(result.toolStates[0].status, "error");
  assert.ok(result.toolStates[0].error.includes("未知工具"));
  assert.equal(result.messages.some((message) => message.role === "tool"), true);
});

test("a throwing tool becomes an error state with its message", async () => {
  const result = await runToolLoop({
    messages: [{ role: "user", content: "q" }],
    request: async () => ({ text: "", toolCalls: [call("c1", "vault.read")] }),
    options: {
      tools: [tool("vault.read", { execute: async () => { throw new Error("文件不存在"); } })],
      isAllowed: () => true,
    },
  });
  assert.equal(result.toolStates[0].status, "error");
  assert.equal(result.messages[result.messages.length - 1].content, "工具执行失败：文件不存在");
});

test("the iteration cap stops the loop after the allowed number of rounds", async () => {
  const result = await runToolLoop({
    messages: [{ role: "user", content: "q" }],
    request: async () => ({ text: "", toolCalls: [call("c1", "vault.search")] }),
    options: { tools: [tool("vault.search")], isAllowed: () => true, maxAutoIterations: 1 },
  });
  assert.equal(result.stopped, "max_iterations");
  assert.equal(result.iterations, 1);
});

test("an abort before the first request ends as aborted, with no request made", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const result = await runToolLoop({
    messages: [],
    request: async () => (requests += 1, { text: "x", toolCalls: [] }),
    options: { tools: [], isAllowed: () => true, signal: controller.signal },
  });
  assert.equal(result.stopped, "aborted");
  assert.equal(requests, 0);
});

test("an approved pending call can be executed later, and toolResultMessages renders it", async () => {
  const state = { call: call("c1", "vault.read", '{"path":"a.md"}'), status: "pending_approval" };
  const executed = await executeApprovedTool(state, tool("vault.read", { execute: async (args) => `read ${args.path}` }));
  assert.equal(executed.status, "success");
  assert.equal(executed.result, "read a.md");
  assert.deepEqual(toolResultMessages([executed]), [
    { role: "tool", content: "read a.md", toolCallId: "c1", name: "vault.read" },
  ]);
  const failed = await executeApprovedTool(state, tool("vault.read", { execute: async () => { throw new Error("boom"); } }));
  assert.equal(toolResultMessages([failed])[0].content, "工具执行失败：boom");
});