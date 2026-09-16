/**
 * Durable run records: one JSON file per run, plus a rebuildable index.
 *
 * `aiTrace.ts` answers "what is this run doing right now" in memory. This module
 * answers the two questions memory cannot: "what did yesterday's failure look
 * like", and "show me every run across the three plugins in one list". The
 * storage shape is deliberately the same as the conversation store -- one record
 * per file, a disposable index, atomic writes, a corrupt record isolated from
 * the rest -- because that pattern is already tested and already understood.
 *
 * Nothing here is written during a run: a record is persisted on `finish`, so a
 * streaming reply does not rewrite a file per token.
 *
 * Pure helpers plus an injected filesystem; Obsidian-free and testable.
 */

import { redactText } from "../aiTrace";
import type { AiRunError } from "./aiErrors";
import { writeTextAtomic, type AiStoreFs } from "./aiConversationStore";

export const AI_RUN_SCHEMA = 1;

export type AiRunKind = "chat" | "skill" | "apply" | "rag.index" | "tool" | "probe" | "agent";

/** Step kinds the agent writes. Free-form on the wire; listed so the view can label them. */
export const AI_AGENT_STEP_KINDS = [
  "agent.plan",
  "agent.think",
  "agent.tool.approval",
  "agent.tool.run",
  "agent.observe",
  "agent.checkpoint",
  "agent.write",
  "agent.budget",
] as const;
export type AiRunStatus = "running" | "ok" | "failed" | "cancelled";
export type AiRunStepLevel = "info" | "warn" | "error";
export type AiRunStepStatus = "running" | "ok" | "failed";

export interface AiRunStepV2 {
  id: string;
  parentId?: string;
  kind: string;
  level: AiRunStepLevel;
  status: AiRunStepStatus;
  title: string;
  detail?: string;
  meta?: Record<string, string | number | boolean>;
  at: number;
  endedAt?: number;
  durationMs?: number;
  attempt?: number;
}

export interface AiRunUsage {
  prompt: number;
  completion: number;
  total: number;
  /** Input tokens served from the provider's prompt cache, when it reports them. */
  cached?: number;
}

export interface AiRunRecordV2 {
  schema: number;
  id: string;
  pluginId: string;
  kind: AiRunKind;
  title: string;
  skillId?: string;
  conversationId?: string;
  parentRunId?: string;
  /** The workspace an agent/chat run was scoped to, for the audit trail. */
  workspaceId?: string;
  providerId?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  status: AiRunStatus;
  summary?: string;
  usage?: AiRunUsage;
  costUsd?: number;
  steps: AiRunStepV2[];
  errors: AiRunError[];
  /** Only present when the user opted into full payload recording. */
  payloads?: { system?: string; user?: string; reply?: string };
  /** Set when the previous process ended while this run was still running. */
  interrupted?: boolean;
}

export interface AiRunSummary {
  id: string;
  pluginId: string;
  kind: AiRunKind;
  title: string;
  skillId?: string;
  status: AiRunStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  stepCount: number;
  errorCount: number;
  firstErrorCode?: string;
  usage?: AiRunUsage;
  costUsd?: number;
  model?: string;
}

export interface AiRunStepInput {
  kind: string;
  title: string;
  level?: AiRunStepLevel;
  status?: AiRunStepStatus;
  detail?: string;
  meta?: Record<string, string | number | boolean>;
  parentId?: string;
  attempt?: number;
  at?: number;
  endedAt?: number;
}

export interface AiRunCreateInput {
  pluginId: string;
  kind: AiRunKind;
  title: string;
  skillId?: string;
  conversationId?: string;
  parentRunId?: string;
  workspaceId?: string;
  providerId?: string;
  model?: string;
  id?: string;
  startedAt?: number;
}

export interface AiRunFinishInput {
  status: Exclude<AiRunStatus, "running">;
  summary?: string;
  usage?: AiRunUsage;
  costUsd?: number;
  error?: AiRunError;
}

/** The preview limits for text that is not explicitly recorded in full. */
export interface AiRunTextPolicy {
  /** Head characters kept. */
  head?: number;
  /** Tail characters kept, for a truncated reply whose ending matters. */
  tail?: number;
}

