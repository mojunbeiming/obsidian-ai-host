/**
 * The context budget: what is sent, what is clipped, what is skipped.
 *
 * Every assertion here is about a sentence the panel owes the user. "The model
 * ignored my last note" is the failure the report prevents, so the skip must be
 * a value -- not a silent truncation in a prompt builder.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildContextBundle, contextBudgetFromSettings, contextSummaryLine, DEFAULT_CONTEXT_BUDGET } from "../.build/aiContext.js";

const file = (path, text) => ({ path, title: path.replace(/\.md$/, ""), text });

test("text and a selection become labelled sections", () => {
  const result = buildContextBundle([
    { kind: "text", text: "今天要做什么" },
    { kind: "selection", file: "a.md", fromLine: 2, toLine: 4, text: "一段选区" },
  ]);
  assert.match(result.text, /今天要做什么/);
  assert.match(result.text, /### 选区：a\.md（第 3 行起）/);
  assert.equal(result.fileCount, 0);
  assert.equal(result.charCount, result.sections.reduce((total, section) => total + section.chars, 0));
});

test("notes are clipped per file and the clip is reported", () => {
  const result = buildContextBundle([{ kind: "notes", files: [file("a.md", "字".repeat(100))] }], {
    ...DEFAULT_CONTEXT_BUDGET,
    perFileChars: 10,
  });
  assert.equal(result.files[0].truncated, true);
  assert.ok(result.notes.some((line) => line.includes("已截断")));
  assert.match(result.text, /这篇只发送了前 10 字/);
});

test("the file limit stops the list and says how many were skipped", () => {
  const files = [file("a.md", "a"), file("b.md", "b"), file("c.md", "c")];
  const result = buildContextBundle([{ kind: "folder", path: "笔记", recursive: false, files }], {
    ...DEFAULT_CONTEXT_BUDGET,
    maxFiles: 2,
  });
  assert.equal(result.fileCount, 2);
  assert.equal(result.files.filter((entry) => !entry.included).length, 1);
  assert.ok(result.problems.some((line) => line.includes("2 篇文件上限")));
});

test("the total character limit marks the overflow as skipped, not silent", () => {
  const result = buildContextBundle([{ kind: "notes", files: [file("a.md", "a".repeat(50)), file("b.md", "b".repeat(50))] }], {
    ...DEFAULT_CONTEXT_BUDGET,
    maxChars: 70,
  });
  assert.equal(result.files.filter((entry) => entry.included).length, 1);
  assert.ok(result.problems.some((line) => line.includes("上下文上限")));
});

test("images are counted and the over-budget ones are named", () => {
  const result = buildContextBundle([{ kind: "image", paths: ["a.png", "b.png", "c.png"] }], {
    ...DEFAULT_CONTEXT_BUDGET,
    maxImages: 2,
  });
  assert.equal(result.imageCount, 2);
  assert.ok(result.problems.some((line) => line.includes("最后 1 张")));
});

test("the summary line carries files, characters and images", () => {
  const result = buildContextBundle([
    { kind: "notes", files: [file("a.md", "hello")] },
    { kind: "image", paths: ["a.png"] },
  ]);
  const line = contextSummaryLine(result);
  assert.match(line, /1 篇笔记/);
  assert.match(line, new RegExp(`${result.charCount} 字`));
  assert.match(line, /1 张图片/);
});

test("a budget read from settings is clamped, and bad values fall back", () => {
  const budget = contextBudgetFromSettings({
    aiContextMaxFiles: 0,
    aiContextMaxChars: 999_999,
    aiContextPerFileChars: "x",
    aiMaxImages: 3,
  });
  assert.equal(budget.maxFiles, 1);
  assert.equal(budget.maxChars, 400_000);
  assert.equal(budget.perFileChars, DEFAULT_CONTEXT_BUDGET.perFileChars);
  assert.equal(budget.maxImages, 3);
});