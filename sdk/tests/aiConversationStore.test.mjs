/**
 * The conversation store over an in-memory filesystem.
 *
 * The tests worth reading are the destructive ones: a corrupt record must not
 * take the list with it, a missing index must rebuild, a half-finished write
 * must leave the previous record readable, and two saves racing must not leave
 * the index describing a vault that no longer exists.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_CONVERSATION_SCHEMA, AiConversationError, createConversationStore } from "../.build/ai/aiConversationStore.js";

/**
 * A `Map` filesystem that records every call.
 *
 * `rename` replaces the destination, which is the one property the store's
 * atomicity depends on; a delete-then-rename implementation would pass almost
 * every test here and still lose a record to a crash at the wrong moment.
 */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const log = [];
  const fs = {
    async mkdir(dir) {
      log.push(["mkdir", dir]);
    },
    async readText(path) {
      log.push(["read", path]);
      return files.has(path) ? files.get(path) : null;
    },
    async writeText(path, text) {
      log.push(["write", path]);
      files.set(path, text);
    },
    async rename(from, to) {
      log.push(["rename", from, to]);
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(path) {
      log.push(["remove", path]);
      files.delete(path);
    },
    async list(dir) {
      log.push(["list", dir]);
      const prefix = `${dir}/`;
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => path.slice(prefix.length));
    },
  };
  return { files, log, fs };
}

function makeStore(memory, ids = ["a", "b", "c"]) {
  let counter = 0;
  return createConversationStore(memory.fs, {
    newId: () => ids[counter++] ?? `id-${counter}`,
    now: () => 1_000 + counter,
  });
}

test("create writes one record file plus an index, and list reads the summary", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  const created = await store.create({ title: "第一次对话", messages: [{ role: "user", content: "hi" }] });
  assert.equal(created.id, "a");
  assert.equal(created.schema, AI_CONVERSATION_SCHEMA);
  assert.equal(created.title, "第一次对话");
  assert.equal(created.messageCount, undefined, "记录本身不需要派生字段");

  const recordFiles = [...memory.files.keys()].filter((path) => path.startsWith("conversations/v") && path.endsWith(".json"));
  assert.equal(recordFiles.length, 1);
  assert.ok(recordFiles[0].startsWith(`conversations/v${AI_CONVERSATION_SCHEMA}_`), recordFiles[0]);
  assert.ok(memory.files.has("conversations/index.json"));

  const list = await store.list();
  assert.deepEqual(list.map((entry) => entry.id), ["a"]);
  assert.equal(list[0].messageCount, 1);
  assert.equal(list[0].title, "第一次对话");
});

test("read returns the record, and rename updates the body and the index without renaming the file", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  await store.create({ title: "旧标题", messages: [{ role: "user", content: "hi" }] });
  const fileBefore = [...memory.files.keys()].find((path) => path.includes(`/v${AI_CONVERSATION_SCHEMA}_`));
  const fileNamesBefore = [...memory.files.keys()].sort();

  const record = await store.read("a");
  assert.equal(record.messages.length, 1);
  assert.equal(record.messages[0].content, "hi");

  const renamed = await store.rename("a", "新标题");
  assert.equal(renamed.title, "新标题");
  assert.deepEqual([...memory.files.keys()].sort(), fileNamesBefore, "文件名是 id，不随标题变化");
  assert.equal(JSON.parse(memory.files.get(fileBefore)).title, "新标题");
  assert.equal((await store.list())[0].title, "新标题");
});

test("remove deletes the record and the index entry", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  await store.create({ title: "one" });
  assert.equal(await store.remove("a"), true);
  assert.equal(await store.remove("a"), false);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.read("a"), null);
  assert.equal([...memory.files.keys()].some((path) => path.includes(`/v${AI_CONVERSATION_SCHEMA}_a`)), false);
});

