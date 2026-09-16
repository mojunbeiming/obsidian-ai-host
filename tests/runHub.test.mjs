/**
 * The host run hub with a fake store: lifecycle, error deduplication, the
 * "crashed last run" recovery, and retention pass-through.
 *
 * The real store is covered by `sdk/tests/aiRunLog.test.mjs`; this suite is
 * about the hub's policy, not about JSON files.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { RunHub } from "../.build/runHub.js";

function fakeStore(initial = []) {
  const records = new Map(initial.map((record) => [record.id, record]));
  const saved = [];
  const retention = [];
  return {
    records,
    saved,
    retention,
    store: {
      async init() {
        return { rebuilt: false, skipped: [] };
      },
      async save(record) {
        records.set(record.id, record);
        saved.push(record.id);
      },
      async list() {
        return [...records.values()];
      },
      async read(id) {
        return records.get(id) ?? null;
      },
      async remove(id) {
        return records.delete(id);
      },
      async clear() {
        records.clear();
      },
      async rebuildIndex() {
        return { rebuilt: false, skipped: [] };
      },
      setRetention(policy) {
        retention.push(policy);
      },
    },
  };
}

function book(overrides = {}) {
  return {
    schema: 1,
    id: "run-1",
    pluginId: "sfc-ai",
    kind: "chat",
    title: "一次聊天",
    startedAt: 1000,
    status: "ok",
    steps: [],
    errors: [],
    ...overrides,
  };
}

test("begin, step and finish persist once, and expose the summary while running", async () => {
  const fake = fakeStore();
  const hub = new RunHub({ store: fake.store, now: () => 1000 });
  await hub.init();
  const runId = hub.begin({ pluginId: "sfc-ai", kind: "chat", title: "聊天" });
  assert.equal(hub.runningCount, undefined);
  assert.equal((await hub.list()).length, 1);
  assert.equal((await hub.list())[0].status, "running");
  hub.step(runId, { kind: "request", title: "请求" });
  const finished = await hub.finish(runId, { status: "ok", summary: "完成", usage: { prompt: 1, completion: 2, total: 3 } });
  assert.equal(finished.status, "ok");
  assert.equal(finished.steps.length, 1);
  assert.deepEqual(fake.saved, [runId], "运行中不落盘，只在 finish 时写一次");
  assert.equal((await hub.read(runId)).summary, "完成");
});

test("the same error merges inside the window; a different code does not", async () => {
  const fake = fakeStore();
  const hub = new RunHub({ store: fake.store, now: () => 5000, dedupWindowMs: 60_000 });
  await hub.init();
  const runId = hub.begin({ pluginId: "sfc-ai", kind: "chat", title: "聊天" });
  const first = hub.error(runId, Object.assign(new Error("busy"), { status: 429 }));
  const second = hub.error(runId, Object.assign(new Error("busy"), { status: 429 }));
  const third = hub.error(runId, new Error("broken pipe"));
  assert.equal(first.code, "AI_RATE_LIMIT");
  assert.equal(second, null, "重复错误只记一次");
  assert.equal(third.code, "AI_INTERNAL");
  const record = await hub.finish(runId, { status: "failed", summary: "限流" });
  assert.equal(record.errors.length, 2);
  assert.equal(record.steps.filter((step) => step.kind === "error").length, 2);
});

test("finish without an explicit error classifies the last error step", async () => {
  const fake = fakeStore();
  const hub = new RunHub({ store: fake.store, now: () => 5000 });
  await hub.init();
  const runId = hub.begin({ pluginId: "sfc-todo", kind: "skill", title: "规划" });
  hub.step(runId, { kind: "error", level: "error", status: "failed", title: "AI_PARSE：模型回复无法解析", detail: "HTTP 200" });
  const record = await hub.finish(runId, { status: "failed", summary: "解析失败" });
  assert.equal(record.errors.length, 1);
  assert.equal(record.errors[0].code, "AI_PARSE");
});

test("a run left running by a crash becomes a failed, interrupted record on init", async () => {
  const fake = fakeStore([book({ id: "crashed", status: "running", endedAt: undefined })]);
  const hub = new RunHub({ store: fake.store, now: () => 9000 });
  await hub.init();
  const record = fake.records.get("crashed");
  assert.equal(record.status, "failed");
  assert.equal(record.interrupted, true);
  assert.equal(record.errors.length, 1);
  assert.ok(record.summary.includes("中断"));
});

test("setRetention is passed through to the store", async () => {
  const fake = fakeStore();
  const hub = new RunHub({ store: fake.store });
  hub.setRetention({ maxRuns: 5 });
  assert.deepEqual(fake.retention, [{ maxRuns: 5 }]);
});