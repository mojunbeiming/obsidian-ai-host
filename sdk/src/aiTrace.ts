/**
 * What one AI run did, as steps a human can read.
 *
 * The complaint this exists for is "AI 功能不透明": the old panels showed a
 * spinner and a result, so a wrong card was indistinguishable from a wrong
 * prompt, a wrong model, a wrong file, or a parser that dropped half the reply.
 * A run trace makes every one of those a visible step with a timestamp, and
 * turns "why did it do that" into "scroll the process panel".
 *
 * Two boundaries are deliberate:
 *
 * * **No secrets.** `redactText` is applied to every detail before it is stored,
 *   so an Authorization line that reaches a log is a header name and a mask.
 * * **Memory only.** A trace is an object the view owns; nothing here writes to
 *   disk, and the plugin keeps at most a handful of finished runs. Copying the
 *   log is a user action, not a side effect.
 *
 * Pure: a clock and an id generator are injected.
 */

export type AiRunStatus = "running" | "ok" | "failed" | "cancelled";

/** The kinds of step a run can show. Kept small: a new kind should buy a UI. */
export type AiRunStepKind =
  | "context.read"
  | "context.plugin"
  | "context.summary"
  | "prompt.system"
  | "prompt.user"
  | "request"
  | "reasoning"
  | "delta"
  | "response.raw"
  | "parse"
  | "validate"
  | "tool.call"
  | "tool.result"
  | "write"
  | "error"
  | "done";

export interface AiRunStep {
  kind: AiRunStepKind;
  /** `Date.now()` at the moment the step was recorded. */
  at: number;
  /** One line the panel shows collapsed. */
  title: string;
  /** Expandable body: a prompt, a reply, an error. Already redacted. */
  detail?: string;
  /** Small structured extras for the row (counts, paths, durations). */
  meta?: Record<string, string | number | boolean>;
}

export interface AiRunSnapshot {
  id: string;
  startedAt: number;
  endedAt: number | null;
  status: AiRunStatus;
  summary: string;
  steps: AiRunStep[];
}

export interface AiRunTrace {
  readonly id: string;
  push(
    kind: AiRunStepKind,
    title: string,
    options?: { detail?: string; meta?: AiRunStep["meta"] },
  ): AiRunStep;
  /** A copy, so a listener cannot mutate the run by accident. */
  snapshot(): AiRunSnapshot;
  subscribe(listener: () => void): () => void;
  finish(status: Exclude<AiRunStatus, "running">, summary?: string): void;
}

export interface RunTraceOptions {
  now?: () => number;
  id?: string;
  /** Steps kept before the oldest are dropped; a runaway stream must not grow forever. */
  keepSteps?: number;
  /** Mirrors every step into a durable run store (see `aiRunLog`). */
  onStep?: (step: AiRunStep) => void;
  /** Called once when the run finishes, with the final snapshot. */
  onFinish?: (snapshot: AiRunSnapshot) => void;
}

const DEFAULT_KEEP_STEPS = 2_000;

let nextRunNumber = 0;

export function createRunTrace(options: RunTraceOptions = {}): AiRunTrace {
  const hooks = options;
  const now = options.now ?? (() => Date.now());
  const keepSteps = Math.max(10, options.keepSteps ?? DEFAULT_KEEP_STEPS);
  const id = options.id ?? `run-${(nextRunNumber += 1).toString(36)}-${now().toString(36)}`;
  const startedAt = now();
  const steps: AiRunStep[] = [];
  let status: AiRunStatus = "running";
  let summary = "";
  let endedAt: number | null = null;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* a listener that throws must not break the run it is watching */
      }
    }
  };

  return {
    id,
    push(kind, title, options = {}) {
      const step: AiRunStep = {
        kind,
        at: now(),
        title: redactText(title),
        ...(options.detail !== undefined ? { detail: redactText(options.detail) } : {}),
        ...(options.meta ? { meta: { ...options.meta } } : {}),
      };
      steps.push(step);
      while (steps.length > keepSteps) steps.shift();
      try {
        hooks.onStep?.(step);
      } catch {
        /* a mirror that throws must not break the run it is watching */
      }
      emit();
      return step;
    },
    snapshot() {
      return {
        id,
        startedAt,
        endedAt,
        status,
        summary,
        steps: steps.map((step) => ({ ...step, ...(step.meta ? { meta: { ...step.meta } } : {}) })),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    finish(next, nextSummary = "") {
      if (status !== "running") return;
      status = next;
      summary = nextSummary ? redactText(nextSummary) : "";
      endedAt = now();
      emit();
      try {
        hooks.onFinish?.(this.snapshot());
      } catch {
        /* a mirror that throws must not break the run it is watching */
      }
    },
  };
}

/** A copyable plain-text log of one run. */
export function traceToText(snapshot: AiRunSnapshot): string {
  const lines = [
    `运行 ${snapshot.id}  ${statusLabel(snapshot.status)}  开始 ${new Date(snapshot.startedAt).toISOString()}`,
  ];
  if (snapshot.summary) lines.push(`摘要：${snapshot.summary}`);
  for (const step of snapshot.steps) {
    const time = new Date(step.at).toISOString();
    const meta = step.meta
      ? ` ${Object.entries(step.meta).map(([key, value]) => `${key}=${String(value)}`).join(" ")}`
      : "";
    lines.push(`[${time}] ${step.kind} ${step.title}${meta}`);
    if (step.detail) {
      for (const line of step.detail.split(/\r?\n/)) lines.push(`    ${line}`);
    }
  }
  return lines.join("\n");
}

export function statusLabel(status: AiRunStatus): string {
  switch (status) {
    case "running":
      return "进行中";
    case "ok":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

/**
 * Mask anything that looks like a credential.
 *
 * Deliberately narrow: `sk-...`, a `Bearer <token>` pair, and common
 * `"apiKey": "..."` shapes. Over-redacting would hide the diagnosis a prompt is
 * read for; under-redacting would put a key in a copied log.
 */
export function redactText(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{4,})/g, (match) => `${match.slice(0, 3)}${"*".repeat(Math.max(4, match.length - 3))}`)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
    // The negative lookahead keeps the rule from eating the word Bearer: the
    // first rule already masked its value, and matching the word itself would
    // turn Authorization: Bearer *** into Authorization: *** ***.
    .replace(
      /((?:"|')?(?:api[_-]?key|token)(?:"|')?\s*[:=]\s*)("|')?((?!Bearer\b)[A-Za-z0-9._~+/=-]{6,})/gi,
      "$1$2***",
    );
}

/** Keep only the newest `limit` runs, newest first. */
export function keepRecentRuns(runs: readonly AiRunSnapshot[], limit: number): AiRunSnapshot[] {
  const count = Math.max(0, Math.floor(limit));
  return [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, count);
}