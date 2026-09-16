/**
 * The vector store over an in-memory binary filesystem.
 *
 * The properties worth pinning: exact cosine ordering, dimension/model
 * filtering, persistence across store instances, deletion that shrinks the
 * files, and a manifest that can be lost without losing the index.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createAiVectorStore } from "../.build/ai/aiVectorStore.js";

function memoryVectorFs() {
  const files = new Map();
  const fs = {
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
  };
  return { files, fs };
}

function record(id, path, vector, options = {}) {
  return {
    id,
    path,
    mtime: options.mtime ?? 1000,
    hash: options.hash ?? `hash-${id}`,
    model: options.model ?? "text-embedding-3-small",
    dimension: vector.length,
    content: options.content ?? `内容 ${id}`,
    vector: Float32Array.from(vector),
    metadata: { startLine: options.startLine ?? 1, endLine: options.endLine ?? 3 },
  };
}

const MODEL = "text-embedding-3-small";

test("query returns exact cosine order, with similarity and line metadata", async () => {
  const { fs } = memoryVectorFs();
  const store = createAiVectorStore(fs, { shardSize: 10 });
  await store.upsert([
    record("a", "notes/a.md", [1, 0], { startLine: 1, endLine: 4 }),
    record("b", "notes/b.md", [0.7071, 0.7071], { startLine: 10, endLine: 12 }),
    record("c", "other/c.md", [0, 1]),
  ]);
  const hits = await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2, limit: 10 });
  assert.deepEqual(hits.map((hit) => hit.id), ["a", "b", "c"]);
  assert.ok(Math.abs(hits[0].similarity - 1) < 1e-6);
  assert.ok(Math.abs(hits[1].similarity - 0.7071) < 1e-3);
  assert.ok(Math.abs(hits[2].similarity) < 1e-6);
  assert.deepEqual(hits[0].metadata, { startLine: 1, endLine: 4 });
});

test("model and dimension are filters, not decorations", async () => {
  const { fs } = memoryVectorFs();
  const store = createAiVectorStore(fs, { shardSize: 10 });
  await store.upsert([record("a", "a.md", [1, 0]), record("b", "b.md", [1, 0, 0], { model: "other-model" })]);
  assert.deepEqual((await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2 })).map((h) => h.id), ["a"]);
  assert.deepEqual(await store.query({ vector: Float32Array.from([1, 0]), model: "missing", dimension: 2 }), []);
  assert.deepEqual(await store.query({ vector: Float32Array.from([1, 0, 0]), model: MODEL, dimension: 3 }), []);
});

test("minSimilarity and limit are applied before the result leaves the store", async () => {
  const { fs } = memoryVectorFs();
  const store = createAiVectorStore(fs, { shardSize: 10 });
  await store.upsert([
    record("a", "a.md", [1, 0]),
    record("b", "b.md", [0.9, 0.4359]),
    record("c", "c.md", [0, 1]),
  ]);
  const filtered = await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2, minSimilarity: 0.5 });
  assert.deepEqual(filtered.map((hit) => hit.id), ["a", "b"]);
  const limited = await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2, limit: 1 });
  assert.deepEqual(limited.map((hit) => hit.id), ["a"]);
});

test("scope restricts to named files or folders", async () => {
  const { fs } = memoryVectorFs();
  const store = createAiVectorStore(fs, { shardSize: 10 });
  await store.upsert([
    record("a", "notes/a.md", [1, 0]),
    record("b", "notes/deep/b.md", [1, 0]),
    record("c", "other/c.md", [1, 0]),
  ]);
  const byFolder = await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2, scope: { folders: ["notes"] } });
  assert.deepEqual(byFolder.map((hit) => hit.id).sort(), ["a", "b"]);
  const byFile = await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2, scope: { files: ["other/c.md"] } });
  assert.deepEqual(byFile.map((hit) => hit.id), ["c"]);
});

test("the index survives a new store instance, and a lost manifest", async () => {
  const memory = memoryVectorFs();
  const first = createAiVectorStore(memory.fs, { shardSize: 2 });
  await first.upsert([record("a", "a.md", [1, 0]), record("b", "b.md", [0, 1]), record("c", "c.md", [0.6, 0.8])]);

  const second = createAiVectorStore(memory.fs, { shardSize: 2 });
  const hits = await second.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2, limit: 5 });
  assert.deepEqual(hits.map((hit) => hit.id), ["a", "c", "b"]);

  memory.files.delete("vector/manifest.json");
  const third = createAiVectorStore(memory.fs, { shardSize: 2 });
  const recovered = await third.query({ vector: Float32Array.from([0, 1]), model: MODEL, dimension: 2, limit: 5 });
  assert.deepEqual(recovered.map((hit) => hit.id), ["b", "c", "a"]);
});

test("shard size rolls over, and all shards are searched", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 3 });
  await store.upsert(Array.from({ length: 7 }, (_value, index) => record(`r${index}`, `f${index}.md`, [1, 0])));
  const stats = await store.stats();
  assert.equal(stats.chunks, 7);
  assert.equal(stats.shards, 3);
  assert.equal((await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2, limit: 10 })).length, 7);
});

test("deleteByPath removes only those files and rewrites the shard", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 10 });
  await store.upsert([record("a", "a.md", [1, 0]), record("b", "b.md", [1, 0]), record("c", "c.md", [1, 0])]);
  const removed = await store.deleteByPath(["b.md"]);
  assert.equal(removed, 1);
  assert.deepEqual((await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2 })).map((hit) => hit.id), ["a", "c"]);
  assert.deepEqual((await store.listPaths()).map((entry) => entry.path).sort(), ["a.md", "c.md"]);
});

test("replacing an id replaces its vector, not just its metadata", async () => {
  const { fs } = memoryVectorFs();
  const store = createAiVectorStore(fs, { shardSize: 10 });
  await store.upsert([record("a", "a.md", [1, 0], { content: "旧" })]);
  await store.upsert([record("a", "a.md", [0, 1], { content: "新" })]);
  const north = await store.query({ vector: Float32Array.from([1, 0]), model: MODEL, dimension: 2 });
  assert.equal(north[0].content, "新");
  assert.ok(Math.abs(north[0].similarity) < 1e-6, "替换后旧向量不能还在搜索里");
  const stats = await store.stats();
  assert.equal(stats.chunks, 1, "替换不能留下重复记录");
});

test("stats counts chunks, files, models and dimensions", async () => {
  const { fs } = memoryVectorFs();
  const store = createAiVectorStore(fs, { shardSize: 10 });
  await store.upsert([
    record("a", "a.md", [1, 0]),
    record("b", "a.md", [0, 1]),
    record("c", "b.md", [1, 0, 0], { model: "other" }),
  ]);
  const stats = await store.stats();
  assert.equal(stats.chunks, 3);
  assert.equal(stats.files, 2);
  assert.deepEqual(stats.models.sort(), ["other", MODEL].sort());
  assert.deepEqual(stats.dimensions, [2, 3]);
  assert.ok(stats.bytes > 0);
});

test("clear(model) drops one model; clear() removes the directory contract", async () => {
  const memory = memoryVectorFs();
  const store = createAiVectorStore(memory.fs, { shardSize: 10 });
  await store.upsert([record("a", "a.md", [1, 0]), record("b", "b.md", [1, 0], { model: "other" })]);
  await store.clear("other");
  assert.deepEqual((await store.stats()).models, [MODEL]);
  await store.clear();
  assert.equal(await store.isEmpty(), true);
  assert.equal([...memory.files.keys()].some((key) => key.startsWith("vector/")), false);
});

test("listPaths keeps the newest mtime and its hash per file", async () => {
  const { fs } = memoryVectorFs();
  const store = createAiVectorStore(fs, { shardSize: 10 });
  await store.upsert([
    record("a1", "a.md", [1, 0], { mtime: 100, hash: "old" }),
    record("a2", "a.md", [1, 0], { mtime: 200, hash: "new" }),
  ]);
  assert.deepEqual(await store.listPaths(), [{ path: "a.md", mtime: 200, hash: "new" }]);
});