test("list order is pinned first, then most recently updated", async () => {
  const memory = memoryFs();
  let clock = 100;
  const store = createConversationStore(memory.fs, { newId: (() => {
    const ids = ["one", "two", "three"];
    return () => ids.shift();
  })(), now: () => (clock += 10) });
  await store.create({ title: "第一个" });
  await store.create({ title: "第二个", pinned: true });
  await store.create({ title: "第三个" });
  const list = await store.list();
  assert.deepEqual(list.map((entry) => entry.title), ["第二个", "第三个", "第一个"]);
});

test("a corrupt record is isolated: the list survives, the read reports it, rebuild drops it", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  await store.create({ title: "good" });
  await store.create({ title: "broken" });
  const brokenFile = [...memory.files.keys()].find((path) => path.includes(`/v${AI_CONVERSATION_SCHEMA}_b-`));
  memory.files.set(brokenFile, "{ this is not json");

  assert.equal((await store.list()).length, 2, "索引还在，列表不读损坏文件的正文");
  assert.equal(await store.read("b"), null);
  const detailed = await store.readDetailed("b");
  assert.equal(detailed.problem, "corrupt");

  const rebuild = await store.rebuildIndex();
  assert.equal(rebuild.rebuilt, true);
  assert.deepEqual(rebuild.skipped, [brokenFile.slice("conversations/".length)]);
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["a"]);
});

test("a missing index rebuilds from the record files", async () => {
  const memory = memoryFs();
  const first = makeStore(memory);
  await first.create({ title: "还在" });
  memory.files.delete("conversations/index.json");

  const second = makeStore(memory);
  const info = await second.init();
  assert.equal(info.rebuilt, true);
  assert.deepEqual((await second.list()).map((entry) => entry.title), ["还在"]);
});

test("a record written by a newer schema is skipped, not mangled", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  await store.create({ title: "未来" });
  const file = [...memory.files.keys()].find((path) => path.includes(`/v${AI_CONVERSATION_SCHEMA}_a-`));
  memory.files.set(file, JSON.stringify({ schema: 99, id: "a", title: "未来", messages: [] }));

  const rebuild = await store.rebuildIndex();
  assert.deepEqual((await store.list()), []);
  assert.equal(rebuild.skipped.length, 1);
  const detailed = await store.readDetailed("a");
  assert.equal(detailed.problem, "version-ahead");
});

test("a save is atomic: a temporary file is renamed over the target, and nothing is left behind", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  await store.create({ title: "one" });
  const writes = memory.log.filter(([op]) => op === "write").map(([, path]) => path);
  const renames = memory.log.filter(([op]) => op === "rename");
  assert.ok(writes.some((path) => path.endsWith(".tmp")), "正文必须先写临时文件");
  assert.equal(renames.length >= 1, true);
  assert.ok(renames.some(([, from, to]) => from.endsWith(".tmp") && !to.endsWith(".tmp")));
  assert.equal([...memory.files.keys()].some((path) => path.endsWith(".tmp")), false);
});

test("concurrent creates all land in the index", async () => {
  const memory = memoryFs();
  let counter = 0;
  const store = createConversationStore(memory.fs, { newId: () => `c${counter++}`, now: () => 500 });
  await Promise.all(Array.from({ length: 8 }, (_value, index) => store.create({ title: `t${index}` })));
  const list = await store.list();
  assert.equal(list.length, 8);
  const index = JSON.parse(memory.files.get("conversations/index.json"));
  assert.equal(index.entries.length, 8);
  assert.equal(new Set(index.entries.map((entry) => entry.id)).size, 8);
});

test("sanitized file names stay distinct for ids that sanitize alike", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  await store.create({ id: "a/b", title: "slash" });
  await store.create({ id: "a-b", title: "dash" });
  const recordFiles = [...memory.files.keys()].filter((path) => path.includes(`/v${AI_CONVERSATION_SCHEMA}_`));
  assert.equal(recordFiles.length, 2);
  assert.equal(new Set(recordFiles).size, 2);
  assert.equal((await store.read("a/b")).title, "slash");
  assert.equal((await store.read("a-b")).title, "dash");
});