export const AI_RUN_DEFAULT_TEXT_POLICY: Required<AiRunTextPolicy> = { head: 2000, tail: 500 };

/** Head+tail preview with an explicit marker, so a truncated log is never mistaken for the whole reply. */
export function truncateRunText(text: string, policy: AiRunTextPolicy = {}): string {
  const head = Math.max(0, policy.head ?? AI_RUN_DEFAULT_TEXT_POLICY.head);
  const tail = Math.max(0, policy.tail ?? AI_RUN_DEFAULT_TEXT_POLICY.tail);
  const value = redactText(text ?? "");
  if (value.length <= head + tail) return value;
  return `${value.slice(0, head)}\n（已截断，共 ${value.length} 字）\n${tail > 0 ? value.slice(-tail) : ""}`;
}

let runCounter = 0;

export function createRunRecord(input: AiRunCreateInput): AiRunRecordV2 {
  const startedAt = input.startedAt ?? Date.now();
  return {
    schema: AI_RUN_SCHEMA,
    id: input.id ?? `run-${startedAt.toString(36)}-${(runCounter += 1).toString(36)}`,
    pluginId: input.pluginId,
    kind: input.kind,
    title: redactText(input.title),
    ...(input.skillId ? { skillId: input.skillId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.model ? { model: input.model } : {}),
    startedAt,
    status: "running",
    steps: [],
    errors: [],
  };
}

/** Append a step. Returns the stored step so callers can update it later. */
export function appendRunStep(record: AiRunRecordV2, input: AiRunStepInput, maxSteps = 800): AiRunStepV2 {
  const at = input.at ?? Date.now();
  const step: AiRunStepV2 = {
    id: `step-${(runCounter += 1).toString(36)}`,
    kind: input.kind,
    level: input.level ?? "info",
    status: input.status ?? "ok",
    title: redactText(input.title),
    at,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.detail !== undefined ? { detail: truncateRunText(input.detail) } : {}),
    ...(input.meta ? { meta: { ...input.meta } } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.endedAt !== undefined ? { endedAt: input.endedAt, durationMs: Math.max(0, input.endedAt - at) } : {}),
  };
  record.steps.push(step);
  while (record.steps.length > maxSteps) record.steps.shift();
  return step;
}

export function appendRunError(record: AiRunRecordV2, error: AiRunError): void {
  record.errors.push({ ...error, userMessage: redactText(error.userMessage), technical: redactText(error.technical) });
}

export function finishRunRecord(record: AiRunRecordV2, input: AiRunFinishInput): void {
  record.status = input.status;
  record.endedAt = Date.now();
  if (input.summary) record.summary = redactText(input.summary);
  if (input.usage) record.usage = { ...input.usage };
  if (input.costUsd !== undefined) record.costUsd = input.costUsd;
  if (input.error) appendRunError(record, input.error);
}

export function summarizeRun(record: AiRunRecordV2): AiRunSummary {
  return {
    id: record.id,
    pluginId: record.pluginId,
    kind: record.kind,
    title: record.title,
    ...(record.skillId ? { skillId: record.skillId } : {}),
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt, durationMs: Math.max(0, record.endedAt - record.startedAt) } : {}),
    stepCount: record.steps.length,
    errorCount: record.errors.length,
    ...(record.errors[0] ? { firstErrorCode: record.errors[0].code } : {}),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
    ...(record.model ? { model: record.model } : {}),
  };
}

