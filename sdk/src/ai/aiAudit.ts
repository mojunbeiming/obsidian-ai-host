/**
 * The write audit: what an agent changed, and how to put it back.
 *
 * ## Why a hash of both sides
 *
 * A backup alone answers "what was here before". It does not answer "is what I
 * wrote still what is on disk" -- and that is the question that decides whether
 * an undo is safe. Every write therefore records `beforeHash` and `afterHash`:
 *
 * * undo is offered when the current file still hashes to `afterHash` (nobody
 *   edited after the AI did);
 * * undo warns when it does not, because restoring would discard the user's own
 *   later edit;
 * * an audit line can be checked without opening the file.
 *
 * The hash is FNV-1a 64-bit rendered as hex. Cryptographic strength is not the
 * goal -- a local collision does not break anything that a wrong file path
 * would not already break -- and a pure function that runs on every write
 * should not pull in `node:crypto`, which the domain bundles may not have.
 *
 * ## Batches
 *
 * A multi-step agent writes several files. "Undo the last write" is then the
 * wrong button: it restores one file and leaves the rest of the run applied.
 * Writes carry a `batchId` (one per agent run, or one per manual apply), so the
 * delivery summary can offer "撤销本次全部写入" and the undo planner can order
 * the restores newest-first without rewriting history twice.
 *
 * Pure: values in, values out, no filesystem.
 */

import { truncateRunText } from "./aiRunLog";

export interface AiWriteAudit {
  /** Stable id for the audit line. */
  id: string;
  /** One per run; the unit the UI undoes. */
  batchId: string;
  runId?: string;
  /** Tool name: `vault.rewriteNote`, `vault.append`, `host.apply`. */
  tool: string;
  path: string;
  /** UTF-8-ish length of the written content, for the report. */
  bytes: number;
  beforeChars: number;
  afterChars: number;
  beforeHash: string;
  afterHash: string;
  at: number;
  /** Set when the file did not exist before the write (an undo removes it). */
  created?: boolean;
}

export interface AiWriteBatch {
  id: string;
  runId?: string;
  title: string;
  createdAt: number;
  entries: AiWriteAudit[];
}

export interface AiWriteAuditInput {
  batchId: string;
  runId?: string;
  tool: string;
  path: string;
  before: string | null;
  after: string;
  at?: number;
}

let auditCounter = 0;

/**
 * A 64-bit FNV-1a hash, hex encoded.
 *
 * Two 32-bit lanes with different primes are mixed so short strings do not all
 * collide in the high bits; the result is stable across runs, which is what the
 * undo check compares against.
 */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + code) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x85ebca6b) >>> 0;
  }
  h2 = (h2 ^ (h2 >>> 16)) >>> 0;
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** Build one audit entry. The caller has already produced `after`. */
export function createWriteAudit(input: AiWriteAuditInput): AiWriteAudit {
  auditCounter += 1;
  const at = input.at ?? Date.now();
  const before = input.before ?? "";
  const created = input.before === null;
  return {
    id: `wr-${at.toString(36)}-${auditCounter.toString(36)}`,
    batchId: input.batchId,
    ...(input.runId ? { runId: input.runId } : {}),
    tool: input.tool,
    path: input.path,
    bytes: input.after.length,
    beforeChars: before.length,
    afterChars: input.after.length,
    beforeHash: created ? "" : hashText(before),
    afterHash: hashText(input.after),
    at,
    ...(created ? { created: true } : {}),
  };
}

export function createWriteBatch(input: { id: string; runId?: string; title: string; at?: number }): AiWriteBatch {
  return {
    id: input.id,
    ...(input.runId ? { runId: input.runId } : {}),
    title: redactBatchTitle(input.title),
    createdAt: input.at ?? Date.now(),
    entries: [],
  };
}

/** Append without mutating the caller's batch, so a checkpoint can keep the old value. */
export function withAuditEntry(batch: AiWriteBatch, entry: AiWriteAudit): AiWriteBatch {
  return { ...batch, entries: [...batch.entries, entry] };
}

/** Newest write first: undoing a file that was rewritten twice must restore the state before the *first* write. */
export function undoOrder(entries: readonly AiWriteAudit[]): AiWriteAudit[] {
  return [...entries].sort((a, b) => b.at - a.at);
}

