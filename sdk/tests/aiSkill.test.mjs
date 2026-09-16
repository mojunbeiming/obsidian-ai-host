/**
 * The skill contract: ids, versions, and the two failure modes that must hide a
 * skill instead of running it (a newer contract, or a host that is too old).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_SKILL_API_VERSION, checkSkillDefinition } from "../.build/ai/aiSkill.js";

function skill(overrides = {}) {
  return {
    id: "flashcards.makeCards",
    version: 1,
    minHostVersion: 1,
    title: "制卡",
    description: "从材料生成卡片草稿",
    entry: "view",
    open: () => undefined,
    ...overrides,
  };
}

test("a valid skill registers and reports itself", () => {
  const result = checkSkillDefinition(skill(), AI_SKILL_API_VERSION);
  assert.equal(result.ok, true);
  assert.equal(result.skill.id, "flashcards.makeCards");
});

test("an id must be namespaced, so two plugins cannot collide by accident", () => {
  assert.equal(checkSkillDefinition(skill({ id: "makeCards" }), 1).reason, "invalid");
  assert.equal(checkSkillDefinition(skill({ id: "Flashcards.makeCards" }), 1).reason, "invalid");
  assert.equal(checkSkillDefinition(skill({ id: "todo.planTasks" }), 1).ok, true);
});

test("a skill written for a newer contract is hidden, not half-run", () => {
  const result = checkSkillDefinition(skill({ version: AI_SKILL_API_VERSION + 1 }), 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "incompatible");
});

test("a skill that needs a newer host is hidden", () => {
  const result = checkSkillDefinition(skill({ minHostVersion: 99 }), 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "incompatible");
});

test("missing fields are invalid rather than silently accepted", () => {
  for (const broken of [null, {}, skill({ open: undefined }), skill({ entry: "nope" }), skill({ version: "1" })]) {
    const result = checkSkillDefinition(broken, 1);
    assert.equal(result.ok, false, JSON.stringify(broken));
  }
});