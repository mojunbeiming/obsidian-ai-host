/**
 * Apply: prompt assembly, fence stripping, and the session's diff.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApplyMessages, changedBlockCount, createApplySession, stripCodeFences } from "../.build/ai/aiApply.js";

test("a wrapping fence is removed, with or without a language tag", () => {
  assert.equal(stripCodeFences("```markdown\n# 标题\n正文\n```"), "# 标题\n正文");
  assert.equal(stripCodeFences("```\n正文\n```"), "正文");
  assert.equal(stripCodeFences("```json\n{\"a\":1}\n```\n"), "{\"a\":1}");
});

test("a file that merely contains fences keeps them", () => {
  const source = "# 关于围栏\n\n```\ncode\n```\n\n结束";
  assert.equal(stripCodeFences(source), source);
  const unterminated = "```\n没有结束";
  assert.equal(stripCodeFences(unterminated), unterminated);
});

test("the apply prompt contains the whole file, the block and the history", () => {
  const messages = buildApplyMessages({
    file: "notes/a.md",
    originalContent: "第一行\n第二行\n第三行",
    instruction: "把第二行改短",
    block: { fromLine: 2, toLine: 2, content: "第二行" },
    history: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "在" },
    ],
    maxContextMessages: 1,
  });
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes("完整文件"));
  const user = messages[messages.length - 1];
  assert.ok(user.content.includes("notes/a.md"));
  assert.ok(user.content.includes("第一行\n第二行\n第三行"));
  assert.ok(user.content.includes("第 2-2 行"));
  assert.ok(user.content.includes("把第二行改短"));
  assert.equal(messages.length, 3, "上下文只保留最近一条历史");
});

test("createApplySession strips the fence before diffing", () => {
  const session = createApplySession({ file: "a.md", originalContent: "old", incomingContent: "```\nnew\n```", now: () => 7 });
  assert.equal(session.incomingContent, "new");
  assert.equal(session.createdAt, 7);
  assert.equal(changedBlockCount(session), 1);
});