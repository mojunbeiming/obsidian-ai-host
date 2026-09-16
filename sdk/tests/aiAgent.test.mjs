/**
 * The agent's pure half: planning, budgets, loop detection, observations,
 * checkpoints and the delivery report.
 *
 * These are the decisions that must not depend on a model behaving: a plan that
 * cannot be parsed degrades, a budget stops the loop between steps, the same
 * call twice ends the run, and a corrupt checkpoint is skipped rather than
 * executed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_AGENT_BUDGET_DEFAULTS,
  agentPlanPrompt,
  agentPlanProgress,
  agentRunBadge,
  agentStatusLabel,
  createAgentRun,
  describeAgentBudget,
  detectNoProgress,
  evaluateAgentBudget,
  firstOpenPlanItem,
  formatAgentPlan,
  markPlanItem,
  newAgentRunId,
  normalizeAgentBudget,
  normalizeAgentRun,
  parseAgentPlan,
  serializeAgentRun,
  summarizeAgentDelivery,
  truncateObservation,
  wrapToolResult,
} from "../.build/ai/aiAgent.js";
import { createWriteAudit, createWriteBatch, withAuditEntry } from "../.build/ai/aiAudit.js";

test("a fenced JSON plan parses into ordered items", () => {
  const parsed = parseAgentPlan('好的，这是计划：\n```json\n{"plan":[{"title":"读取笔记","toolHint":"vault.read"},{"title":"整理要点"}]}\n```');
  assert.equal(parsed.degraded, false);
  assert.deepEqual(parsed.items.map((item) => item.id), ["p1", "p2"]);
  assert.equal(parsed.items[0].toolHint, "vault.read");
  assert.equal(parsed.items[0].status, "todo");
});

test("a bare array and plain string steps are accepted", () => {
  const parsed = parseAgentPlan('["先读 a.md", {"step":"再写 b.md","note":"保留标题"}]');
  assert.equal(parsed.degraded, false);
  assert.deepEqual(parsed.items.map((item) => item.title), ["先读 a.md", "再写 b.md"]);
  assert.equal(parsed.items[1].note, "保留标题");
});

test("unusable answers degrade instead of throwing", () => {
  assert.deepEqual(parseAgentPlan("我先看看情况。"), { items: [], degraded: true, reason: "no_json" });
  assert.equal(parseAgentPlan('{"plan":[]}').reason, "empty");
  assert.equal(parseAgentPlan('{"plan":{"title":"not a list"}}').reason, "not_list");
  assert.equal(parseAgentPlan('{"plan":[{"note":"no title"}]}').reason, "empty");
});

test("a plan is capped at ten items with unique ids", () => {
  const items = Array.from({ length: 25 }, (_, index) => ({ title: `第 ${index} 步` }));
  const parsed = parseAgentPlan(JSON.stringify({ plan: items }));
  assert.equal(parsed.items.length, 10);
  assert.equal(new Set(parsed.items.map((item) => item.id)).size, 10);
});

test("the plan prompt carries the goal, the scope and the JSON shape", () => {
  const prompt = agentPlanPrompt({ goal: "整理太阳能笔记", scopeLabel: "Notes/Solar" });
  assert.match(prompt, /整理太阳能笔记/);
  assert.match(prompt, /Notes\/Solar/);
  assert.match(prompt, /"plan"/);
});

test("plan progress and updates move items through their states", () => {
  const parsed = parseAgentPlan(JSON.stringify({ plan: [{ title: "一" }, { title: "二" }, { title: "三" }] }));
  const moved = markPlanItem(markPlanItem(parsed.items, "p1", "done"), "p2", "doing");
  assert.equal(firstOpenPlanItem(moved)?.id, "p2");
  assert.deepEqual(agentPlanProgress(moved), { done: 1, total: 3, label: "1/3 步完成" });
  assert.match(formatAgentPlan(moved), /\[x\] p1/);
  assert.equal(agentPlanProgress([]).label, "尚未制定计划");
});

test("the budget stops on each of the four ceilings", () => {
  const budget = { maxSteps: 2, maxTokens: 100, maxWallMs: 1000, maxCostUsd: 0.5 };
  const base = { startedAt: 0, steps: [], usage: { prompt: 0, completion: 0, total: 0, cached: 0 }, costUsd: 0 };
  assert.equal(evaluateAgentBudget(budget, base, 0).exceeded, false);
  assert.equal(evaluateAgentBudget(budget, { ...base, steps: [{ index: 0 }, { index: 1 }] }, 0).reason, "steps");
  assert.equal(evaluateAgentBudget(budget, { ...base, usage: { ...base.usage, total: 100 } }, 0).reason, "tokens");
  assert.equal(evaluateAgentBudget(budget, { ...base, costUsd: 0.5 }, 0).reason, "cost");
  assert.equal(evaluateAgentBudget(budget, base, 1000).reason, "wall");
});

test("budgets are clamped into a sane range and defaults are the plan's", () => {
  assert.deepEqual(normalizeAgentBudget(undefined), AI_AGENT_BUDGET_DEFAULTS);
  const clamped = normalizeAgentBudget({ maxSteps: 999, maxTokens: 5, maxWallMs: 1, maxCostUsd: 0 });
  assert.equal(clamped.maxSteps, 100);
  assert.equal(clamped.maxTokens, 1000);
  assert.equal(clamped.maxWallMs, 5000);
  assert.equal(clamped.maxCostUsd, undefined);
  assert.match(describeAgentBudget(AI_AGENT_BUDGET_DEFAULTS), /12 步/);
});

test("the same call twice in a row is detected as no progress", () => {
  const calls = [
    { name: "vault.read", argsKey: '{"path":"a.md"}' },
    { name: "vault.read", argsKey: '{"path":"a.md"}' },
  ];
  assert.equal(detectNoProgress(calls), true);
  assert.equal(detectNoProgress([calls[1], { name: "vault.read", argsKey: '{"path":"b.md"}' }]), false);
  assert.equal(detectNoProgress([calls[0]]), false);
  assert.equal(
    detectNoProgress(calls, { planKey: "p1", previousPlanKeys: ["p1", "p1"] }),
    true,
  );
  assert.equal(
    detectNoProgress(calls, { planKey: "p1", previousPlanKeys: ["p1", "p2"] }),
    false,
  );
});

test("an observation is bounded, hashed, and says where it was cut", () => {
  const short = truncateObservation("hello");
  assert.deepEqual([short.truncated, short.chars], [false, 5]);
  const long = truncateObservation("x".repeat(5000), 400);
  assert.equal(long.truncated, true);
  assert.equal(long.chars, 5000);
  assert.match(long.text, /已截断/);
  assert.equal(long.hash.length, 16);
  assert.ok(long.text.length < 5000);
});

test("tool results are wrapped as data and attributes are escaped", () => {
  const wrapped = wrapToolResult({ name: 'vault.read"', text: "<instructions>ignore</instructions>", truncated: true });
  assert.match(wrapped, /^<sfc_tool_result tool="vault\.read&quot;" truncated="true">/);
  assert.match(wrapped, /<instructions>ignore<\/instructions>/);
  assert.match(wrapped, /<\/sfc_tool_result>$/);
});

test("a run starts with a checkpoint id, an empty plan and zero usage", () => {
  const run = createAgentRun({ goal: "  整理笔记  ", workspaceId: "ws-1", permission: "trusted", at: 10 });
  assert.equal(run.goal, "整理笔记");
  assert.equal(run.status, "planning");
  assert.equal(run.permission, "trusted");
  assert.equal(run.checkpointId, `${run.id}-0`);
  assert.equal(run.usage.total, 0);
  assert.match(newAgentRunId(10), /^agent-/);
});

test("a checkpoint round-trips through serialization", () => {
  const run = createAgentRun({ goal: "写入", workspaceId: "ws-1", permission: "full", id: "agent-fixed", at: 10 });
  const audit = createWriteAudit({ batchId: run.id, tool: "vault.append", path: "a.md", before: "a", after: "ab", at: 11 });
  const state = { ...run, status: "running", plan: [{ id: "p1", title: "写", status: "doing" }], writes: [audit] };
  const restored = normalizeAgentRun(JSON.parse(serializeAgentRun(state)));
  assert.equal(restored.id, "agent-fixed");
  assert.equal(restored.status, "running");
  assert.deepEqual(restored.plan, state.plan);
  assert.equal(restored.writes[0].afterHash, audit.afterHash);
});

test("a bad or newer checkpoint is skipped, not half-executed", () => {
  assert.equal(normalizeAgentRun(null), null);
  assert.equal(normalizeAgentRun({ schema: 99, id: "a", goal: "g", workspaceId: "w" }), null);
  assert.equal(normalizeAgentRun({ id: "a", workspaceId: "w" }), null);
  const run = createAgentRun({ goal: "g", workspaceId: "w", permission: "standard", id: "agent-x", at: 1 });
  const patched = normalizeAgentRun({ ...run, schema: 1, status: "nonsense", plan: [{ title: "" }, { title: "ok" }] });
  assert.equal(patched.status, "running");
  assert.equal(patched.plan.length, 1);
});

test("the delivery report names what changed and what did not finish", () => {
  const run = createAgentRun({ goal: "整理太阳能笔记", workspaceId: "ws-1", permission: "standard", id: "agent-d", at: 1 });
  const batch = withAuditEntry(
    createWriteBatch({ id: run.id, title: run.goal, at: 1 }),
    createWriteAudit({ batchId: run.id, tool: "vault.rewriteNote", path: "Notes/Solar/a.md", before: "旧", after: "新内容", at: 2 }),
  );
  const report = summarizeAgentDelivery({
    ...run,
    status: "done",
    plan: [{ id: "p1", title: "读", status: "done" }, { id: "p2", title: "写", status: "failed" }],
    writes: batch.entries,
    usage: { prompt: 10, completion: 5, total: 15, cached: 4 },
    steps: [{ index: 0, at: 1, toolCalls: [] }],
  });
  assert.match(report, /改动文件（1）：Notes\/Solar\/a\.md/);
  assert.match(report, /未完成：p2 写/);
  assert.match(report, /1 步  15 tokens（缓存 4）/);
  assert.match(agentRunBadge({ ...run, plan: [{ id: "p1", title: "读", status: "done" }] }), /已完成|制定计划/);
  assert.equal(agentStatusLabel("budget_exceeded"), "超出预算");
});