/** One copyable Markdown block. No secrets: fields are already redacted at storage time. */
export function formatRunMarkdown(record: AiRunRecordV2): string {
  const lines: string[] = [];
  lines.push(`# 运行 ${record.id}`);
  lines.push("");
  lines.push(`- 插件：${record.pluginId}`);
  lines.push(`- 类型：${record.kind}${record.skillId ? `（${record.skillId}）` : ""}`);
  lines.push(`- 状态：${record.status}${record.endedAt ? `，耗时 ${Math.max(0, record.endedAt - record.startedAt)} ms` : ""}`);
  if (record.model) lines.push(`- 模型：${record.model}`);
  if (record.usage) {
    const cache = record.usage.cached ? `（缓存 ${record.usage.cached}）` : "";
    lines.push(`- tokens：${record.usage.prompt}+${record.usage.completion}=${record.usage.total}${cache}`);
  }
  if (record.costUsd !== undefined) lines.push(`- 估算成本：$${record.costUsd.toFixed(4)}`);
  if (record.summary) lines.push(`- 摘要：${record.summary}`);
  lines.push("");
  lines.push("## 步骤");
  lines.push("");
  for (const step of record.steps) {
    const duration = step.durationMs !== undefined ? ` (${step.durationMs} ms)` : "";
    lines.push(`- [${step.status}/${step.level}] ${step.kind}  ${step.title}${duration}`);
    if (step.detail) for (const line of step.detail.split(/\r?\n/)) lines.push(`  - ${line}`);
  }
  if (record.errors.length) {
    lines.push("");
    lines.push("## 错误");
    lines.push("");
    for (const error of record.errors) {
      lines.push(`- [${error.code}] ${error.userMessage}`);
      if (error.hint) lines.push(`  - 提示：${error.hint}`);
      lines.push(`  - 技术：${error.technical}`);
    }
  }
  return lines.join("\n");
}