test("titles are trimmed, collapsed, defaulted and capped", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  assert.equal((await store.create({ title: "  a   b  " })).title, "a b");
  assert.equal((await store.create({ title: "   " })).title, "未命名会话");
  const long = await store.create({ title: "字".repeat(500) });
  assert.ok(long.title.length <= 120);
});

test("invalid records are rejected with a typed error, not written", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  await assert.rejects(
    store.save({ schema: 1, title: "no id", messages: [] }),
    (error) => error instanceof AiConversationError && error.code === "invalid-record",
  );
});

test("importLegacy accepts the three old shapes and counts what it could not read", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  const result = await store.importLegacy({
    conversations: [
      { id: "old-1", title: "one", messages: [{ role: "user", content: "a" }] },
      { title: "missing id is re-identified", messages: [] },
      { nonsense: true },
    ],
  });
  assert.equal(result.imported, 2, "缺 id 的记录应补一个新 id，而不是被丢弃");
  assert.equal(result.failed, 1);
  assert.equal((await store.list()).length, 2);

  // The same id again is skipped unless the caller asks to overwrite.
  const again = await store.importLegacy([{ id: "old-1", title: "replacement", messages: [] }]);
  assert.deepEqual(again, { imported: 0, skipped: 1, failed: 0, ids: [] });
  const forced = await store.importLegacy([{ id: "old-1", title: "replacement", messages: [] }], { overwrite: true });
  assert.equal(forced.imported, 1);
  assert.equal((await store.read("old-1")).title, "replacement");

  // An id-keyed object is the other shape a hand-rolled store tends to produce.
  const keyed = await store.importLegacy({ "old-2": { id: "old-2", title: "keyed", messages: [] } });
  assert.equal(keyed.imported, 1);
  assert.equal((await store.read("old-2")).title, "keyed");
});

test("meta survives a round trip, and a missing meta is simply absent", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  await store.create({ title: "meta", messages: [] });
  const withMeta = await store.save({ ...(await store.read("a")), meta: { model: "deepseek-flash", tokens: 42 } });
  assert.deepEqual(withMeta.meta, { model: "deepseek-flash", tokens: 42 });
  assert.deepEqual((await store.read("a")).meta, { model: "deepseek-flash", tokens: 42 });
});
// ---------------------------------------------------------------------------
// Schema 2: workspace, pin, per-message operations, and v1 migration
// ---------------------------------------------------------------------------

function messageStore(memory, ids = ["m-1", "m-2", "m-3"]) {
  let counter = 0;
  return createConversationStore(memory.fs, {
    newId: () => "conv",
    now: () => 1000,
    messageId: (message) => message.id,
    // A v1 fixture has messages without ids; the host passes `ensureMessageMeta`,
    // and the test passes the same shape so migration is asserted rather than assumed.
    migrateMessage: (message, index, at) => ({ id: ids[index] ?? `m-${index}`, createdAt: at, status: "active", ...message }),
  });
}

test("create stores the workspace and the summary carries it", async () => {
  const memory = memoryFs();
  const store = makeStore(memory);
  const record = await store.create({ title: "带工作区", workspaceId: "ws-1" });
  assert.equal(record.workspaceId, "ws-1");
  assert.equal((await store.list())[0].workspaceId, "ws-1");
  const plain = await store.create({ title: "未分组" });
  assert.equal(plain.workspaceId, undefined);
});

test("pin only changes the flag, and unpin restores the old order", async () => {
  const memory = memoryFs();
  let clock = 100;
  const store = createConversationStore(memory.fs, {
    newId: (() => {
      const ids = ["one", "two"];
      return () => ids.shift();
    })(),
    now: () => (clock += 10),
  });
  await store.create({ title: "第一个" });
  await store.create({ title: "第二个" });
  const pinned = await store.pin("one", true);
  assert.equal(pinned.pinned, true);
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["one", "two"]);
  await store.pin("one", false);
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["two", "one"]);
  await assert.rejects(store.pin("missing", true), (error) => error.code === "not-found");
});

