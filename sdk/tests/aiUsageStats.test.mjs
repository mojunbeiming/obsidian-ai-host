/**
 * The composer's numbers. A wrong cache hit rate is worse than no hit rate, so
 * "the provider did not report a cache" must stay distinguishable from "the
 * cache did nothing".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addUsage,
  cacheHitRate,
  emptyTokenTotals,
  formatComposerStats,
  formatPercent,
  formatTokenCount,
} from "../.build/ai/aiUsageStats.js";

test("usage accumulates field by field and ignores nonsense", () => {
  let totals = emptyTokenTotals();
  totals = addUsage(totals, { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 });
  totals = addUsage(totals, { promptTokens: 50, completionTokens: 10, totalTokens: 60 });
  totals = addUsage(totals, { promptTokens: -5, completionTokens: Number.NaN, totalTokens: 0 });
  assert.deepEqual(totals, { prompt: 150, completion: 30, total: 180, cached: 40 });
});

test("cached tokens can never exceed the prompt they are a subset of", () => {
  const totals = addUsage(emptyTokenTotals(), { promptTokens: 10, completionTokens: 1, totalTokens: 11, cachedTokens: 99 });
  assert.equal(totals.cached, 10);
});

test("the hit rate is null when no cache was reported, never 0%", () => {
  assert.equal(cacheHitRate(emptyTokenTotals()), null);
  assert.equal(cacheHitRate(addUsage(emptyTokenTotals(), { promptTokens: 100, completionTokens: 1, totalTokens: 101 })), null);
  assert.equal(cacheHitRate(addUsage(emptyTokenTotals(), { promptTokens: 100, completionTokens: 1, totalTokens: 101, cachedTokens: 25 })), 0.25);
});

test("token counts and percentages render the way the status line reads", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(940), "940");
  assert.equal(formatTokenCount(1234), "1.2k");
  assert.equal(formatTokenCount(12_345), "12k");
  assert.equal(formatTokenCount(2_500_000), "2.5M");
  assert.equal(formatPercent(0.426), "43%");
  assert.equal(formatPercent(2), "100%");
});

test("the composer line shows rounds, steps, both totals and the cost", () => {
  const run = addUsage(emptyTokenTotals(), { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cachedTokens: 500 });
  const session = addUsage(run, { promptTokens: 3000, completionTokens: 400, totalTokens: 3400, cachedTokens: 1500 });
  const line = formatComposerStats({ rounds: 3, steps: 5, run, session, costUsd: 0.0123 });
  assert.match(line, /^3 轮  5 步  本次 1\.2k tokens  累计 4\.6k tokens  缓存 50%  \$0\.0123（估算）$/);
});

test("a plain chat hides the step count and an unknown cache", () => {
  const run = addUsage(emptyTokenTotals(), { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  const line = formatComposerStats({ rounds: 1, steps: 0, run, session: run, costUsd: null });
  assert.equal(line, "1 轮  本次 15 tokens  累计 15 tokens");
});