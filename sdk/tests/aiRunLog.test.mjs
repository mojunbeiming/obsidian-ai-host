/**
 * Run records: model, redaction, formatting, retention and the store's
 * corruption/index-rebuild behaviour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyError, errorFromStatus } from "../.build/ai/aiErrors.js";
import {
  appendRunError,
  appendRunStep,
  createRunRecord,
  createRunStore,
  finishRunRecord,
  formatRunMarkdown,
  normalizeRunRecord,
  selectRunsToPrune,
  summarizeRun,
  truncateRunText,
} from "../.build/ai/aiRunLog.js";

function memoryFs() {
  const files = new Map();
  return {
    files,
    fs: {
      async mkdir() {},
      async readText(path) {
        const value = files.get(path);
        return typeof value === "string" ? value : null;
      },
      async writeText(path, text) {
        files.set(path, text);
      },
      async rename(from, to) {
        if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
        files.set(to, files.get(from));
        files.delete(from);
      },
      async remove(path) {
        files.delete(path);
      },
      async list(dir) {
        const prefix = `${dir}/`;
        return [...files.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map((key) => key.slice(prefix.length));
      },
    },
  };
}

function run(id, startedAt = 1000) {
  const record = createRunRecord({ pluginId: "sfc-ai", kind: "chat", title: "一次聊天", id, startedAt });
  appendRunStep(record, { kind: "request", title: "请求 model @ host", meta: { attempt: 1 } });
  finishRunRecord(record, { status: "ok", summary: "完成", usage: { prompt: 10, completion: 5, total: 15 } });
  return record;
}

test("a run records steps, usage, errors and duration", () => {
  const record = createRunRecord({ pluginId: "sfc-ai", kind: "skill", title: "制卡", skillId: "flashcards.makeCards" });
  const step = appendRunStep(record, { kind: "context.read", title: "读取 3 篇素材", meta: { files: 3 } });
  appendRunStep(record, { kind: "parse", title: "接受 2 张，拒绝 1 条", level: "warn" });
  appendRunError(record, errorFromStatus(429, "busy"));
  finishRunRecord(record, { status: "failed", summary: "被限流", error: classifyError(Object.assign(new Error("busy"), { status: 429 })) });
  assert.equal(record.status, "failed");
  assert.ok(record.endedAt);
  assert.equal(record.steps.length, 2);
  assert.equal(record.errors.length, 2);
  assert.equal(step.id.startsWith("step-"), true);
  const summary = summarizeRun(record);
  assert.equal(summary.stepCount, 2);
  assert.equal(summary.errorCount, 2);
  assert.equal(summary.firstErrorCode, "AI_RATE_LIMIT");
});

test("text previews keep the head and the tail, and are redacted", () => {
  const long = `${"a".repeat(3000)} sk-secret123456 ${"b".repeat(1000)}`;
  const preview = truncateRunText(long);
  assert.ok(preview.length < long.length);
  assert.ok(preview.includes("已截断"));
  assert.equal(preview.includes("sk-secret123456"), false, "预览必须脱敏");
});

test("formatRunMarkdown is a self-contained copyable report", () => {
  const record = createRunRecord({ pluginId: "sfc-todo", kind: "skill", title: "规划", skillId: "todo.planTasks", id: "r1" });
  appendRunStep(record, { kind: "prompt.user", title: "用户提示词", detail: "把这件事拆成任务" });
  appendRunError(record, errorFromStatus(503, "down"));
  finishRunRecord(record, { status: "failed", summary: "服务不可用" });
  const markdown = formatRunMarkdown(record);
  assert.ok(markdown.includes("# 运行 r1"));
  assert.ok(markdown.includes("todo.planTasks"));
  assert.ok(markdown.includes("AI_PROVIDER_503"));
  assert.ok(markdown.includes("服务不可用"));
});

test("a record with a key in its detail is redacted before it is stored", () => {
  const record = createRunRecord({ pluginId: "sfc-ai", kind: "chat", title: "请求", id: "r2" });
  appendRunStep(record, { kind: "request", title: "Authorization", detail: "Bearer sk-abcdef123456" });
  const stored = JSON.stringify(normalizeRunRecord(record));
  assert.equal(stored.includes("sk-abcdef123456"), false);
  assert.ok(stored.includes("***"));
});

test("normalize rejects records without id/pluginId and caps steps", () => {
  assert.equal(normalizeRunRecord({ title: "x" }), null);
  assert.equal(normalizeRunRecord({ id: "x" }), null);
  const record = createRunRecord({ pluginId: "p", kind: "chat", title: "t", id: "cap" });
  for (let index = 0; index < 10; index += 1) appendRunStep(record, { kind: "delta", title: `s${index}` });
  const normalized = normalizeRunRecord(record);
  assert.ok(normalized.steps.length === 10);
});

test("retention removes the oldest runs once any limit is hit", () => {
  const old = run("old", 1000);
  const mid = run("mid", 2000);
  const fresh = run("fresh", 3000);
  const byCount = selectRunsToPrune([old, mid, fresh], { maxRuns: 2 }, 4000);
  assert.deepEqual(byCount.remove, ["old"]);
  const day = 24 * 60 * 60 * 1000;
  const byAge = selectRunsToPrune([old, mid, fresh], { maxAgeDays: 1 }, 3000 + day);
  assert.deepEqual(byAge.remove.sort(), ["mid", "old"]);
});

test("the store persists, lists, reads back full records, and isolates corruption", async () => {
  const memory = memoryFs();
  const store = createRunStore(memory.fs, { dir: "runs", retention: { maxRuns: 10 }, now: () => 4000 });
  await store.init();
  await store.save(run("a", 1000));
  await store.save(run("b", 2000));

  const list = await store.list();
  assert.deepEqual(list.map((entry) => entry.id), ["b", "a"]);
  const read = await store.read("a");
  assert.equal(read.steps.length, 1);

  // A fresh store reads the index, then the file for the body -- not an empty stub.
  const restarted = createRunStore(memory.fs, { dir: "runs", now: () => 4000 });
  await restarted.init();
  const afterRestart = await restarted.read("a");
  assert.equal(afterRestart.steps.length, 1, "重启后读到的必须是完整记录");

  const fileA = [...memory.files.keys()].find((path) => path.includes("v1_a-"));
  memory.files.set(fileA, "{ broken");
  const rebuilt = await store.rebuildIndex();
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.skipped.length, 1);
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["b"]);
});

test("the store applies its retention policy on save", async () => {
  const memory = memoryFs();
  const store = createRunStore(memory.fs, { dir: "runs", retention: { maxRuns: 2 }, now: () => 4000 });
  await store.save(run("one", 1000));
  await store.save(run("two", 2000));
  await store.save(run("three", 3000));
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["three", "two"]);
  const files = [...memory.files.keys()].filter((path) => path.includes("v1_one-"));
  assert.equal(files.length, 0, "被保留策略淘汰的文件必须真的删掉");
});

test("clear empties both the files and the index", async () => {
  const memory = memoryFs();
  const store = createRunStore(memory.fs, { dir: "runs" });
  await store.save(run("a", 1000));
  await store.clear();
  assert.deepEqual(await store.list(), []);
  assert.equal([...memory.files.keys()].some((path) => path.startsWith("runs/v1_")), false);
});

// ---------------------------------------------------------------------------
// Regression: strict adapters and a stale index
// ---------------------------------------------------------------------------

/** An adapter whose rename throws when the destination exists (Obsidian does). */
function strictRenameFs(memory) {
  const fs = { ...memory.fs };
  const rename = memory.fs.rename.bind(memory.fs);
  fs.rename = async (from, to) => {
    if (memory.files.has(to)) throw new Error("Destination file already exists!");
    await rename(from, to);
  };
  return fs;
}

test("a run store re-saves over a strict adapter and its index agrees", async () => {
  const memory = memoryFs();
  const store = createRunStore(strictRenameFs(memory));
  const record = run("run-1", Date.now());
  await store.save(record);
  record.summary = "更新后的摘要";
  await store.save(record);
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal((await store.read("run-1")).summary, "更新后的摘要");
  assert.equal(JSON.parse(memory.files.get("runs/index.json")).runs.length, 1);
});

test("an empty run index beside run files rebuilds", async () => {
  const memory = memoryFs();
  await createRunStore(memory.fs).save(run("run-1", Date.now()));
  memory.files.set("runs/index.json", JSON.stringify({ schema: 1, runs: [] }));
  const store = createRunStore(memory.fs);
  const info = await store.init();
  assert.equal(info.rebuilt, true);
  assert.equal((await store.list()).length, 1);
});
