/**
 * The one place a run lives while it happens, and the one place it is stored
 * once it ends.
 *
 * The host is the sink because every model call already goes through it: one
 * store means one retention policy, one export and one list across the three
 * plugins, without the domain plugins writing AI logs of their own. Domain
 * plugins append their steps through the sibling API (`beginRun`/`trace`/
 * `finishRun`), so a trajectory can contain both sides of the boundary.
 *
 * Two behaviours worth reading:
 *
 * * a run is written once, on `finish`; a streaming reply never rewrites a file
 *   per token, and a crash leaves a `running` record that `init` marks as
 *   interrupted rather than silently reporting success;
 * * repeated errors merge inside a short window, because a RAG index that fails
 *   on every file would otherwise put hundreds of identical errors in one run.
 *
 * Obsidian-free: the filesystem is the injected run store.
 */

import { classifyError, errorDedupKey, type AiErrorContext, type AiRunError } from "../sdk/src/ai/aiErrors";
import {
  appendRunError,
  appendRunStep,
  createRunRecord,
  finishRunRecord,
  summarizeRun,
  type AiRunCreateInput,
  type AiRunRecordV2,
  type AiRunStepInput,
  type AiRunStore,
  type AiRunSummary,
  type AiRunUsage,
} from "../sdk/src/ai/aiRunLog";

export interface AiRunFinishPayload {
  status: "ok" | "failed" | "cancelled";
  summary?: string;
  usage?: AiRunUsage;
  costUsd?: number;
  // `code` is optional so a domain plugin can send what it knows and let the host
  // classify it with the same table.
  error?: { code?: string; message: string; technical?: string; retryable?: boolean } | null;
}

export interface RunHubOptions {
  store: AiRunStore;
  now?: () => number;
  /** How long the same code+message is merged instead of appended again. */
  dedupWindowMs?: number;
  onUpdate?: (summary: AiRunSummary) => void;
}

export class RunHub {
  private readonly live = new Map<string, AiRunRecordV2>();
  private readonly dedup = new Map<string, { count: number; lastAt: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly options: RunHubOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Load the index and turn yesterday's crashed `running` records into failures. */
  async init(): Promise<{ rebuilt: boolean; skipped: string[] }> {
    const info = await this.options.store.init();
    const interrupted = (await this.options.store.list()).filter((summary) => summary.status === "running");
    for (const summary of interrupted) {
      const record = await this.options.store.read(summary.id);
      if (!record) continue;
      appendRunError(record, classifyError(new Error("上一次运行时 Obsidian 被关闭。"), { where: "run", at: this.now() }));
      finishRunRecord(record, { status: "failed", summary: "中断（应用在运行中被关闭）" });
      record.interrupted = true;
      await this.options.store.save(record);
    }
    return info;
  }

  begin(input: AiRunCreateInput): string {
    const record = createRunRecord({ ...input, startedAt: input.startedAt ?? this.now() });
    this.live.set(record.id, record);
    this.notify(record);
    return record.id;
  }

  step(runId: string, input: AiRunStepInput): void {
    const record = this.live.get(runId);
    if (!record) return;
    appendRunStep(record, { ...input, at: input.at ?? this.now() });
    this.notify(record);
  }

  /** Classify and append one error, merging repeats inside the dedup window. */
  error(runId: string, error: unknown, context: AiErrorContext = {}): AiRunError | null {
    const record = this.live.get(runId);
    if (!record) return null;
    const recordError = classifyError(error, { at: this.now(), ...context });
    const key = errorDedupKey(recordError);
    const prior = this.dedup.get(key);
    if (prior && this.now() - prior.lastAt <= (this.options.dedupWindowMs ?? 5 * 60 * 1000)) {
      prior.count += 1;
      prior.lastAt = this.now();
      return null;
    }
    this.dedup.set(key, { count: 1, lastAt: this.now() });
    appendRunError(record, recordError);
    appendRunStep(record, {
      kind: "error",
      level: "error",
      status: "failed",
      title: `[${recordError.code}] ${recordError.userMessage}`,
      detail: recordError.technical,
      at: this.now(),
    });
    this.notify(record);
    return recordError;
  }

  async finish(runId: string, payload: AiRunFinishPayload): Promise<AiRunRecordV2 | null> {
    const record = this.live.get(runId);
    if (!record) return null;
    let errorRecord: AiRunError | undefined;
    if (payload.error) {
      errorRecord = classifyError(payload.error, { where: record.kind, at: this.now() });
      if (payload.error.code && errorRecord.code !== payload.error.code) {
        errorRecord = { ...errorRecord, code: payload.error.code };
      }
      appendRunError(record, errorRecord);
    } else if (!record.errors.length) {
      // A run that only has an error *step* still deserves a classified error.
      const lastError = [...record.steps].reverse().find((step) => step.level === "error" || step.kind === "error");
      if (lastError) {
        errorRecord = classifyError(new Error(lastError.detail || lastError.title), { where: record.kind, at: this.now() });
        // A step that already carries a classified code in its title (the chat
        // runtime and the domain helpers write `CODE：message`) keeps it; the
        // fallback classifier only fills the technical fields.
        const coded = /^\s*([A-Z][A-Z0-9_]{2,})[：:]/.exec(lastError.title);
        if (coded) errorRecord = { ...errorRecord, code: coded[1] };
        appendRunError(record, errorRecord);
      }
    }
    finishRunRecord(record, {
      status: payload.status,
      ...(payload.summary ? { summary: payload.summary } : {}),
      ...(payload.usage ? { usage: payload.usage } : {}),
      ...(payload.costUsd !== undefined ? { costUsd: payload.costUsd } : {}),
    });
    this.live.delete(runId);
    await this.options.store.save(record);
    this.notify(record);
    return record;
  }

  /** The live record, or null when it has already been persisted. */
  get(runId: string): AiRunRecordV2 | null {
    return this.live.get(runId) ?? null;
  }

  async read(runId: string): Promise<AiRunRecordV2 | null> {
    return this.live.get(runId) ?? (await this.options.store.read(runId));
  }

  async list(filter: { pluginId?: string; status?: string; kind?: string; query?: string; limit?: number } = {}): Promise<AiRunSummary[]> {
    const persisted = await this.options.store.list();
    const live = [...this.live.values()].map((record) => summarizeRun(record));
    const needle = (filter.query ?? "").trim().toLowerCase();
    return [...live, ...persisted]
      .filter((summary) => !filter.pluginId || summary.pluginId === filter.pluginId)
      .filter((summary) => !filter.status || summary.status === filter.status)
      .filter((summary) => !filter.kind || summary.kind === filter.kind)
      .filter(
        (summary) =>
          !needle ||
          summary.title.toLowerCase().includes(needle) ||
          (summary.model ?? "").toLowerCase().includes(needle) ||
          (summary.firstErrorCode ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(1, filter.limit ?? 200));
  }

  async clear(): Promise<void> {
    this.live.clear();
    this.dedup.clear();
    await this.options.store.clear();
    this.notify(null);
  }

  /** Update the retention policy used by the next save. */
  setRetention(policy: Parameters<AiRunStore["setRetention"]>[0]): void {
    this.options.store.setRetention(policy);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(record: AiRunRecordV2 | null): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a view that throws must not break the run it is watching */
      }
    }
    if (record) this.options.onUpdate?.(summarizeRun(record));
  }
}