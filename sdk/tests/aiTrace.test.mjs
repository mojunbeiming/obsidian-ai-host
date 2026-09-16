/**
 * The run trace: steps, copies, redaction, recent-run trimming.
 *
 * The redaction test is the important one. A trace's whole purpose is to be
 * copied into a bug report, and a copied log that carries the API key is a worse
 * outcome than an unreadable log.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRunTrace, keepRecentRuns, redactText, traceToText } from "../.build/aiTrace.js";

test("a run records ordered steps and finishes once", () => {
  let tick = 0;
  const trace = createRunTrace({ now: () => (tick += 1000), id: "run-test" });
  trace.push("context.read", "读取 2 篇笔记", { detail: "a.md\nb.md", meta: { files: 2 } });
  trace.push("request", "POST https://api.example/v1/chat/completions", { meta: { model: "m" } });
  trace.finish("ok", "填入 1 张草稿");
  trace.finish("failed", "再来一次不应覆盖");
  const snapshot = trace.snapshot();
  assert.equal(snapshot.id, "run-test");
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.summary, "填入 1 张草稿");
  assert.equal(snapshot.steps.length, 2);
  assert.ok(snapshot.endedAt >= snapshot.startedAt);
});

test("snapshot is a copy, so a reader cannot mutate the run", () => {
  const trace = createRunTrace({ id: "run-copy" });
  trace.push("done", "完成", { meta: { count: 1 } });
  const first = trace.snapshot();
  first.steps[0].title = "改掉了";
  first.steps[0].meta.count = 99;
  const second = trace.snapshot();
  assert.equal(second.steps[0].title, "完成");
  assert.equal(second.steps[0].meta.count, 1);
});

test("subscribe fires on push and finish, and a throwing listener is contained", () => {
  const trace = createRunTrace({ id: "run-sub" });
  let fired = 0;
  trace.subscribe(() => fired += 1);
  trace.subscribe(() => { throw new Error("boom"); });
  trace.push("done", "一");
  trace.finish("ok");
  assert.equal(fired, 2);
});

test("redactText masks api keys, bearer tokens and key-value secrets", () => {
  assert.match(redactText("key=sk-1234567890abcdef"), /sk-\*+/);
  assert.doesNotMatch(redactText("key=sk-1234567890abcdef"), /1234567890/);
  assert.match(redactText("Authorization: Bearer abcdef123456"), /Bearer \*\*\*/);
  assert.match(redactText('{"apiKey":"abcdef123456"}'), /"apiKey":"\*\*\*/);
  assert.equal(redactText("普通内容不会被动"), "普通内容不会被动");
});

test("keepRecentRuns keeps the newest runs up to the limit", () => {
  const runs = [
    { id: "old", startedAt: 1 },
    { id: "new", startedAt: 3 },
    { id: "mid", startedAt: 2 },
  ];
  assert.deepEqual(keepRecentRuns(runs, 2).map((run) => run.id), ["new", "mid"]);
  assert.deepEqual(keepRecentRuns(runs, 0), []);
});

test("traceToText is a copyable log with the detail indented", () => {
  const trace = createRunTrace({ now: () => 0, id: "run-text" });
  trace.push("error", "失败了", { detail: "第一行\n第二行" });
  trace.finish("failed", "看错误");
  const text = traceToText(trace.snapshot());
  assert.match(text, /run-text/);
  assert.match(text, /失败了/);
  assert.match(text, /    第一行/);
  assert.match(text, /看错误/);
});

test("the mirror hooks see every step and the final snapshot", () => {
  const steps = [];
  let finished = null;
  const trace = createRunTrace({ onStep: (step) => steps.push(step.kind), onFinish: (snapshot) => (finished = snapshot) });
  trace.push("request", "请求");
  trace.push("parse", "解析");
  trace.finish("ok", "完成");
  assert.deepEqual(steps, ["request", "parse"]);
  assert.equal(finished.status, "ok");
  assert.equal(finished.steps.length, 2);
});

test("a throwing mirror cannot break the run", () => {
  const trace = createRunTrace({ onStep: () => { throw new Error("mirror down"); }, onFinish: () => { throw new Error("mirror down"); } });
  trace.push("request", "请求");
  trace.finish("ok", "完成");
  assert.equal(trace.snapshot().status, "ok");
});
