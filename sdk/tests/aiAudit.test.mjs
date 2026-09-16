/**
 * The write audit: hashes, batches, and the undo plan.
 *
 * The undo plan is the part worth testing hardest: restoring twice, restoring a
 * file the user edited after the AI wrote it, and removing a file the batch
 * created are three different actions and the wrong one loses data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  batchFiles,
  createWriteAudit,
  createWriteBatch,
  describeUndoPlan,
  describeWriteBatch,
  formatAuditLine,
  hashText,
  matchesAfterHash,
  planUndo,
  undoOrder,
  withAuditEntry,
} from "../.build/ai/aiAudit.js";

test("hashes are stable, differ on content, and are 16 hex digits", () => {
  assert.equal(hashText("hello"), hashText("hello"));
  assert.notEqual(hashText("hello"), hashText("hello!"));
  assert.match(hashText(""), /^[0-9a-f]{16}$/);
  assert.match(hashText("a".repeat(10_000)), /^[0-9a-f]{16}$/);
});

test("an audit entry records both hashes and marks a creation", () => {
  const created = createWriteAudit({ batchId: "b1", tool: "vault.create", path: "a.md", before: null, after: "new", at: 5 });
  assert.equal(created.created, true);
  assert.equal(created.beforeHash, "");
  assert.equal(created.afterHash, hashText("new"));
  assert.equal(created.beforeChars, 0);
  assert.equal(created.afterChars, 3);

  const rewritten = createWriteAudit({ batchId: "b1", tool: "vault.rewriteNote", path: "a.md", before: "old", after: "older", at: 6 });
  assert.equal(rewritten.created, undefined);
  assert.equal(rewritten.beforeHash, hashText("old"));
});

test("withAuditEntry returns a new batch rather than mutating it", () => {
  const batch = createWriteBatch({ id: "b1", runId: "r1", title: "写入", at: 1 });
  const entry = createWriteAudit({ batchId: "b1", tool: "vault.append", path: "a.md", before: "a", after: "ab", at: 2 });
  const next = withAuditEntry(batch, entry);
  assert.equal(batch.entries.length, 0);
  assert.equal(next.entries.length, 1);
  assert.equal(next.runId, "r1");
});

test("undoOrder is newest first and batchFiles is first-touch order", () => {
  const a1 = createWriteAudit({ batchId: "b", tool: "t", path: "a.md", before: "1", after: "2", at: 10 });
  const b1 = createWriteAudit({ batchId: "b", tool: "t", path: "b.md", before: null, after: "x", at: 20 });
  const a2 = createWriteAudit({ batchId: "b", tool: "t", path: "a.md", before: "2", after: "3", at: 30 });
  assert.deepEqual(undoOrder([a1, b1, a2]).map((entry) => entry.at), [30, 20, 10]);
  assert.deepEqual(batchFiles({ id: "b", title: "t", createdAt: 0, entries: [a2, b1, a1] }), ["a.md", "b.md"]);
});

test("planUndo restores each path once, from its earliest write", () => {
  const first = createWriteAudit({ batchId: "b", tool: "t", path: "a.md", before: "v0", after: "v1", at: 10 });
  const second = createWriteAudit({ batchId: "b", tool: "t", path: "a.md", before: "v1", after: "v2", at: 20 });
  const created = createWriteAudit({ batchId: "b", tool: "t", path: "new.md", before: null, after: "n", at: 30 });
  const plan = planUndo([first, second, created], (path) => (path === "a.md" ? "v2" : "n"));
  assert.equal(plan.stale.length, 0);
  assert.equal(plan.steps.length, 2);
  const restored = plan.steps.find((step) => step.path === "a.md");
  assert.equal(restored.action, "restore");
  assert.equal(restored.entry.beforeHash, first.beforeHash);
  assert.equal(plan.steps.find((step) => step.path === "new.md").action, "remove");
});

test("planUndo marks a file edited after the AI wrote it", () => {
  const entry = createWriteAudit({ batchId: "b", tool: "t", path: "a.md", before: "v0", after: "v1", at: 10 });
  const plan = planUndo([entry], () => "user-edit");
  assert.deepEqual(plan.stale, ["a.md"]);
  assert.equal(plan.steps[0].stale, true);
  assert.match(describeUndoPlan(plan), /被改过/);
});

test("describeWriteBatch sums the per-file delta and caps the list", () => {
  const batch = createWriteBatch({ id: "b", title: "写入", at: 1 });
  const one = withAuditEntry(batch, createWriteAudit({ batchId: "b", tool: "t", path: "a.md", before: "1234", after: "123456", at: 2 }));
  assert.match(describeWriteBatch(one), /\+2 字/);
  let many = batch;
  for (let index = 0; index < 15; index += 1) {
    many = withAuditEntry(many, createWriteAudit({ batchId: "b", tool: "t", path: `n${index}.md`, before: "", after: "x", at: 3 + index }));
  }
  assert.match(describeWriteBatch(many), /等 15 个文件/);
});

test("formatAuditLine and matchesAfterHash keep the audit checkable", () => {
  const entry = createWriteAudit({ batchId: "b", tool: "t", path: "a.md", before: "old", after: "new" });
  assert.match(formatAuditLine(entry), /改写 a\.md/);
  assert.equal(matchesAfterHash(entry, "new"), true);
  assert.equal(matchesAfterHash(entry, "newer"), false);
  assert.match(formatAuditLine(createWriteAudit({ batchId: "b", tool: "t", path: "n.md", before: null, after: "x" })), /新建/);
});