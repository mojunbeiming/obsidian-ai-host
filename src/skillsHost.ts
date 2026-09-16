/**
 * The host-side skill registry and its picker.
 *
 * A domain plugin registers metadata plus an `open` callback; the host lists it
 * and hands control back. The host never knows what a card or a task row is --
 * that is the boundary the plan draws, and it is what keeps the domain prompt
 * and the domain preview owned by the plugin that understands them.
 *
 * Registration is version-gated: a skill written for a newer contract is
 * rejected with a reason and stays out of the picker, instead of half-running.
 */

import { App, SuggestModal } from "obsidian";
import {
  AI_SKILL_API_VERSION,
  checkSkillDefinition,
  type AiSkillDefinition,
  type AiSkillRegistration,
} from "../sdk/src/ai/aiSkill";

export class SkillRegistry {
  private readonly skills = new Map<string, AiSkillDefinition>();

  register(skill: unknown): AiSkillRegistration {
    const checked = checkSkillDefinition(skill, AI_SKILL_API_VERSION);
    if (!checked.ok) return checked;
    if (this.skills.has(checked.skill.id)) {
      return { ok: false, reason: "duplicate", message: `技能 ${checked.skill.id} 已经注册。` };
    }
    this.skills.set(checked.skill.id, checked.skill);
    return checked;
  }

  unregister(id: string): void {
    this.skills.delete(id);
  }

  list(): AiSkillDefinition[] {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.skills.size;
  }
}

/** The command-palette picker: one row per registered domain skill. */
export class SkillSuggestModal extends SuggestModal<AiSkillDefinition> {
  constructor(app: App, private readonly skills: readonly AiSkillDefinition[]) {
    super(app);
    this.setPlaceholder("选择一个领域技能");
  }

  getSuggestions(query: string): AiSkillDefinition[] {
    const needle = query.trim().toLowerCase();
    return this.skills.filter((skill) => !needle || skill.title.toLowerCase().includes(needle) || skill.id.toLowerCase().includes(needle));
  }

  renderSuggestion(skill: AiSkillDefinition, el: HTMLElement): void {
    el.createDiv({ text: skill.title });
    el.createDiv({ cls: "sfc-ai-diff-head", text: `${skill.id}  ${skill.description}` });
  }

  onChooseSuggestion(skill: AiSkillDefinition): void {
    void skill.open();
  }
}