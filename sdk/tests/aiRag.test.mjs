/**
 * Chunking, incremental planning, retries, indexing and query.
 *
 * The indexer is driven with a fake embed function and the real vector store, so
 * the assertions are about policy: which files are re-embedded, which old chunks
 * disappear, which failures are retried, and what a cancel leaves behind.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chunkMarkdown,
  contentHash,
  planIncrementalIndex,
  queryRag,
  retryDelayMs,
  updateVectorIndex,
  withRetries,
} from "../.build/ai/aiRag.js";
import { createAiVectorStore } from "../.build/ai/aiVectorStore.js";

function memoryVectorFs() {
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
      async readBinary(path) {
        const value = files.get(path);
        return value instanceof Uint8Array ? value : null;
      },
      async writeBinary(path, data) {
        files.set(path, data);
      },
      async rename(from, to) {
        if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
        files.set(to, files.get(from));
        files.delete(from);
      },
      async remove(path) {
        files.delete(path);
      },
      async rmdir(dir) {
        for (const key of [...files.keys()]) if (key === dir || key.startsWith(`${dir}/`)) files.delete(key);
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

function embedFromText(text) {
  const vector = [0, 0, 0, 0.1];
  if (text.includes("苹果")) vector[0] = 1;
  if (text.includes("香蕉")) vector[1] = 1;
  if (text.includes("猫")) vector[2] = 1;
  return vector;
}

function scriptedEmbed(options = {}) {
  const calls = [];
  let failures = options.failTimes ?? 0;
  const fn = async (texts) => {
    calls.push([...texts]);
    if (failures > 0) {
      failures -= 1;
      const error = new Error(options.message ?? "rate limited");
      error.status = options.status ?? 429;
      throw error;
    }
    return texts.map((text) => embedFromText(text));
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

test("chunks stay on paragraph boundaries and carry true line numbers", () => {
  const text = ["# 标题", "", "第一段第一行", "第一段第二行", "", "第二段"].join("\n");
  const chunks = chunkMarkdown(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 6);
  assert.ok(chunks[0].content.includes("第一段第二行"));
});

test("a small budget splits into chunks whose line numbers point at the source", () => {
  const text = Array.from({ length: 12 }, (_value, index) => `第${index + 1}行内容`).join("\n");
  const chunks = chunkMarkdown(text, { chunkSize: 30, overlap: 0 });
  assert.ok(chunks.length > 1);
  const lines = text.split("\n");
  for (const chunk of chunks) {
    const first = lines[chunk.startLine - 1];
    assert.ok(chunk.content.startsWith(first), `chunk 应从 ${chunk.startLine} 行开始`);
    assert.ok(chunk.startLine >= 1 && chunk.endLine <= lines.length);
  }
});

test("overlap carries the previous chunk's tail into the next one", () => {
  const text = Array.from({ length: 10 }, (_value, index) => `line-${index + 1}xx`).join("\n");
  const chunks = chunkMarkdown(text, { chunkSize: 30, overlap: 10 });
  assert.ok(chunks.length >= 2);
  const firstTail = chunks[0].content.split("\n").pop();
  assert.ok(chunks[1].content.startsWith(firstTail), "第二块应以重叠行开头");
});

test("an oversized single paragraph is split rather than dropped", () => {
  const text = "x".repeat(250);
  const chunks = chunkMarkdown(text, { chunkSize: 100, overlap: 0 });
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.map((chunk) => chunk.content).join(""), text);
});

test("empty and whitespace-only input produces no chunks", () => {
  assert.deepEqual(chunkMarkdown(""), []);
  assert.deepEqual(chunkMarkdown("   \n\n  "), []);
});

// ---------------------------------------------------------------------------
// Incremental planning
// ---------------------------------------------------------------------------

test("the planner separates new, changed, unchanged and deleted files", () => {
  const a = { path: "a.md", mtime: 1, content: "same" };
  const b = { path: "b.md", mtime: 2, content: "new content" };
  const c = { path: "c.md", mtime: 3, content: "fresh" };
  const indexed = [
    { path: "a.md", mtime: 1, hash: contentHash("same") },
    { path: "b.md", mtime: 2, hash: contentHash("old content") },
    { path: "gone.md", mtime: 1, hash: "x" },
  ];
  const plan = planIncrementalIndex({ files: [a, b, c], indexed });
  assert.deepEqual(plan.toIndex.map((file) => file.path), ["b.md", "c.md"]);
  assert.deepEqual(plan.toDelete, ["gone.md"]);
  assert.equal(plan.unchanged, 1);
});

test("force reindexes everything and still reports deletions", () => {
  const file = { path: "a.md", mtime: 1, content: "same" };
  const indexed = [{ path: "a.md", mtime: 1, hash: contentHash("same") }];
  const plan = planIncrementalIndex({ files: [file], indexed, force: true });
  assert.deepEqual(plan.toIndex.map((entry) => entry.path), ["a.md"]);
  assert.equal(plan.unchanged, 0);
});

test("content hashes are stable and content-sensitive", () => {
  assert.equal(contentHash("同样的内容"), contentHash("同样的内容"));
  assert.notEqual(contentHash("甲"), contentHash("乙"));
  assert.notEqual(contentHash("ab"), contentHash("ba"));
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test("backoff doubles and caps, and only retryable failures are retried", async () => {
  assert.equal(retryDelayMs(1, 100, 1000), 100);
  assert.equal(retryDelayMs(2, 100, 1000), 200);
  assert.equal(retryDelayMs(9, 100, 1000), 1000);

  const delays = [];
  let attempts = 0;
  const result = await withRetries(
    async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("busy"), { status: 503 });
      return "ok";
    },
    { maxRetries: 5, baseDelayMs: 50, maxDelayMs: 1000, sleep: async (ms) => delays.push(ms) },
  );
  assert.equal(result, "ok");
  assert.deepEqual(delays, [50, 100]);

  let limited = 0;
  await assert.rejects(
    withRetries(
      async () => {
        limited += 1;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
      { maxRetries: 5, sleep: async () => undefined },
    ),
    /bad request/,
  );
  assert.equal(limited, 1, "非重试错误不应重复请求");
});

// ---------------------------------------------------------------------------
// Indexing and query
// ---------------------------------------------------------------------------

test("indexing embeds chunks, writes vectors, and a second run re-embeds nothing", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 4 });
  const embed = scriptedEmbed();
  const files = [
    { path: "notes/苹果.md", mtime: 100, content: "苹果很好吃\n\n苹果也可以做派" },
    { path: "notes/香蕉.md", mtime: 200, content: "香蕉是黄色的" },
  ];
  const first = await updateVectorIndex({ files, store, embed, options: { model: "m", chunkSize: 100, batchSize: 10 } });
  assert.equal(first.cancelled, false);
  assert.equal(first.failures.length, 0);
  assert.equal(first.indexedFiles, 2);
  assert.ok(first.chunks >= 2);
  const callsAfterFirst = embed.calls.length;
  assert.ok(callsAfterFirst >= 1);

  const second = await updateVectorIndex({ files, store, embed, options: { model: "m", chunkSize: 100, batchSize: 10 } });
  assert.equal(second.indexedFiles, 0);
  assert.equal(embed.calls.length, callsAfterFirst, "未变化的文件不应重新嵌入");

  const hits = await queryRag({ text: "苹果", store, embed, options: { model: "m", limit: 5 } });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].path, "notes/苹果.md");
});

test("a changed file loses its old chunks before the new ones arrive", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 10 });
  const embed = scriptedEmbed();
  const long = { path: "a.md", mtime: 1, content: ["苹果".repeat(30), "苹果".repeat(30), "苹果".repeat(30)].join("\n\n") };
  await updateVectorIndex({ files: [long], store, embed, options: { model: "m", chunkSize: 40, overlap: 0 } });
  const before = (await store.stats()).chunks;
  await updateVectorIndex({
    files: [{ path: "a.md", mtime: 2, content: "苹果" }],
    store,
    embed,
    options: { model: "m", chunkSize: 40, overlap: 0 },
  });
  const after = await store.stats();
  assert.ok(after.chunks < before, "文件变短后旧块不能留下");
  assert.equal(after.chunks, 1);
});

test("deleting a file removes its vectors on the next run", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 10 });
  const embed = scriptedEmbed();
  await updateVectorIndex({
    files: [{ path: "a.md", mtime: 1, content: "苹果" }, { path: "b.md", mtime: 1, content: "香蕉" }],
    store,
    embed,
    options: { model: "m" },
  });
  const report = await updateVectorIndex({ files: [{ path: "a.md", mtime: 1, content: "苹果" }], store, embed, options: { model: "m" } });
  assert.equal(report.deletedPaths, 1);
  assert.deepEqual((await store.listPaths()).map((entry) => entry.path), ["a.md"]);
});

test("a retryable embed failure is retried with backoff, and a bad request is reported", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 10 });
  const delays = [];
  const flaky = scriptedEmbed({ failTimes: 2, status: 429 });
  const report = await updateVectorIndex({
    files: [{ path: "a.md", mtime: 1, content: "苹果" }],
    store,
    embed: flaky,
    options: { model: "m", maxRetries: 3, baseDelayMs: 25, sleep: async (ms) => delays.push(ms) },
  });
  assert.equal(report.failures.length, 0);
  assert.deepEqual(delays, [25, 50]);

  const bad = scriptedEmbed({ failTimes: 99, status: 400, message: "bad request" });
  const failed = await updateVectorIndex({
    files: [{ path: "b.md", mtime: 1, content: "香蕉" }],
    store,
    embed: bad,
    options: { model: "m", maxRetries: 3, sleep: async () => undefined },
  });
  assert.equal(failed.failures.length, 1);
  assert.ok(failed.failures[0].message.includes("bad request"));
});

test("a cancelled run stops and reports cancellation instead of pretending success", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 10 });
  const controller = new AbortController();
  controller.abort();
  const embed = scriptedEmbed();
  const report = await updateVectorIndex({
    files: [{ path: "a.md", mtime: 1, content: "苹果" }],
    store,
    embed,
    options: { model: "m", signal: controller.signal },
  });
  assert.equal(report.cancelled, true);
  assert.equal(embed.calls.length, 0);
  assert.equal((await store.stats()).chunks, 0);
});

test("query respects scope, minSimilarity and limit", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 10 });
  const embed = scriptedEmbed();
  await updateVectorIndex({
    files: [
      { path: "notes/苹果.md", mtime: 1, content: "苹果" },
      { path: "other/苹果.md", mtime: 1, content: "苹果" },
      { path: "notes/香蕉.md", mtime: 1, content: "香蕉" },
    ],
    store,
    embed,
    options: { model: "m", chunkSize: 1000 },
  });
  const scoped = await queryRag({ text: "苹果", store, embed, options: { model: "m", scope: { folders: ["notes"] }, limit: 5, minSimilarity: 0.5 } });
  assert.deepEqual(scoped.map((hit) => hit.path), ["notes/苹果.md"]);
  const limited = await queryRag({ text: "苹果", store, embed, options: { model: "m", limit: 1, minSimilarity: 0.5 } });
  assert.equal(limited.length, 1);
});