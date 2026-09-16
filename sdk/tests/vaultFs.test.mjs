/**
 * The mobile filesystem bridge: synchronous `FsShim` over an async adapter.
 *
 * The behaviour that matters is the one the stores rely on: writes are visible
 * synchronously, reach the adapter in order, and survive an adapter that refuses
 * to rename over an existing file (Obsidian mobile's does).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createVaultFs } from "../.build/vaultFs.js";
import { readSnapshot, writeSnapshot, readLines, appendRecord } from "../.build/persist.js";

/** An async adapter with Obsidian's refusal to overwrite on rename. */
function memoryAdapter(initial = {}) {
  const files = new Map(Object.entries(initial));
  const log = [];
  const adapter = {
    async mkdir(path) {
      log.push(["mkdir", path]);
    },
    async list(path) {
      const prefix = `${path}/`;
      const filesHere = [];
      const foldersHere = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes("/")) {
          const folder = `${prefix}${rest.slice(0, rest.indexOf("/"))}`;
          if (!foldersHere.includes(folder)) foldersHere.push(folder);
        } else {
          filesHere.push(key);
        }
      }
      return { files: filesHere, folders: foldersHere };
    },
    async read(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    async write(path, content) {
      files.set(path, content);
      log.push(["write", path]);
    },
    async append(path, content) {
      files.set(path, `${files.get(path) ?? ""}${content}`);
      log.push(["append", path]);
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      if (files.has(to)) throw new Error("Destination file already exists!");
      files.set(to, files.get(from));
      files.delete(from);
      log.push(["rename", from, to]);
    },
    async remove(path) {
      files.delete(path);
      log.push(["remove", path]);
    },
    async exists(path) {
      return files.has(path);
    },
    async stat(path) {
      return files.has(path) ? { mtime: 42 } : null;
    },
  };
  return { files, log, adapter };
}

const DIR = ".obsidian/plugins/sfc-test";

test("existing files are preloaded and served synchronously", async () => {
  const memory = memoryAdapter({
    [`${DIR}/data.json`]: '{"version":1}',
    [`${DIR}/reviews.jsonl`]: '{"id":1}\n',
  });
  const vault = await createVaultFs(memory.adapter, DIR);
  assert.equal(vault.shim.exists(`${DIR}/data.json`), true);
  assert.equal(vault.shim.readFile(`${DIR}/data.json`), '{"version":1}');
  assert.equal(vault.shim.mtime(`${DIR}/data.json`), 42);
  assert.equal(vault.shim.exists(`${DIR}/missing.json`), false);
  assert.equal(vault.shim.readFile(`${DIR}/missing.json`), null);
});

test("snapshots round-trip and land on the adapter after flush", async () => {
  const memory = memoryAdapter();
  const vault = await createVaultFs(memory.adapter, DIR);
  writeSnapshot(vault.shim, `${DIR}/data.json`, { version: 1, cards: [] });
  assert.deepEqual(readSnapshot(vault.shim, `${DIR}/data.json`), { kind: "ok", data: { version: 1, cards: [] } });
  await vault.flush();
  assert.equal(memory.files.get(`${DIR}/data.json`), JSON.stringify({ version: 1, cards: [] }, null, 2));
  assert.equal(vault.pending(), 0);
});

test("a second snapshot replaces the file even when rename refuses to overwrite", async () => {
  const memory = memoryAdapter();
  const vault = await createVaultFs(memory.adapter, DIR);
  writeSnapshot(vault.shim, `${DIR}/data.json`, { n: 1 });
  await vault.flush();
  writeSnapshot(vault.shim, `${DIR}/data.json`, { n: 2 });
  await vault.flush();
  assert.deepEqual(JSON.parse(memory.files.get(`${DIR}/data.json`)), { n: 2 });
});

test("appends are ordered and readable through the shim", async () => {
  const memory = memoryAdapter();
  const vault = await createVaultFs(memory.adapter, DIR);
  appendRecord(vault.shim, `${DIR}/reviews.jsonl`, { id: 1 });
  appendRecord(vault.shim, `${DIR}/reviews.jsonl`, { id: 2 });
  assert.deepEqual(readLines(vault.shim, `${DIR}/reviews.jsonl`).map((entry) => entry.id), [1, 2]);
  await vault.flush();
  assert.equal(memory.files.get(`${DIR}/reviews.jsonl`), '{"id":1}\n{"id":2}\n');
});

test("rename moves the cached content and removes the source on disk", async () => {
  const memory = memoryAdapter({ [`${DIR}/a.json`]: "A" });
  const vault = await createVaultFs(memory.adapter, DIR);
  vault.shim.rename(`${DIR}/a.json`, `${DIR}/b.json`);
  assert.equal(vault.shim.exists(`${DIR}/a.json`), false);
  assert.equal(vault.shim.readFile(`${DIR}/b.json`), "A");
  await vault.flush();
  assert.equal(memory.files.has(`${DIR}/a.json`), false);
  assert.equal(memory.files.get(`${DIR}/b.json`), "A");
});

test("a corrupt snapshot is backed up through the bridge, not lost", async () => {
  const memory = memoryAdapter({ [`${DIR}/data.json`]: "{not json" });
  const vault = await createVaultFs(memory.adapter, DIR);
  const outcome = readSnapshot(vault.shim, `${DIR}/data.json`);
  assert.equal(outcome.kind, "corrupt");
  assert.ok(outcome.backup.startsWith(`${DIR}/data.json.corrupt-`));
  assert.equal(vault.shim.readFile(outcome.backup), "{not json");
  await vault.flush();
  assert.equal(memory.files.has(`${DIR}/data.json`), false);
  assert.equal(memory.files.get(outcome.backup), "{not json");
});