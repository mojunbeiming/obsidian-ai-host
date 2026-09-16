/**
 * The domain-skill contract: what a domain plugin registers with the host.
 *
 * The boundary is deliberate. The host owns the socket, the credential, the
 * model call, usage/cost and error phrasing; the domain owns the prompt, the
 * parse, the draft validation, the preview and the final write through its own
 * API. A skill therefore registers *metadata and an entry point*, and its UI
 * calls back into the host for model turns -- the host never parses a card or a
 * task row.
 *
 * A version mismatch hides the skill instead of running it: a host that calls a
 * v2 entry with a v1 shape produces a half-valid draft that looks like a model
 * error, and "the model is bad today" is the worst possible bug report.
 */

/**
 * The skill contract version this host implements.
 *
 * 1 -> 2 added the optional `agent()` entry point. It is additive: a v1
 * definition still registers, because the field it lacks is one the host only
 * calls when it exists.
 */
export const AI_SKILL_API_VERSION = 2;

/** What a domain skill may return when the agent calls it headlessly. */
export interface AiAgentSkillResult {
  /** A Markdown draft for the user to review. Never written by the host. */
  draft: string;
  /** True when the skill already applied the draft through its own API. */
  applied?: boolean;
  /** Short human-readable note for the run timeline. */
  message?: string;
  /** Vault paths the skill wrote, for the agent's audit summary. */
  files?: string[];
}

/** What the host hands a domain skill's `agent()` entry point. */
export interface AiAgentSkillInput {
  /** The goal for this step, as decided by the agent. */
  instruction: string;
  /** The workspace the call is scoped to; the skill must respect `folders`. */
  workspace: { id: string; name: string; folders: string[] };
  signal?: AbortSignal;
  /** One model turn through the host; the credential never leaves the host. */
  ask(prompt: string): Promise<string>;
}

export interface AiSkillDefinition {
  /** Namespaced and stable: `flashcards.makeCards`, `todo.planTasks`. */
  id: string;
  /** The skill contract version the definition was written against. */
  version: number;
  /** The oldest host contract it can run on. */
  minHostVersion: number;
  title: string;
  description: string;
  /** What the entry point opens, for the host's command list. */
  entry: "view" | "modal" | "command";
  /** Open the domain UI. The host calls this; the skill owns everything after. */
  open(): void | Promise<void>;
  /**
   * Headless entry point for the agent.
   *
   * Optional on purpose: a skill without it simply is not offered to the agent,
   * so a domain plugin can ship the UI first and the agent path later without a
   * contract bump. The host never parses a card or a task row -- the skill
   * returns its own draft and decides whether to apply it.
   */
  agent?(input: AiAgentSkillInput): Promise<AiAgentSkillResult>;
}

export type AiSkillRegistration =
  | { ok: true; skill: AiSkillDefinition }
  | { ok: false; reason: "duplicate" | "incompatible" | "invalid"; message: string };

/** Validate and version-check one definition against the host contract. */
export function checkSkillDefinition(skill: unknown, hostVersion: number): AiSkillRegistration {
  if (!skill || typeof skill !== "object") return { ok: false, reason: "invalid", message: "技能定义不是一个对象。" };
  const record = skill as Partial<AiSkillDefinition>;
  if (typeof record.id !== "string" || !/^[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/.test(record.id)) {
    return { ok: false, reason: "invalid", message: "技能 id 必须是 namespace.name 形式。" };
  }
  if (typeof record.version !== "number" || typeof record.minHostVersion !== "number") {
    return { ok: false, reason: "invalid", message: "技能缺少 version / minHostVersion。" };
  }
  if (record.version > AI_SKILL_API_VERSION) {
    return { ok: false, reason: "incompatible", message: `技能需要契约 v${record.version}，宿主只支持 v${AI_SKILL_API_VERSION}。` };
  }
  if (record.minHostVersion > hostVersion) {
    return { ok: false, reason: "incompatible", message: `技能需要宿主版本 ${record.minHostVersion}，当前是 ${hostVersion}。` };
  }
  if (record.entry !== "view" && record.entry !== "modal" && record.entry !== "command") {
    return { ok: false, reason: "invalid", message: "技能 entry 必须是 view / modal / command。" };
  }
  if (typeof record.open !== "function" || typeof record.title !== "string" || typeof record.description !== "string") {
    return { ok: false, reason: "invalid", message: "技能缺少 title / description / open。" };
  }
  if (record.agent !== undefined && typeof record.agent !== "function") {
    return { ok: false, reason: "invalid", message: "技能的 agent 字段存在时必须是函数。" };
  }
  return { ok: true, skill: record as AiSkillDefinition };
}