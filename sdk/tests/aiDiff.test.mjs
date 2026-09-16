/**
 * The line diff and hunk application.
 *
 * The shapes that matter to the apply UI: an empty original, a deletion, a pure
 * addition, repeated lines (where a bad LCS picks the wrong occurrence) and CRLF.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyDiffBlocks, diffLines } from "../.build/ai/aiDiff.js";

test("identical text is one unchanged block", () => {
  const result = diffLines("a\nb", "a\nb");
  assert.deepEqual(result.blocks, [{ type: "unchanged", value: "a\nb" }]);
  assert.equal(result.coarse, false);
});

test("a replacement becomes one modified block, not one per line", () => {
  const result = diffLines("a\nb\nc", "a\nB\nc");
  assert.deepEqual(result.blocks, [
    { type: "unchanged", value: "a" },
    { type: "modified", originalValue: "b", modifiedValue: "B" },
    { type: "unchanged", value: "c" },
  ]);
});

test("an empty original is a pure addition and an empty result is a pure deletion", () => {
  assert.deepEqual(diffLines("", "new\nlines").blocks, [{ type: "modified", modifiedValue: "new\nlines" }]);
  assert.deepEqual(diffLines("old\nlines", "").blocks, [{ type: "modified", originalValue: "old\nlines" }]);
});

test("repeated lines do not confuse the alignment", () => {
  const result = diffLines("x\ny\nx\ny", "x\ny\nx\nz\ny");
  const modified = result.blocks.filter((block) => block.type === "modified");
  assert.equal(modified.length, 1);
  assert.equal(modified[0].modifiedValue, "z");
  assert.equal(modified[0].originalValue, undefined);
});

test("CRLF input compares equal to LF content", () => {
  const result = diffLines("a\r\nb\r\n", "a\nb\n");
  assert.equal(result.blocks.some((block) => block.type === "modified"), false);
});

test("applyDiffBlocks honors current, incoming and both", () => {
  const original = "keep\nold\nkeep2";
  const result = diffLines(original, "keep\nnew\nkeep2");
  const allIncoming = applyDiffBlocks(original, result.blocks, () => "incoming");
  const allCurrent = applyDiffBlocks(original, result.blocks, () => "current");
  const both = applyDiffBlocks(original, result.blocks, () => "both");
  assert.equal(allIncoming, "keep\nnew\nkeep2");
  assert.equal(allCurrent, original);
  assert.equal(both, "keep\nold\nnew\nkeep2");
});

test("a trailing newline survives every choice", () => {
  const original = "a\nb\n";
  const result = diffLines(original, "a\nc\n");
  assert.equal(applyDiffBlocks(original, result.blocks, () => "incoming"), "a\nc\n");
  assert.equal(applyDiffBlocks(original, result.blocks, () => "current"), "a\nb\n");
});