export function formatRunJson(record: AiRunRecordV2): string {
  return JSON.stringify(record, null, 2);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface AiRunRetentionPolicy {
  maxRuns?: number;
  maxAgeDays?: number;
  maxBytes?: number;
}

export interface AiRunPruneDecision {
  remove: string[];
  keep: string[];
}

/** Which runs to delete, oldest first, once any of the three limits is exceeded. */
export function selectRunsToPrune(
  records: readonly AiRunRecordV2[],
  policy: AiRunRetentionPolicy = {},
  now = Date.now(),
): AiRunPruneDecision {
  const maxRuns = Math.max(1, policy.maxRuns ?? 100);
  const maxAgeDays = Math.max(1, policy.maxAgeDays ?? 14);
  const maxBytes = Math.max(1024, policy.maxBytes ?? 20 * 1024 * 1024);
  const sorted = [...records].sort((a, b) => b.startedAt - a.startedAt);
  const remove = new Set<string>();
  const ageLimit = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let bytes = 0;
  let kept = 0;
  for (const record of sorted) {
    const size = JSON.stringify(record).length;
    const tooOld = record.startedAt < ageLimit;
    const tooMany = kept >= maxRuns;
    const tooBig = bytes + size > maxBytes;
    if (tooOld || tooMany || tooBig) {
      remove.add(record.id);
      continue;
    }
    kept += 1;
    bytes += size;
  }
  return { remove: [...remove], keep: sorted.filter((record) => !remove.has(record.id)).map((record) => record.id) };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface AiRunStore {
  init(): Promise<{ rebuilt: boolean; skipped: string[] }>;
  save(record: AiRunRecordV2): Promise<void>;
  list(): Promise<AiRunSummary[]>;
  read(id: string): Promise<AiRunRecordV2 | null>;
  remove(id: string): Promise<boolean>;
  clear(): Promise<void>;
  rebuildIndex(): Promise<{ rebuilt: boolean; skipped: string[] }>;
  /** Replace the retention policy for subsequent saves. */
  setRetention(policy: AiRunRetentionPolicy): void;
}

export interface AiRunStoreOptions {
  dir?: string;
  newId?: () => string;
  now?: () => number;
  retention?: AiRunRetentionPolicy;
}

export function createRunStore(fs: AiStoreFs, options: AiRunStoreOptions = {}): AiRunStore {
  const dir = (options.dir ?? "runs").replace(/^\/+|\/+$/g, "") || "runs";
  const indexFile = `${dir}/index.json`;
  const now = options.now ?? (() => Date.now());
  let policy = options.retention ?? {};
  /** The list view's cache; rebuilt from files when the index is lost. */
  let summaries: AiRunSummary[] | null = null;
  /** Full records touched in this session; `read` falls back to the file. */
  const loaded = new Map<string, AiRunRecordV2>();
  let ready: Promise<{ rebuilt: boolean; skipped: string[] }> | null = null;

  const fileFor = (id: string): string => `${dir}/v${AI_RUN_SCHEMA}_${safeId(id)}.json`;
  const ensure = (): Promise<{ rebuilt: boolean; skipped: string[] }> => (ready ??= load());

  async function load(): Promise<{ rebuilt: boolean; skipped: string[] }> {
    await fs.mkdir(dir);
    const text = await fs.readText(indexFile);
    if (text !== null) {
      const parsed = parseIndex(text);
      if (parsed) {
        summaries = parsed;
        if (await indexMatchesFiles(parsed.length)) return { rebuilt: false, skipped: [] };
        return await rebuild();
      }
    }
    return await rebuild();
  }

  /** Same reconciliation as the conversation store: the index is a cache. */
  async function indexMatchesFiles(known: number): Promise<boolean> {
    const keys = new Set<string>();
    for (const name of await fs.list(dir)) {
      const match = /^v(\d+)_/.exec(name);
      if (!match) continue;
      const schema = Number(match[1]);
      if (!Number.isInteger(schema) || schema > AI_RUN_SCHEMA) continue;
      keys.add(name.replace(/^v\d+_/, ""));
    }
    return known > 0 ? keys.size >= known : keys.size === 0;
  }

  async function rebuild(): Promise<{ rebuilt: boolean; skipped: string[] }> {
    const skipped: string[] = [];
    const found: AiRunRecordV2[] = [];
    for (const name of await fs.list(dir)) {
      if (!name.startsWith(`v${AI_RUN_SCHEMA}_`) || !name.endsWith(".json")) continue;
      const text = await fs.readText(`${dir}/${name}`);
      if (text === null) continue;
      const record = parseRecordText(text);
      if (!record) {
        skipped.push(name);
        continue;
      }
      found.push(record);
      loaded.set(record.id, record);
    }
    summaries = found.sort((a, b) => b.startedAt - a.startedAt).map(summarizeRun);
    await writeIndex();
    return { rebuilt: true, skipped };
  }

  async function writeIndex(): Promise<void> {
    await writeTextAtomic(fs, indexFile, JSON.stringify({ schema: AI_RUN_SCHEMA, runs: summaries ?? [] }, null, 2));
  }

  /** Retention works from summaries when old records were not loaded this session. */
  async function applyRetention(): Promise<void> {
    const asRecords = (summaries ?? []).map((summary) => loaded.get(summary.id) ?? summaryRecord(summary));
    const decision = selectRunsToPrune(asRecords, policy, now());
    if (!decision.remove.length) return;
    const removing = new Set(decision.remove);
    for (const id of removing) {
      await fs.remove(fileFor(id));
      loaded.delete(id);
    }
    summaries = (summaries ?? []).filter((summary) => !removing.has(summary.id));
  }

  const store: AiRunStore = {
    init: ensure,

    async save(record) {
      await ensure();
      const normalized = normalizeRunRecord(record);
      if (!normalized) throw new Error("运行记录缺少 id 或 pluginId。");
      await fs.mkdir(dir);
      await writeTextAtomic(fs, fileFor(normalized.id), JSON.stringify(normalized, null, 2));
      loaded.set(normalized.id, normalized);
      summaries = [summarizeRun(normalized), ...(summaries ?? []).filter((summary) => summary.id !== normalized.id)];
      await applyRetention();
      await writeIndex();
    },

    async list() {
      await ensure();
      return [...(summaries ?? [])].sort((a, b) => b.startedAt - a.startedAt);
    },

    async read(id) {
      await ensure();
      const cached = loaded.get(id);
      if (cached) return clone(cached);
      const text = await fs.readText(fileFor(id));
      const record = text === null ? null : parseRecordText(text);
      if (record) loaded.set(record.id, record);
      return record ? clone(record) : null;
    },

    async remove(id) {
      await ensure();
      const known = (summaries ?? []).some((summary) => summary.id === id);
      await fs.remove(fileFor(id));
      loaded.delete(id);
      summaries = (summaries ?? []).filter((summary) => summary.id !== id);
      if (known) await writeIndex();
      return known;
    },

    async clear() {
      await ensure();
      for (const summary of summaries ?? []) await fs.remove(fileFor(summary.id));
      loaded.clear();
      summaries = [];
      await fs.remove(indexFile);
      await writeIndex();
    },

    setRetention(next) {
      policy = next;
    },

    async rebuildIndex() {
      // Drop the index cache but keep `ready`: `rebuild` is called from inside
      // the first `load`, and invalidating the promise there would deadlock.
      return await rebuild();
    },
  };

  return store;
}
// ---------------------------------------------------------------------------
// Parsing / normalization
// ---------------------------------------------------------------------------

export function normalizeRunRecord(raw: unknown): AiRunRecordV2 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
  const pluginId = typeof record.pluginId === "string" && record.pluginId.trim() ? record.pluginId.trim() : "";
  if (!id || !pluginId) return null;
  const steps = Array.isArray(record.steps)
    ? record.steps
        .map((item) => normalizeStep(item))
        .filter((step): step is AiRunStepV2 => step !== null)
        .slice(-800)
    : [];
  const errors = Array.isArray(record.errors)
    ? record.errors
        .map((item) => normalizeError(item))
        .filter((error): error is AiRunError => error !== null)
        .slice(-50)
    : [];
  const status = record.status === "ok" || record.status === "failed" || record.status === "cancelled" ? record.status : "running";
  return {
    schema: AI_RUN_SCHEMA,
    id,
    pluginId,
    kind: normalizeKind(record.kind),
    title: redactText(typeof record.title === "string" ? record.title : "未命名运行"),
    ...(typeof record.skillId === "string" ? { skillId: record.skillId } : {}),
    ...(typeof record.conversationId === "string" ? { conversationId: record.conversationId } : {}),
    ...(typeof record.parentRunId === "string" ? { parentRunId: record.parentRunId } : {}),
    ...(typeof record.workspaceId === "string" ? { workspaceId: record.workspaceId } : {}),
    ...(typeof record.providerId === "string" ? { providerId: record.providerId } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    startedAt: numberOr(record.startedAt, Date.now()),
    ...(typeof record.endedAt === "number" ? { endedAt: record.endedAt } : {}),
    status,
    ...(typeof record.summary === "string" ? { summary: redactText(record.summary) } : {}),
    ...(isUsage(record.usage) ? { usage: record.usage } : {}),
    ...(typeof record.costUsd === "number" ? { costUsd: record.costUsd } : {}),
    steps,
    errors,
    ...(isPayloads(record.payloads)
      ? {
          payloads: {
            ...(typeof record.payloads.system === "string" ? { system: truncateRunText(record.payloads.system) } : {}),
            ...(typeof record.payloads.user === "string" ? { user: truncateRunText(record.payloads.user) } : {}),
            ...(typeof record.payloads.reply === "string" ? { reply: truncateRunText(record.payloads.reply) } : {}),
          },
        }
      : {}),
    ...(record.interrupted === true ? { interrupted: true } : {}),
  };
}

function normalizeStep(raw: unknown): AiRunStepV2 | null {
  if (!raw || typeof raw !== "object") return null;
  const step = raw as Record<string, unknown>;
  const title = typeof step.title === "string" ? step.title : "";
  if (!title) return null;
  const status = step.status === "running" || step.status === "failed" ? step.status : "ok";
  const level = step.level === "warn" || step.level === "error" ? step.level : "info";
  return {
    id: typeof step.id === "string" ? step.id : `step-${Math.random().toString(36).slice(2, 10)}`,
    ...(typeof step.parentId === "string" ? { parentId: step.parentId } : {}),
    kind: typeof step.kind === "string" ? step.kind : "unknown",
    level,
    status,
    title: redactText(title),
    ...(typeof step.detail === "string" ? { detail: truncateRunText(step.detail) } : {}),
    ...(isMeta(step.meta) ? { meta: step.meta } : {}),
    at: numberOr(step.at, Date.now()),
    ...(typeof step.endedAt === "number" ? { endedAt: step.endedAt } : {}),
    ...(typeof step.durationMs === "number" ? { durationMs: step.durationMs } : {}),
    ...(typeof step.attempt === "number" ? { attempt: step.attempt } : {}),
  };
}

function normalizeError(raw: unknown): AiRunError | null {
  if (!raw || typeof raw !== "object") return null;
  const error = raw as Record<string, unknown>;
  const code = typeof error.code === "string" ? error.code : "";
  const userMessage = typeof error.userMessage === "string" ? error.userMessage : "";
  if (!code || !userMessage) return null;
  const category = typeof error.category === "string" ? error.category : "internal";
  return {
    code,
    category: category as AiRunError["category"],
    severity: error.severity === "warning" || error.severity === "fatal" ? error.severity : "error",
    userMessage: redactText(userMessage),
    technical: redactText(typeof error.technical === "string" ? error.technical : ""),
    ...(typeof error.hint === "string" ? { hint: redactText(error.hint) } : {}),
    retryable: error.retryable === true,
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    at: numberOr(error.at, Date.now()),
    ...(typeof error.stepId === "string" ? { stepId: error.stepId } : {}),
    ...(typeof error.occurrences === "number" ? { occurrences: error.occurrences } : {}),
  };
}

function parseRecordText(text: string): AiRunRecordV2 | null {
  try {
    return normalizeRunRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function parseIndex(text: string): AiRunSummary[] | null {
  try {
    const parsed = JSON.parse(text) as { schema?: unknown; runs?: unknown };
    if (parsed.schema !== AI_RUN_SCHEMA || !Array.isArray(parsed.runs)) return null;
    return parsed.runs
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const summary = item as Record<string, unknown>;
        const id = typeof summary.id === "string" ? summary.id : "";
        if (!id) return null;
        const usage = isUsage(summary.usage) ? summary.usage : undefined;
        return {
          id,
          pluginId: typeof summary.pluginId === "string" ? summary.pluginId : "",
          kind: normalizeKind(summary.kind),
          title: typeof summary.title === "string" ? summary.title : "",
          status: summary.status === "ok" || summary.status === "failed" || summary.status === "cancelled" ? summary.status : "running",
          startedAt: numberOr(summary.startedAt, 0),
          stepCount: typeof summary.stepCount === "number" ? summary.stepCount : 0,
          errorCount: typeof summary.errorCount === "number" ? summary.errorCount : 0,
          ...(typeof summary.endedAt === "number" ? { endedAt: summary.endedAt } : {}),
          ...(typeof summary.durationMs === "number" ? { durationMs: summary.durationMs } : {}),
          ...(typeof summary.firstErrorCode === "string" ? { firstErrorCode: summary.firstErrorCode } : {}),
          ...(usage ? { usage } : {}),
          ...(typeof summary.costUsd === "number" ? { costUsd: summary.costUsd } : {}),
          ...(typeof summary.model === "string" ? { model: summary.model } : {}),
        } satisfies AiRunSummary;
      })
      .filter((item): item is AiRunSummary => item !== null);
  } catch {
    return null;
  }
}

function summaryRecord(summary: AiRunSummary): AiRunRecordV2 {
  return {
    schema: AI_RUN_SCHEMA,
    id: summary.id,
    pluginId: summary.pluginId,
    kind: summary.kind,
    title: summary.title,
    startedAt: summary.startedAt,
    status: summary.status,
    steps: [],
    errors: [],
  };
}

function normalizeKind(value: unknown): AiRunKind {
  return value === "skill" || value === "apply" || value === "rag.index" || value === "tool" || value === "probe" || value === "agent"
    ? value
    : "chat";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isUsage(value: unknown): value is AiRunUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return typeof usage.prompt === "number" && typeof usage.completion === "number" && typeof usage.total === "number";
}

function isMeta(value: unknown): value is Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

function isPayloads(value: unknown): value is { system?: string; user?: string; reply?: string } {
  if (!value || typeof value !== "object") return false;
  const payloads = value as Record<string, unknown>;
  return [payloads.system, payloads.user, payloads.reply].some((item) => typeof item === "string");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeId(id: string): string {
  return `${id.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60) || "run"}-${fnv1a(id)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

