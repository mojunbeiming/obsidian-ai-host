/**
 * One run's steps, rendered as a timeline. Shared by the run-log view and the
 * chat pane's 轨迹 tab, which is the point: "the trace beside the conversation"
 * and "the trace in the log window" must not be two different renderings of the
 * same record, or they will disagree about what a failed step looks like.
 */

import type { AiRunRecordV2, AiRunStepV2 } from "../sdk/src/ai/aiRunLog";
import { formatRunError } from "../sdk/src/ai/aiErrors";

const STATUS_LABEL: Record<string, string> = { running: "进行中", ok: "完成", failed: "失败", cancelled: "已取消" };

export function runStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** The one-line metadata under a run title. */
export function runMetaLine(record: AiRunRecordV2): string {
  return [
    record.pluginId,
    record.kind,
    record.skillId ?? "",
    runStatusLabel(record.status),
    record.model ?? "",
    record.endedAt ? `${Math.max(0, record.endedAt - record.startedAt)} ms` : "",
    record.usage ? `${record.usage.prompt}+${record.usage.completion} tokens${record.usage.cached ? `（缓存 ${record.usage.cached}）` : ""}` : "",
    record.costUsd !== undefined ? `$${record.costUsd.toFixed(4)}` : "",
    record.interrupted ? "上次被中断" : "",
  ]
    .filter(Boolean)
    .join("  ");
}

function stepStatusClass(step: AiRunStepV2): string {
  if (step.level === "error" || step.status === "failed") return "failed";
  if (step.level === "warn") return "warn";
  return step.status === "running" ? "running" : "ok";
}

/**
 * Render the step list into `container`, replacing its children.
 *
 * Errors are part of the timeline, not a separate section with its own copy
 * semantics: a failed run's report should read top to bottom.
 */
export function renderRunTimeline(container: HTMLElement, record: AiRunRecordV2): void {
  container.empty();
  if (record.summary) container.createDiv({ cls: "sfc-run-summary", text: record.summary });
  if (!record.steps.length) {
    container.createDiv({ cls: "sfc-run-empty", text: "这条运行没有步骤记录。" });
    return;
  }
  for (const step of record.steps) {
    const row = container.createEl("details", { cls: "sfc-run-step" });
    const head = row.createEl("summary", { cls: "sfc-run-step-head" });
    head.createSpan({ cls: `sfc-run-badge sfc-run-status-${stepStatusClass(step)}`, text: step.level === "error" ? "错误" : step.status });
    head.createSpan({ text: step.kind });
    head.createSpan({ cls: "sfc-run-step-title", text: step.title });
    if (step.durationMs !== undefined) head.createSpan({ cls: "sfc-run-meta", text: `${step.durationMs} ms` });
    if (step.detail) row.createEl("pre", { cls: "sfc-run-step-detail", text: step.detail });
    if (step.meta && Object.keys(step.meta).length) {
      row.createEl("pre", {
        cls: "sfc-run-step-detail",
        text: Object.entries(step.meta)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join("  "),
      });
    }
  }
  if (record.errors.length) {
    container.createEl("h4", { text: "错误" });
    for (const error of record.errors) {
      const box = container.createDiv({ cls: "sfc-run-error" });
      box.createDiv({ cls: "sfc-run-error-title", text: `[${error.code}] ${error.userMessage}` });
      if (error.hint) box.createDiv({ cls: "sfc-run-meta", text: `提示：${error.hint}` });
      box.createEl("pre", { cls: "sfc-run-step-detail", text: formatRunError(error) });
    }
  }
}