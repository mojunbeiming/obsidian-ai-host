/**
 * The connectivity tracker.
 *
 * This exists because of a real report: "after I paste my API key, the card centre
 * does not update whether I am connected". Nothing was wrong with the request --
 * nothing was ever asking. These tests pin the four properties that make asking
 * safe to do automatically: one probe at a time, a verdict keyed to the
 * configuration, failures kept as verdicts, and staleness rather than silence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AiStatusTracker, AI_STATUS_STALE_MS, isFresh, statusKey, verdictAge } from "../.build/aiStatus.js";

/** A probe that counts its calls and can be made slow or failing. */
function scriptedProbe(script = []) {
  let calls = 0;
  const probe = async () => {
    calls += 1;
    const next = script.shift();
    if (next instanceof Error) throw next;
    return { message: next ?? "ok", endpoint: "https://x", model: "m" };
  };
  return { probe, calls: () => calls };
}

const KEY = statusKey({ provider: "deepseek", baseUrl: "https://x", protocol: "", model: "m", apiKey: "k" });

test("a verdict is taken once and then reused", async () => {
  const { probe, calls } = scriptedProbe(["已连通"]);
  const tracker = new AiStatusTracker(probe);
  await tracker.check(KEY);
  await tracker.check(KEY);
  await tracker.check(KEY);
  assert.equal(calls(), 1, "同一次配置只应发一次请求");
  assert.equal(tracker.snapshot(KEY).verdict.ok, true);
  assert.equal(tracker.snapshot(KEY).fresh, true);
});

test("force re-asks, which is what the 重新检测 button means", async () => {
  const { probe, calls } = scriptedProbe(["第一次", "第二次"]);
  const tracker = new AiStatusTracker(probe);
  await tracker.check(KEY);
  await tracker.check(KEY, { force: true });
  assert.equal(calls(), 2);
  assert.match(tracker.snapshot(KEY).verdict.message, /第二次/);
});

test("a failure is kept as a verdict, not thrown away", async () => {
  // "Not connected, because X" is exactly what the panel has to show; dropping it
  // would leave the status line reading "还没有检测过" after a failed check.
  const { probe } = scriptedProbe([new Error("API Key 被拒绝了（401）")]);
  const tracker = new AiStatusTracker(probe);
  await tracker.check(KEY);
  const verdict = tracker.snapshot(KEY).verdict;
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /API Key 被拒绝了/);
});

test("a different configuration drops the old verdict instead of showing it", async () => {
  // The report that started this: a verdict about the old key presented as if it
  // were about the new one reads as "it connected" when nothing has been checked.
  const { probe } = scriptedProbe(["旧配置通了"]);
  const tracker = new AiStatusTracker(probe);
  await tracker.check(KEY);
  const other = statusKey({ provider: "openai", baseUrl: "https://y", protocol: "", model: "m2", apiKey: "k2" });
  const after = tracker.snapshot(other);
  assert.equal(after.verdict, null, "换配置后不应当还显示上一个配置的结论");
  assert.equal(after.fresh, false);
});

test("concurrent callers share one request", async () => {
  // Every trigger does this: the studio panel, the settings row and the planner
  // dialog all render from the same redraw. Without the in-flight map, a status
  // indicator becomes a way to hammer the endpoint.
  let calls = 0;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tracker = new AiStatusTracker(async () => {
    calls += 1;
    await gate;
    return { message: "ok", endpoint: "", model: "" };
  });
  const all = Promise.all([tracker.check(KEY), tracker.check(KEY), tracker.check(KEY)]);
  release();
  await all;
  assert.equal(calls, 1, "三个并发调用者应当共用一个请求");
  void release;
});

test("checking is visible while a probe is in flight", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tracker = new AiStatusTracker(async () => {
    await gate;
    return { message: "ok", endpoint: "", model: "" };
  });
  assert.equal(tracker.snapshot(KEY).checking, false);
  const running = tracker.check(KEY);
  assert.equal(tracker.snapshot(KEY).checking, true);
  release();
  await running;
  assert.equal(tracker.snapshot(KEY).checking, false);
});

test("a stale verdict is reported as not fresh without being discarded", async () => {
  // Staleness is not wrongness: the panel says what it last saw and starts a new
  // check. Blanking the status on a timer would make a working connection look
  // intermittent.
  const { probe } = scriptedProbe(["ok"]);
  const tracker = new AiStatusTracker(probe);
  await tracker.check(KEY);
  const verdict = tracker.snapshot(KEY).verdict;
  const later = verdict.at + AI_STATUS_STALE_MS + 1;
  assert.equal(isFresh(verdict, later), false);
  assert.equal(verdictAge(verdict, later), AI_STATUS_STALE_MS + 1);
  assert.equal(tracker.snapshot(KEY, later).verdict.ok, true, "过期的结论仍然显示，只是标记为不新鲜");
  assert.equal(tracker.snapshot(KEY, later).fresh, false);
});

test("invalidate makes the next render re-ask, which is what a settings edit needs", async () => {
  const { probe, calls } = scriptedProbe(["一", "二"]);
  const tracker = new AiStatusTracker(probe);
  await tracker.check(KEY);
  tracker.invalidate();
  assert.equal(tracker.snapshot(KEY).verdict, null);
  await tracker.check(KEY);
  assert.equal(calls(), 2);
});

test("the status key includes everything that could change the answer", () => {
  const base = { provider: "p", baseUrl: "https://x", protocol: "openai", model: "m", apiKey: "k" };
  const keys = [
    statusKey(base),
    statusKey({ ...base, provider: "q" }),
    statusKey({ ...base, baseUrl: "https://y" }),
    statusKey({ ...base, protocol: "anthropic" }),
    statusKey({ ...base, model: "m2" }),
    statusKey({ ...base, apiKey: "k2" }),
  ];
  assert.equal(new Set(keys).size, keys.length, "改任何一项都应当换一个 key");
  assert.equal(statusKey(base), statusKey({ ...base }), "同样的配置应当得到同样的 key");
});

test("subscribers hear about every state change", async () => {
  const { probe } = scriptedProbe(["ok"]);
  const tracker = new AiStatusTracker(probe);
  let heard = 0;
  const off = tracker.subscribe(() => {
    heard += 1;
  });
  await tracker.check(KEY);
  assert.ok(heard >= 2, `应当至少听到「开始检测」与「有结论」两次，实际 ${heard}`);
  off();
  tracker.invalidate();
  const after = heard;
  tracker.invalidate();
  assert.equal(heard, after, "退订之后不应当再收到通知");
});
