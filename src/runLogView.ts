/**
 * The run log: every plugin's trajectory in one list, with a step timeline.
 *
 * This is the durable half of the DSH-style view. The domain panes keep showing
 * the run they are doing; this view answers "what did the last failure look
 * like" and "show me all runs from yesterday", across the three plugins, with a
 * copyable report that never contains a key.
 */

import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { confirmAction } from "../sdk/src/uiDialogs";
import { PLUGIN_IDS } from "../sdk/src/api";
import { formatRunMarkdown, summarizeRun, type AiRunRecordV2, type AiRunSummary } from "../sdk/src/ai/aiRunLog";
import { renderRunTimeline, runMetaLine } from "./runTimeline";
import type SfcAiPlugin from "./main";

export const RUN_LOG_VIEW_TYPE = "sfc-ai-run-log";

const STATUS_LABEL: Record<string, string> = { running: "进行中", ok: "完成", failed: "失败", cancelled: "已取消" };

export class RunLogView extends ItemView {
  private filterPlugin = "";
  private filterStatus = "";
  private query = "";
  private selectedId: string | null = null;
  private summaries: AiRunSummary[] = [];
  private unsubscribe: (() => void) | null = null;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: SfcAiPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return RUN_LOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI 运行记录";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
    this.unsubscribe = this.plugin.getRunHub().subscribe(() => void this.refresh());
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private renderShell(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("sfc-run");
    const toolbar = root.createDiv({ cls: "sfc-run-toolbar" });
    const pluginFilter = toolbar.createEl("select", { cls: "dropdown" });
    pluginFilter.createEl("option", { value: "", text: "全部插件" });
    for (const id of [PLUGIN_IDS.ai, PLUGIN_IDS.flashcards, PLUGIN_IDS.todo]) pluginFilter.createEl("option", { value: id, text: id });
    pluginFilter.onchange = () => {
      this.filterPlugin = pluginFilter.value;
      void this.refresh();
    };
    const statusFilter = toolbar.createEl("select", { cls: "dropdown" });
    statusFilter.createEl("option", { value: "", text: "全部状态" });
    for (const status of ["running", "ok", "failed", "cancelled"]) statusFilter.createEl("option", { value: status, text: STATUS_LABEL[status] });
    statusFilter.onchange = () => {
      this.filterStatus = statusFilter.value;
      void this.refresh();
    };
    const search = toolbar.createEl("input", { cls: "sfc-run-search", type: "text", placeholder: "搜索标题 / 模型 / 错误码" });
    search.oninput = () => {
      this.query = search.value;
      void this.refresh();
    };
    const refresh = toolbar.createEl("button", { cls: "sfc-run-refresh", text: "刷新" });
    refresh.onclick = () => void this.refresh();
    const exportAll = toolbar.createEl("button", { text: "导出全部" });
    exportAll.onclick = () => void this.exportAll();
    const clear = toolbar.createEl("button", { text: "清空" });
    clear.onclick = () => void this.clearAll();

    const body = root.createDiv({ cls: "sfc-run-body" });
    this.listEl = body.createDiv({ cls: "sfc-run-list" });
    this.detailEl = body.createDiv({ cls: "sfc-run-detail" });
  }

  /** Used by "open last run" and by the status bar's click. */
  select(runId: string): void {
    this.selectedId = runId;
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.summaries = await this.plugin.getRunHub().list({
      ...(this.filterPlugin ? { pluginId: this.filterPlugin } : {}),
      ...(this.filterStatus ? { status: this.filterStatus } : {}),
      ...(this.query ? { query: this.query } : {}),
      limit: 200,
    });
    this.renderList();
    const selected = this.selectedId ?? this.summaries[0]?.id ?? null;
    this.selectedId = selected;
    const record = selected ? await this.plugin.getRunHub().read(selected) : null;
    this.renderDetail(record);
  }

  private renderList(): void {
    this.listEl.empty();
    if (!this.summaries.length) {
      this.listEl.createDiv({ cls: "sfc-run-empty", text: "还没有运行记录。发一条消息、跑一次制卡或更新一次索引就会出现在这里。" });
      return;
    }
    for (const summary of this.summaries) {
      const row = this.listEl.createDiv({ cls: "sfc-run-row" });
      row.toggleClass("sfc-run-row-active", summary.id === this.selectedId);
      const head = row.createDiv({ cls: "sfc-run-step-head" });
      head.createSpan({ cls: `sfc-run-badge sfc-run-status-${summary.status}`, text: STATUS_LABEL[summary.status] ?? summary.status });
      head.createSpan({ cls: "sfc-run-title", text: summary.title });
      const meta = row.createDiv({ cls: "sfc-run-meta" });
      meta.setText(
        [
          summary.pluginId,
          summary.kind,
          new Date(summary.startedAt).toLocaleString(),
          summary.durationMs !== undefined ? `${summary.durationMs} ms` : "",
          summary.firstErrorCode ?? "",
        ]
          .filter(Boolean)
          .join("  "),
      );
      row.onclick = () => {
        this.selectedId = summary.id;
        void this.refresh();
      };
    }
  }

  private renderDetail(record: AiRunRecordV2 | null): void {
    this.detailEl.empty();
    if (!record) {
      this.detailEl.createDiv({ cls: "sfc-run-empty", text: "选一条运行查看轨迹。" });
      return;
    }
    const head = this.detailEl.createDiv({ cls: "sfc-run-head" });
    head.createEl("h3", { text: record.title });
    head.createDiv({ cls: "sfc-run-meta", text: runMetaLine(record) });

    if (record.summary) head.createDiv({ cls: "sfc-run-summary", text: record.summary });

    const actions = this.detailEl.createDiv({ cls: "sfc-run-actions" });
    const copyMarkdown = actions.createEl("button", { text: "复制 Markdown" });
    copyMarkdown.onclick = () => void this.copy(formatRunMarkdown(record), "轨迹已复制到剪贴板。");
    const copyJson = actions.createEl("button", { text: "复制 JSON" });
    copyJson.onclick = () => void this.copy(JSON.stringify(record, null, 2), "轨迹 JSON 已复制到剪贴板。");

    renderRunTimeline(this.detailEl, record);
  }

  private async exportAll(): Promise<void> {
    const records: AiRunRecordV2[] = [];
    for (const summary of this.summaries.slice(0, 50)) {
      const record = await this.plugin.getRunHub().read(summary.id);
      if (record) records.push(record);
    }
    if (!records.length) {
      new Notice("没有可导出的运行记录。");
      return;
    }
    await this.copy(records.map((record) => formatRunMarkdown(record)).join("\n\n---\n\n"), `已复制 ${records.length} 条运行记录。`);
  }

  private async clearAll(): Promise<void> {
    if (!(await confirmAction(this.app, { title: "清空全部运行记录？", message: "日志文件会被删除，不可撤销。", cta: "清空", warning: true }))) return;
    await this.plugin.getRunHub().clear();
    new Notice("运行记录已清空。");
    await this.refresh();
  }

  private async copy(text: string, message: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(message);
    } catch {
      new Notice("剪贴板不可用，内容已写入控制台。");
      console.log(text);
    }
  }
}

/** One line for the status bar, phrased for the three states that matter. */
export function runBadgeText(summary: AiRunSummary): string {
  const label = STATUS_LABEL[summary.status] ?? summary.status;
  return `${label}：${summary.title}${summary.firstErrorCode ? `（${summary.firstErrorCode}）` : ""}`;
}

/** Re-exported so `main` does not import the SDK for one call. */
export { summarizeRun };