test("message operations target one message and leave the rest alone", async () => {
  const memory = memoryFs();
  const store = messageStore(memory);
  await store.create({ title: "对话", messages: [{ id: "m-0", role: "user", content: "a" }] });
  await store.appendMessage("conv", { id: "m-1", role: "assistant", content: "b" });
  assert.equal((await store.read("conv")).messages.length, 2);

  const retracted = await store.updateMessage("conv", "m-0", (message) => ({ ...message, status: "retracted" }));
  assert.equal(retracted.messages[0].status, "retracted");
  assert.equal(retracted.messages[1].status, undefined);

  const truncated = await store.truncateAfter("conv", "m-0");
  assert.deepEqual(truncated.messages.map((message) => message.id), ["m-0"]);
  assert.equal(truncated.updatedAt >= truncated.createdAt, true);

  await store.appendMessage("conv", { id: "m-2", role: "assistant", content: "c" });
  const inclusive = await store.truncateAfter("conv", "m-0", { inclusive: true });
  assert.deepEqual(inclusive.messages, []);

  await assert.rejects(store.updateMessage("conv", "nope", (message) => message), (error) => error.code === "not-found");
});

test("a schema 1 file is read, migrates its messages and leaves the original as a backup", async () => {
  const memory = memoryFs();
  const v1 = {
    schema: 1,
    id: "old",
    title: "旧会话",
    createdAt: 5,
    updatedAt: 5,
    pinned: false,
    messages: [
      { role: "user", content: "旧消息" },
      { role: "assistant", content: "旧回复" },
    ],
  };
  memory.files.set("conversations/v1_old.json", JSON.stringify(v1));

  const store = messageStore(memory);
  const info = await store.init();
  assert.equal(info.rebuilt, true);
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["old"]);

  const record = await store.read("old");
  assert.equal(record.messages.length, 2);
  assert.equal(record.messages[0].id, "m-1");
  assert.equal(record.messages[1].status, "active");
  assert.ok(record.messages[1].createdAt > 0);

  const files = [...memory.files.keys()].filter((path) => path.startsWith("conversations/v"));
  assert.ok(files.some((path) => path.startsWith("conversations/v1_old")), "v1 文件保留为备份");
  assert.ok(files.some((path) => path.startsWith("conversations/v2_old")), "迁移写出 v2");
  assert.deepEqual((await store.list()).map((entry) => entry.title), ["旧会话"], "按 id 去重，v2 优先");
});

test("deleting a migrated conversation removes both schema files", async () => {
  const memory = memoryFs();
  memory.files.set("conversations/v1_gone.json", JSON.stringify({ schema: 1, id: "gone", title: "删", messages: [] }));
  const store = messageStore(memory);
  await store.init();
  assert.equal((await store.read("gone")).title, "删");
  assert.equal(await store.remove("gone"), true);
  const leftovers = [...memory.files.keys()].filter((path) => path.includes("gone"));
  assert.deepEqual(leftovers, []);
});

// ---------------------------------------------------------------------------
// Regression: Obsidian's adapter refuses to overwrite, and the index is a cache
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

test("a rewrite still lands when the adapter refuses to overwrite", async () => {
  const memory = memoryFs();
  const store = createConversationStore(strictRenameFs(memory), { newId: () => "a", now: () => 1 });
  await store.create({ title: "one", messages: [{ role: "user", content: "hi" }] });
  await store.rename("a", "two");
  assert.equal((await store.read("a")).title, "two");
  const index = JSON.parse(memory.files.get("conversations/index.json"));
  assert.equal(index.schema, AI_CONVERSATION_SCHEMA);
  assert.equal(index.entries.length, 1);
});

test("an index whose entries vanished rebuilds instead of hiding the records", async () => {
  const memory = memoryFs();
  await makeStore(memory).create({ title: "还在" });
  memory.files.set("conversations/index.json", JSON.stringify({ schema: 1, entries: [] }));
  const store = makeStore(memory);
  const info = await store.init();
  assert.equal(info.rebuilt, true);
  assert.deepEqual((await store.list()).map((entry) => entry.title), ["还在"]);
});
