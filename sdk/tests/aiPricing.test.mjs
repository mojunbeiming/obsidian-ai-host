import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateCostUsd, formatCost, normalizeModel } from "../.build/ai/aiPricing.js";

test("a known model's cost is input and output priced separately", () => {
  const cost = estimateCostUsd("gpt-4o-mini", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.ok(cost);
  assert.ok(Math.abs(cost.usd - 0.75) < 1e-9);
});

test("a provider prefix is stripped before the lookup", () => {
  assert.equal(normalizeModel("deepseek-oracle/deepseek-flash"), "deepseek-flash");
  const cost = estimateCostUsd("deepseek/flash/gpt-4o-mini", { promptTokens: 1_000_000, completionTokens: 0 });
  assert.ok(cost && Math.abs(cost.usd - 0.15) < 1e-9);
});

test("an unknown model reports unknown instead of guessing", () => {
  assert.equal(estimateCostUsd("some-new-model", { promptTokens: 100, completionTokens: 100 }), null);
  assert.equal(formatCost(null).includes("未知"), true);
});

test("a local model is free with an explanation", () => {
  const cost = estimateCostUsd("ollama/qwen2.5-vl", { promptTokens: 10_000, completionTokens: 10_000 });
  assert.ok(cost);
  assert.equal(cost.usd, 0);
  assert.equal(formatCost(cost).includes("本机"), true);
});