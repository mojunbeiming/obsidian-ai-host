import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DebouncedWriter,
  appendRecord,
  readLines,
  readSnapshot,
  writeSnapshot,
} from "../.build/persist.js";
import { memoryFs } from "./_fs.mjs";

test("a snapshot round-trips through JSON", () => {
  const fs = memoryFs();
  writeSnapshot(fs, "data.json", { cards: [{ id: "a" }], settings: { newPerDay: 20 } });
  const result = readSnapshot(fs, "data.json");
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.data.cards, [{ id: "a" }]);
});

test("writing is atomic: no temp file survives and the target is replaced", () => {
  const fs = memoryFs();
  writeSnapshot(fs, "data.json", { v: 1 });
  writeSnapshot(fs, "data.json", { v: 2 });
  assert.equal(fs.exists("data.json.tmp"), false);
  assert.deepEqual(readSnapshot(fs, "data.json").data, { v: 2 });
});

test("a missing snapshot reads as missing, not as corrupt", () => {
  const fs = memoryFs();
  const result = readSnapshot(fs, "data.json");
  assert.equal(result.kind, "missing");
  assert.equal(result.data, null);
});

test("an empty snapshot file is treated as missing", () => {
  const fs = memoryFs();
  fs.writeFile("data.json", "   \n");
  assert.equal(readSnapshot(fs, "data.json").kind, "missing");
});

test("a corrupt snapshot is backed up, never silently discarded", () => {
  // Losing a user's scheduling history because one write was interrupted is
  // the worst possible outcome; a rename keeps the bytes for inspection.
  const fs = memoryFs();
  fs.writeFile("data.json", "{ this is not json");
  const result = readSnapshot(fs, "data.json");
  assert.equal(result.kind, "corrupt");
  assert.equal(result.data, null);
  assert.match(result.error.length > 0 ? "y" : "n", /y/);
  assert.ok(result.backup.startsWith("data.json.corrupt-"), result.backup);
  assert.equal(fs.readFile(result.backup), "{ this is not json");
  // The bad file is moved aside so the next write starts clean.
  assert.equal(fs.exists("data.json"), false);
});

test("a snapshot that is valid JSON but not an object is corrupt", () => {
  const fs = memoryFs();
  fs.writeFile("data.json", "42");
  assert.equal(readSnapshot(fs, "data.json").kind, "corrupt");
});

test("JSONL appends accumulate and read back in order", () => {
  const fs = memoryFs();
  appendRecord(fs, "reviews.jsonl", { id: "a", day: "2026-03-04" });
  appendRecord(fs, "reviews.jsonl", { id: "b", day: "2026-03-05" });
  const rows = readLines(fs, "reviews.jsonl");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "a");
  assert.equal(rows[1].id, "b");
});

test("a half-written last line is skipped instead of losing the whole file", () => {
  // This is the entire reason history is JSONL and not one big JSON blob: a
  // process killed mid-append costs one record, not all of them.
  const fs = memoryFs();
  fs.writeFile(
    "reviews.jsonl",
    '{"id":"a","day":"2026-03-04"}\n{"id":"b","day":"2026-03-0',
  );
  const rows = readLines(fs, "reviews.jsonl");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "a");
});

test("blank lines and stray whitespace do not become records", () => {
  const fs = memoryFs();
  fs.writeFile("reviews.jsonl", '\n{"id":"a"}\n\n   \n{"id":"b"}\n');
  assert.deepEqual(readLines(fs, "reviews.jsonl").map((row) => row.id), ["a", "b"]);
});

test("readLines dedupes on a key, keeping the first occurrence", () => {
  const fs = memoryFs();
  fs.writeFile(
    "reviews.jsonl",
    '{"id":"a","v":1}\n{"id":"a","v":2}\n{"id":"b","v":3}\n',
  );
  const rows = readLines(fs, "reviews.jsonl", { dedupeBy: "id" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].v, 1);
});

test("reading a JSONL file that does not exist yields an empty list", () => {
  assert.deepEqual(readLines(memoryFs(), "nope.jsonl"), []);
});

test("DebouncedWriter collapses a burst into one write", async () => {
  let writes = 0;
  const writer = new DebouncedWriter(() => {
    writes += 1;
  }, 10);
  writer.schedule();
  writer.schedule();
  writer.schedule();
  assert.equal(writes, 0, "should not write synchronously");
  assert.equal(writer.pending, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writes, 1);
  assert.equal(writer.pending, false);
});

test("an explicit flush writes immediately and cancels the pending timer", async () => {
  let writes = 0;
  const writer = new DebouncedWriter(() => {
    writes += 1;
  }, 10_000);
  writer.schedule();
  writer.flush();
  assert.equal(writes, 1);
  // The scheduled timer must not fire a second write later.
  await new Promise((resolve) => setTimeout(resolve, 20));
  writer.flush();
  assert.equal(writes, 1);
});

test("a flush with nothing pending writes nothing", () => {
  let writes = 0;
  const writer = new DebouncedWriter(() => {
    writes += 1;
  }, 10);
  writer.flush();
  assert.equal(writes, 0);
});