/** The files a batch touched, in first-touch order, for the delivery summary. */
export function batchFiles(batch: AiWriteBatch): string[] {
  const seen: string[] = [];
  for (const entry of [...batch.entries].sort((a, b) => a.at - b.at)) {
    if (!seen.includes(entry.path)) seen.push(entry.path);
  }
  return seen;
}

/** `notes/a.md（+12 字）`, capped so a 40-file batch does not become a wall of text. */
export function describeWriteBatch(batch: AiWriteBatch, limit = 12): string {
  const files = batchFiles(batch);
  const shown = files.slice(0, limit).map((path) => {
    const entries = batch.entries.filter((entry) => entry.path === path);
    const first = entries[0];
    const last = entries[entries.length - 1];
    const delta = `${last.afterChars - first.beforeChars >= 0 ? "+" : ""}${last.afterChars - first.beforeChars} 字`;
    return `${path}（${delta}）`;
  });
  const more = files.length > limit ? ` 等 ${files.length} 个文件` : "";
  return `${files.length} 个文件：${shown.join("、")}${more}`;
}

/** One audit line for the trace timeline. Redacted like every other run step. */
export function formatAuditLine(entry: AiWriteAudit): string {
  const verb = entry.created ? "新建" : "改写";
  return `${verb} ${entry.path}  ${entry.beforeChars}${entry.afterChars} 字  ${entry.beforeHash || ""}${entry.afterHash}`;
}

/** Does the current text still match what the audit says was written? */
export function matchesAfterHash(entry: AiWriteAudit, current: string): boolean {
  return hashText(current) === entry.afterHash;
}

/**
 * The per-path decision list for an undo action.
 *
 * Each path contributes at most one restore: the state before its earliest
 * write in the batch. Paths written twice must not be restored twice -- the
 * second restore would re-apply the AI's intermediate content.
 */
export interface AiUndoStep {
  path: string;
  /** `restore` reads the backup; `remove` deletes a file the batch created. */
  action: "restore" | "remove";
  /** True when the file changed after the AI wrote it; the UI must warn. */
  stale: boolean;
  entry: AiWriteAudit;
}

export interface AiUndoPlan {
  steps: AiUndoStep[];
  /** Paths whose current content no longer matches the recorded after-hash. */
  stale: string[];
}

/**
 * Plan an undo from audit entries and a reader for the current content.
 *
 * Two different entries matter per path, and mixing them up loses data:
 *
 * * the **earliest** write decides what to restore (its `beforeHash` is the
 *   state the user wants back, even when a later step rewrote the file again);
 * * the **latest** write decides whether an undo is safe (the file must still
 *   hash to the last thing the AI wrote; otherwise the user edited it after).
 */
export function planUndo(
  entries: readonly AiWriteAudit[],
  current: (path: string) => string | null,
): AiUndoPlan {
  const earliest = new Map<string, AiWriteAudit>();
  const latest = new Map<string, AiWriteAudit>();
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    if (!earliest.has(entry.path)) earliest.set(entry.path, entry);
    latest.set(entry.path, entry);
  }
  const steps: AiUndoStep[] = [];
  const stale: string[] = [];
  for (const [path, entry] of earliest) {
    const text = current(path);
    const last = latest.get(path) ?? entry;
    const isStale = text !== null && !matchesAfterHash(last, text);
    if (isStale) stale.push(path);
    steps.push({
      path,
      action: entry.created ? "remove" : "restore",
      stale: isStale,
      entry,
    });
  }
  return { steps, stale };
}

/** Preview sentence for `planUndo`, so the confirmation is not a surprise. */
export function describeUndoPlan(plan: AiUndoPlan): string {
  const restores = plan.steps.filter((step) => step.action === "restore").length;
  const removes = plan.steps.length - restores;
  const parts = [`将恢复 ${restores} 个文件`, removes ? `删除 ${removes} 个新建文件` : ""].filter(Boolean);
  if (plan.stale.length) parts.push(`${plan.stale.length} 个文件在 AI 之后被改过，撤销会覆盖这些改动`);
  return parts.join("；");
}

function redactBatchTitle(title: string): string {
  return truncateRunText(title, { head: 80, tail: 0 }).replace(/\n/g, " ").trim() || "AI 写入";
}