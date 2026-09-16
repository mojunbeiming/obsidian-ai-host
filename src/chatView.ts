/**
 * The chat pane, now the workbench: sidebar, thread, agent panel, trace tab,
 * composer.
 *
 * This file is the *composition*: it owns which conversation is open, which
 * workspace that conversation belongs to, and the order of a send. Every widget
 * it draws lives in its own module (`sessionSidebar`, `messageList`,
 * `composer`, `runTimeline`), and every rule about messages, permissions,
 * budgets and checkpoints lives in the SDK. What is left here is the part that
 * genuinely needs the app: reading mentions, resolving templates, and connecting
 * the AgentRuntime's events to the DOM.
 */

import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  activeBranch,
  assembleChatMessages,
  compileUserMessage,
  ensureMessageMeta,
  estimateTokens,
  mentionKey,
  normalizeMention,
  ragScopeFromMentions,
  shouldUseVaultSearch,
  textOf,
  type AiChatMessage,
  type AiMention,
  type AiRagSnippet,
  type AiToolDefinition,
} from "../sdk/src/ai/aiChat";
import type { AiConversationRecord } from "../sdk/src/ai/aiConversationStore";
import { executeApprovedTool, toolResultMessages, type AiHostTool, type AiToolCallState } from "../sdk/src/ai/aiTools";
import { estimateCostUsd } from "../sdk/src/ai/aiPricing";
import { PLUGIN_IDS } from "../sdk/src/api";
import { iconName } from "../sdk/src/icons";
import {
  permissionLabel,
  workspaceAllowsPath,
  type AiPermissionTier,
  type AiWorkspace,
} from "../sdk/src/ai/aiWorkspace";
import { addUsage, emptyTokenTotals, formatComposerStats, type AiTokenTotals } from "../sdk/src/ai/aiUsageStats";
import { agentPlanProgress, formatAgentPlan, type AiAgentRunState } from "../sdk/src/ai/aiAgent";
import { runChatTurn, type ChatRuntimeStep, type ChatTurnResult } from "./chatRuntime";
import { ApplyDiffModal } from "./applyModal";
import type { AiRuntimeConfig } from "./providerConfig";
import { TemplateSuggestModal } from "./templateSuggest";
import { MentionIndex, currentFileContext, mentionCandidates, mentionFromCandidate, resolveMention, selectionMention } from "./vaultContext";
import { SessionSidebar } from "./sessionSidebar";
import { confirmAction, promptText } from "../sdk/src/uiDialogs";
import { MessageList } from "./messageList";
import { Composer, type ComposerState } from "./composer";
import { renderRunTimeline, runStatusLabel } from "./runTimeline";
import { permissionBanner, permissionChoices, resolveWorkspacePermission } from "./permissions";
import type { AgentEvent } from "./agentRuntime";
import type SfcAiPlugin from "./main";

export const AI_CHAT_VIEW_TYPE = "sfc-ai-chat-view";

interface PendingLoop {
  record: AiConversationRecord<AiChatMessage>;
  working: AiChatMessage[];
  states: AiToolCallState[];
  tools: AiHostTool[];
  config: AiRuntimeConfig;
  toolDefinitions: AiToolDefinition[];
  runId: string;
  round: number;
}

const MAX_TITLE = 24;

export class AiChatView extends ItemView {
  private record: AiConversationRecord<AiChatMessage> | null = null;
  private workspaceId = "";
  private controller: AbortController | null = null;
  private sending = false;
  private agentMode = false;
  private query = "";
  private collapsed = false;
  private mentions: AiMention[] = [];
  private useVaultSearch = false;
  private includeCurrentFile = false;
  private allowedTools = new Set<string>();
  private pending: PendingLoop | null = null;
  private sessionUsage: AiTokenTotals = emptyTokenTotals();
  private lastTurnUsage: AiTokenTotals = emptyTokenTotals();
  private checkpointIds: string[] = [];
  private sessionRounds = 0;
  /** True while the page-local 「新会话」 intent has no record yet. */
  private blankIntent = false;
  private sidebarWidth = 260;
  private lastRunId = "";
  private agentConversationId = "";
  private agentStreamStartedAt = 0;
  private workbenchObserver: ResizeObserver | null = null;
  private pickerEl: HTMLElement | null = null;
  private pickerItems: { mention: AiMention; label: string }[] = [];
  private pickerIndex = 0;
  private pickerQuery = "";
  private pickerTimer: number | null = null;
  private readonly mentionIndex: MentionIndex;
  private sidebar!: SessionSidebar;
  private messages!: MessageList;
  private composer!: Composer;
  private rootEl!: HTMLElement;
  private sidebarHostEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private threadEl!: HTMLElement;
  private planEl!: HTMLElement;
  private traceEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private composerHostEl!: HTMLElement;
  private tabChatEl!: HTMLElement;
  private tabTraceEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: SfcAiPlugin) {
    super(leaf);
    this.mentionIndex = new MentionIndex(this.app);
  }

  getViewType(): string {
    return AI_CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI Host 工作台";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    try {
      const settings = this.plugin.getSettings();
      this.includeCurrentFile = settings.chat.includeCurrentFile;
      this.agentMode = settings.agent.enabled;
      this.sidebarWidth = settings.chat.sidebarWidth;
      this.collapsed = settings.chat.sidebarCollapsed;
      this.renderShell();
      const store = this.plugin.getStore();
      const list = await store.list();
      const first = list[0];
      // Opening a pane must never write: a blank workbench is the page-local
      // 「新会话」 intent, materialized on first send. Creating a record here
      // is what filled the vault with empty conversations when the index was
      // unwritable.
      this.record = first ? await store.read(first.id) : null;
      this.blankIntent = !this.record;
      this.workspaceId = this.record?.workspaceId ?? settings.defaultWorkspaceId ?? this.plugin.listWorkspaces()[0]?.id ?? "";
      this.loadSessionUsage();
      await this.refreshSidebar();
      this.renderThread();
      await this.showCheckpointNotice();
    // The red banner counts down; repaint it while a grant is live.
    this.registerInterval(window.setInterval(() => {
      const workspace = this.currentWorkspace();
      if (workspace && (workspace.permission === "full" || workspace.permission === "trusted")) this.renderComposer();
    }, 30_000));
      this.registerEvent(this.app.vault.on("create", () => this.mentionIndex.invalidate()));
      this.registerEvent(this.app.vault.on("delete", () => this.mentionIndex.invalidate()));
      this.registerEvent(this.app.vault.on("rename", () => this.mentionIndex.invalidate()));
    } catch (error) {
      this.renderFatal(error);
    }
  }

  /** A visible failure beats a pane that silently does nothing. */
  private renderFatal(error: unknown): void {
    this.contentEl.empty();
    const box = this.contentEl.createDiv({ cls: "sfc-ai-fatal" });
    box.createDiv({ cls: "sfc-ai-fatal-title", text: "AI Host 工作台启动失败" });
    box.createEl("pre", {
      cls: "sfc-ai-fatal-detail",
      text: error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error),
    });
    const retry = box.createEl("button", { cls: "mod-cta", text: "重试" });
    retry.onclick = () => void this.onOpen();
  }

  async onClose(): Promise<void> {
    this.controller?.abort();
    this.closePicker();
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  private renderShell(): void {
    // The wrapper is explicit because Obsidian styles `.view-content` as a
    // column; putting `display:flex; flex-direction:row` on that element
    // loses the cascade and stacks the sidebar above the thread (the
    // screenshot bug). The wrapper owns the row layout; contentEl only hosts
    // it.
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({ cls: "sfc-ai-root" });
    this.applySidebarWidth();
    this.rootEl.toggleClass("sfc-ai-collapsed", this.collapsed);

    this.sidebarHostEl = this.rootEl.createDiv({ cls: "sfc-ai-side-host" });
    this.mainEl = this.rootEl.createDiv({ cls: "sfc-ai-main" });

    const topbar = this.mainEl.createDiv({ cls: "sfc-ai-topbar" });
    const collapseButton = topbar.createEl("button", { cls: "sfc-ai-ghost" });
    collapseButton.setAttr("aria-label", "折叠/展开侧栏");
    collapseButton.setAttr("title", "折叠/展开侧栏");
    // A named icon, not an empty string: `text: ""` is a button that renders
    // nothing at all, which is how half of this sidebar was reported blank.
    setIcon(collapseButton, iconName("panel-left"));
    collapseButton.onclick = () => this.toggleCollapsed();
    this.titleEl = topbar.createDiv({ cls: "sfc-ai-title", text: "未命名会话" });
    this.titleEl.setAttr("title", "点击重命名");
    this.titleEl.onclick = () => void this.renameConversation();
    const tabs = topbar.createDiv({ cls: "sfc-ai-tabs" });
    this.tabChatEl = tabs.createEl("button", { cls: "sfc-ai-tab", text: "对话" });
    this.tabChatEl.onclick = () => this.setTab("chat");
    this.tabTraceEl = tabs.createEl("button", { cls: "sfc-ai-tab", text: "轨迹" });
    this.tabTraceEl.onclick = () => this.setTab("trace");
    const spacer = topbar.createDiv({ cls: "sfc-ai-topbar-spacer" });
    void spacer;
    const exportButton = topbar.createEl("button", { cls: "sfc-ai-ghost", text: "导出" });
    exportButton.onclick = () => void this.exportConversation();
    const runsButton = topbar.createEl("button", { cls: "sfc-ai-ghost", text: "运行记录" });
    runsButton.onclick = () => void this.plugin.openRunLog();
    const settingsButton = topbar.createEl("button", { cls: "sfc-ai-ghost" });
    settingsButton.setAttr("aria-label", "设置");
    settingsButton.setAttr("title", "AI Host 设置");
    setIcon(settingsButton, iconName("settings"));
    settingsButton.onclick = () => {
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById(PLUGIN_IDS.ai);
    };

    this.threadEl = this.mainEl.createDiv({ cls: "sfc-ai-thread" });
    this.planEl = this.threadEl.createDiv({ cls: "sfc-ai-plan-panel" });
    this.planEl.hide();
    const messageHost = this.threadEl.createDiv({ cls: "sfc-ai-message-host" });
    this.messages = new MessageList(messageHost, {
      onRetract: (id) => this.guard("撤回", () => this.setMessageStatus(id, "retracted")),
      onRestore: (id) => this.guard("恢复", () => this.setMessageStatus(id, "active")),
      onEdit: (id) => this.guard("编辑", () => this.editMessage(id)),
      onRegenerate: (id) => this.guard("重新生成", () => this.regenerate(id)),
      onDelete: (id) => this.guard("删除消息", () => this.deleteMessage(id)),
      onApply: () => this.guard("应用", () => this.applyToCurrentFile()),
      onCopy: (text) => this.guard("复制", () => this.copy(text, "已复制。")),
      onTrace: (runId) => this.openTraceFor(runId),
    });

    this.traceEl = this.mainEl.createDiv({ cls: "sfc-ai-trace" });
    this.traceEl.hide();

    const picker = this.mainEl.createDiv({ cls: "sfc-ai-picker" });
    picker.hide();
    this.pickerEl = picker;

    const composerHost = this.mainEl.createDiv({ cls: "sfc-ai-composer-host" });
    this.composerHostEl = composerHost;
    this.composer = new Composer(composerHost, {
      onSend: () => this.guard("发送", () => this.send()),
      onStop: () => this.stopCurrent(),
      onPermission: (tier) => this.guard("权限", () => this.setPermission(tier)),
      onProvider: (value) => this.guard("模型", () => this.setProvider(value)),
      onToggle: (kind) => this.toggleComposer(kind),
      onRemoveMention: (mention) => this.removeMention(mention),
      onTemplate: () => this.openTemplatePicker(),
      onKeydown: (event) => this.onComposerKeydown(event),
    });
    this.inputElUpdater();

    this.sidebar = new SessionSidebar(this.sidebarHostEl, {
      onSelect: (id) => this.guard("打开会话", () => this.openConversation(id)),
      onNew: () => this.guard("新会话", () => this.newConversation()),
      onRename: (id) => this.guard("重命名", () => this.renameConversationById(id)),
      onDelete: (id) => this.guard("删除会话", () => this.deleteConversationById(id)),
      onPin: (id, pinned) => this.guard("置顶", () => this.pinConversation(id, pinned)),
      onSearch: (value) => {
        this.query = value;
        this.guard("搜索", () => this.refreshSidebar());
      },
      onNewWorkspace: () => this.plugin.openWorkspaceBuilder(),
      onRenameWorkspace: (id) => this.guard("重命名工作区", () => this.renameWorkspace(id)),
      onSettings: () => this.plugin.openSettings(),
      onToggleCollapse: () => this.toggleCollapsed(),
      onRequestExpand: () => this.expandSidebar(),
    });
    this.sidebar.render({
      summaries: [],
      workspaces: this.plugin.listWorkspaces(),
      activeId: this.record?.id ?? null,
      query: this.query,
      collapsed: this.collapsed,
      blank: false,
    });
    this.installWorkbench();
  }

  /** Resize handle + narrow auto-rail: the pane must work in a 300px leaf. */
  private installWorkbench(): void {
    // Retry after a fatal error re-runs renderShell; one observer, not two.
    this.workbenchObserver?.disconnect();
    const handle = this.sidebarHostEl.createDiv({ cls: "sfc-ai-resize" });
    handle.setAttr("aria-label", "拖动调整侧栏宽度");
    handle.addEventListener("mousedown", (event) => this.startResize(event));
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      this.rootEl.toggleClass("sfc-ai-narrow", width < 560);
    });
    observer.observe(this.contentEl);
    this.workbenchObserver = observer;
    this.register(() => observer.disconnect());
  }

  private startResize(event: MouseEvent): void {
    if (this.collapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.sidebarWidth;
    const move = (moveEvent: MouseEvent): void => {
      this.sidebarWidth = Math.min(480, Math.max(180, startWidth + moveEvent.clientX - startX));
      this.applySidebarWidth();
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      this.guard("侧栏宽度", () => this.plugin.patchChat({ sidebarWidth: this.sidebarWidth }));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  private applySidebarWidth(): void {
    this.rootEl.style.setProperty("--sfc-ai-side-width", `${this.sidebarWidth}px`);
  }

  /** The page-local new-session intent: no record until the first send. */
  private beginBlankIntent(): void {
    this.record = null;
    this.blankIntent = true;
    this.pending = null;
    this.allowedTools.clear();
    this.sessionUsage = emptyTokenTotals();
    this.sessionRounds = 0;
    this.lastRunId = "";
  }

  /** Wire the composer's own keydown hook to the picker without a second listener. */
  private inputElUpdater(): void {
    this.composer.inputEl.addEventListener("input", () => {
      this.composer.setSendEnabled(Boolean(this.composer.value().trim()));
      if (this.pickerTimer !== null) window.clearTimeout(this.pickerTimer);
      this.pickerTimer = window.setTimeout(() => {
        this.pickerTimer = null;
        this.updatePicker();
      }, 120);
    });
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.rootEl.toggleClass("sfc-ai-collapsed", this.collapsed);
    this.guard("侧栏", async () => {
      await this.refreshSidebar();
      await this.plugin.patchChat({ sidebarCollapsed: this.collapsed });
    });
  }

  /** The rail's search icon: expand first, focus after the slide. */
  private expandSidebar(): void {
    if (!this.collapsed) {
      this.sidebar.focusSearch();
      return;
    }
    this.collapsed = false;
    this.rootEl.toggleClass("sfc-ai-collapsed", false);
    this.guard("展开侧栏", async () => {
      await this.refreshSidebar();
      await this.plugin.patchChat({ sidebarCollapsed: false });
      window.setTimeout(() => this.sidebar.focusSearch(), 180);
    });
  }

  private setTab(tab: "chat" | "trace"): void {
    this.tabChatEl.toggleClass("sfc-ai-tab-active", tab === "chat");
    this.tabTraceEl.toggleClass("sfc-ai-tab-active", tab === "trace");
    this.threadEl.toggleClass("sfc-ai-hidden", tab !== "chat");
    this.traceEl.toggleClass("sfc-ai-hidden", tab !== "trace");
    this.composerHostToggle(tab === "chat");
    if (tab === "trace") void this.renderTrace();
  }

  private composerHostToggle(visible: boolean): void {
    this.composerHostEl.toggleClass("sfc-ai-hidden", !visible);
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  private async refreshSidebar(): Promise<void> {
    const list = await this.plugin.getStore().list();
    this.sidebar.render({
      summaries: list,
      workspaces: this.plugin.listWorkspaces(),
      activeId: this.record?.id ?? null,
      query: this.query,
      collapsed: this.collapsed,
      blank: this.blankIntent,
    });
  }

  private async renameWorkspace(id: string): Promise<void> {
    const workspace = this.plugin.getWorkspace(id);
    if (!workspace) return;
    const name = await promptText(this.app, { title: "工作区名称", value: workspace.name });
    if (!name?.trim()) return;
    await this.plugin.patchWorkspace(id, { name: name.trim() });
    await this.refreshSidebar();
    this.renderPlanPanel();
  }

  private async openConversation(id: string): Promise<void> {
    if (this.sending) {
      new Notice("正在生成，先停止再切换会话。");
      await this.refreshSidebar();
      return;
    }
    const record = await this.plugin.getStore().read(id);
    if (!record) {
      new Notice("这个会话的文件读不出来，可能已损坏。");
      return;
    }
    this.record = record;
    this.blankIntent = false;
    this.workspaceId = record.workspaceId ?? this.plugin.getSettings().defaultWorkspaceId ?? this.workspaceId;
    this.allowedTools.clear();
    this.pending = null;
    this.loadSessionUsage();
    this.renderThread();
    await this.refreshSidebar();
  }

  private async newConversation(): Promise<void> {
    if (this.sending) {
      new Notice("正在生成，先停止再新建会话。");
      return;
    }
    // Explicitly requested: open a blank workbench, not an empty record.
    // The record is created by the first send, so a click-and-abandon
    // leaves no row behind.
    this.beginBlankIntent();
    this.renderThread();
    await this.refreshSidebar();
    this.composer.focus();
  }

  private async renameConversation(): Promise<void> {
    if (!this.record) return;
    await this.renameConversationById(this.record.id);
  }

  private async renameConversationById(id: string): Promise<void> {
    const record = this.record?.id === id ? this.record : await this.plugin.getStore().read(id);
    if (!record) return;
    const title = await promptText(this.app, { title: "会话名称", value: record.title });
    if (!title?.trim()) return;
    await this.plugin.getStore().rename(id, title);
    if (this.record?.id === id) this.record.title = title.trim();
    await this.refreshSidebar();
    this.renderTitle();
  }

  private async deleteConversationById(id: string): Promise<void> {
    if (!(await confirmAction(this.app, { title: "删除这个会话？", message: "删除后不可撤销。", cta: "删除", warning: true }))) return;
    await this.plugin.getStore().remove(id);
    if (this.record?.id === id) {
      const list = await this.plugin.getStore().list();
      const first = list[0];
      this.record = first ? await this.plugin.getStore().read(first.id) : null;
      this.blankIntent = !this.record;
      this.loadSessionUsage();
      this.renderThread();
    }
    await this.refreshSidebar();
  }

  private async pinConversation(id: string, pinned: boolean): Promise<void> {
    await this.plugin.getStore().pin(id, pinned);
    await this.refreshSidebar();
  }

  private renderTitle(): void {
    if (!this.record) return;
    const workspace = this.currentWorkspace();
    this.titleEl.setText(this.record.title);
    this.titleEl.setAttr("title", workspace ? `${this.record.title}  工作区：${workspace.name}` : this.record.title);
  }

  private loadSessionUsage(): void {
    const meta = this.record?.meta as { usage?: AiTokenTotals; rounds?: number } | undefined;
    this.sessionUsage = meta?.usage ? { ...emptyTokenTotals(), ...meta.usage } : emptyTokenTotals();
    this.sessionRounds = typeof meta?.rounds === "number" ? meta.rounds : this.countRounds();
  }

  private countRounds(): number {
    return (this.record?.messages ?? []).filter((message) => message.role === "user").length;
  }

  private async saveRecord(): Promise<void> {
    if (!this.record) return;
    this.record.updatedAt = Date.now();
    this.record.meta = {
      ...(this.record.meta ?? {}),
      usage: { ...this.sessionUsage },
      rounds: this.sessionRounds,
      ...(this.lastRunId ? { lastRunId: this.lastRunId } : {}),
    };
    this.record = await this.plugin.getStore().save(this.record);
  }

  // -------------------------------------------------------------------------
  // Workspace / permission / model
  // -------------------------------------------------------------------------

  private currentWorkspace(): AiWorkspace | null {
    return this.plugin.getWorkspace(this.workspaceId);
  }

  private async applyWorkspaceToConversation(): Promise<void> {
    if (!this.record) return;
    this.record.workspaceId = this.workspaceId || undefined;
    await this.saveRecord();
    await this.refreshSidebar();
    this.renderTitle();
  }

  private async setPermission(tier: AiPermissionTier): Promise<void> {
    const workspace = this.currentWorkspace();
    if (!workspace) {
      new Notice("先为这个会话选择一个工作区。");
      this.renderComposer();
      return;
    }
    const settings = this.plugin.getSettings();
    const expiresAt = tier === "full" || tier === "trusted" ? Date.now() + settings.permission.fullExpiryMinutes * 60_000 : undefined;
    await this.plugin.patchWorkspace(workspace.id, {
      permission: tier,
      ...(expiresAt ? { permissionExpiresAt: expiresAt } : { permissionExpiresAt: undefined }),
    });
    this.renderComposer();
    this.renderPlanPanel();
    if (tier === "full") {
      new Notice(`完全权限已开启，${settings.permission.fullExpiryMinutes} 分钟后自动降级。撤销入口在设置里。`, 8000);
    }
  }

  private async setProvider(value: string): Promise<void> {
    const workspace = this.currentWorkspace();
    const row = this.plugin.getProviderRows().find((entry) => entry.id === value);
    if (!workspace || !row) return;
    await this.plugin.patchWorkspace(workspace.id, { providerId: row.id, model: row.model });
    this.renderComposer();
  }

  private toggleComposer(kind: "current-file" | "rag" | "agent"): void {
    if (kind === "current-file") this.includeCurrentFile = !this.includeCurrentFile;
    else if (kind === "rag") this.useVaultSearch = !this.useVaultSearch;
    else this.agentMode = !this.agentMode;
    if (kind === "agent" && this.agentMode) {
      new Notice("Agent 模式：多步执行，受预算、权限与备份约束。", 6000);
    }
    this.renderComposer();
  }

  private renderComposer(): void {
    const settings = this.plugin.getSettings();
    const workspace = this.currentWorkspace();
    const resolved = workspace ? resolveWorkspacePermission(workspace, settings) : null;
    const rows = this.plugin.getProviderRows();
    const state: ComposerState = {
      mentions: this.mentions,
      includeCurrentFile: this.includeCurrentFile,
      useVaultSearch: this.useVaultSearch,
      agentMode: this.agentMode,
      permission: resolved?.tier ?? "standard",
      permissionHint: permissionChoices(settings)
        .map((choice) => `${choice.label}：${choice.description}`)
        .join("\n"),
      providerValue: workspace?.providerId || this.plugin.currentProviderId(),
      providers: rows
        .filter((row) => row.enabled)
        .map((row) => ({ value: row.id, label: `${row.label}  ${workspace?.model || row.model}` })),
      busy: this.sending,
      stats: this.statsLine(),
      banner: workspace ? permissionBanner(workspace, settings) : null,
      sendOnEnter: settings.chat.sendOnEnter,
    };
    this.composer.update(state);
    this.composer.setSendEnabled(Boolean(this.composer.value().trim()));
  }

  private statsLine(): string {
    const workspace = this.currentWorkspace();
    const settings = this.plugin.getSettings();
    const agentState = this.plugin.getAgentRuntime().getState();
    const steps = agentState && (this.agentMode || this.sending) ? agentState.steps.length : 0;
    return formatComposerStats({
      rounds: this.sessionRounds,
      steps,
      run: agentState ? agentState.usage : this.lastTurnUsage,
      session: this.sessionUsage,
      costUsd: null,
    }) + (workspace ? `  ${permissionLabel(resolveWorkspacePermission(workspace, settings).tier)}` : "");
  }

  // -------------------------------------------------------------------------
  // Thread rendering
  // -------------------------------------------------------------------------

  /**
   * Run a UI action with a visible failure path.
   *
   * Every callback goes through this. The store bug that made 「新会话」 a
   * silent no-op was an unhandled promise rejection: the workbench must
   * never be able to fail without saying so.
   */
  private guard(scope: string, action: () => void | Promise<void>): void {
    void (async () => {
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[sfc-ai] ${scope}:`, error);
        new Notice(`AI Host 出错（${scope}）：${message}`, 8000);
      }
    })();
  }

  private renderThread(): void {
    if (this.blankIntent) this.titleEl.setText("新会话");
    else this.renderTitle();
    const messages = this.record?.messages ?? [];
    if (!messages.some((message) => message.role !== "system")) {
      this.messages.renderHero((text) => {
        this.composer.inputEl.value = text;
        this.composer.focus();
      });
    } else {
      this.messages.render(activeBranchView(messages));
      this.attachLastRunButton();
    }
    this.renderPlanPanel();
    this.renderComposer();
    this.renderFloating();
  }

  /** Retracted turns stay visible; superseded ones are hidden from the thread. */
  private attachLastRunButton(): void {
    const record = this.record;
    if (!record) return;
    const last = [...record.messages].reverse().find((message) => message.role === "assistant" && message.runId);
    const runId = (record.meta?.lastRunId as string | undefined) ?? last?.runId ?? "";
    if (runId) this.lastRunId = runId;
  }

  private renderFloating(): void {
    const existing = this.threadEl.querySelector(".sfc-ai-floating");
    existing?.remove();
    const floating = this.threadEl.createDiv({ cls: "sfc-ai-floating" });
    const copy = floating.createEl("button", { cls: "sfc-ai-ghost", text: "复制会话" });
    copy.onclick = () => void this.copy(this.conversationMarkdown(), "会话已复制为 Markdown。");
    const trace = floating.createEl("button", { cls: "sfc-ai-ghost", text: "打开轨迹" });
    trace.onclick = () => this.setTab("trace");
    const bottom = floating.createEl("button", { cls: "sfc-ai-ghost", text: "回到底部" });
    bottom.onclick = () => this.messages.scrollToBottom();
  }

  private renderPlanPanel(): void {
    const state = this.plugin.getAgentRuntime().getState();
    const workspace = this.currentWorkspace();
    const checkpoints = this.checkpointIds;
    this.planEl.empty();
    if (!state && !checkpoints.length && !workspace) {
      this.planEl.hide();
      return;
    }
    this.planEl.show();
    if (!state) {
      const head = this.planEl.createDiv({ cls: "sfc-ai-plan-head" });
      head.createSpan({ cls: "sfc-ai-plan-title", text: "工作区" });
      head.createSpan({ cls: "sfc-ai-plan-status", text: workspace ? workspace.name : "未选择" });
      this.planEl.createDiv({
        cls: "sfc-ai-plan-note",
        text: workspace
          ? `${workspace.folders.length ? workspace.folders.join("、") : "整个库"}  ${permissionLabel(resolveWorkspacePermission(workspace, this.plugin.getSettings()).tier)}`
          : "在侧栏新建工作区，限定 Agent 能读写的文件夹。",
      });
      const picker = this.planEl.createEl("select", { cls: "dropdown" });
      picker.createEl("option", { value: "", text: "未分组（全库，不限定）" });
      for (const entry of this.plugin.listWorkspaces()) picker.createEl("option", { value: entry.id, text: entry.name });
      picker.value = this.workspaceId;
      picker.onchange = () => {
        this.workspaceId = picker.value;
        void this.applyWorkspaceToConversation().then(() => this.renderPlanPanel());
      };
      if (checkpoints.length) {
        const resume = this.planEl.createEl("button", { cls: "mod-cta", text: `继续上次 Agent（${checkpoints.length} 个检查点）` });
        resume.onclick = () => void this.resumeCheckpoint();
      }
      return;
    }
    const head = this.planEl.createDiv({ cls: "sfc-ai-plan-head" });
    head.createSpan({ cls: "sfc-ai-plan-title", text: "Agent 计划" });
    head.createSpan({ cls: `sfc-ai-plan-status sfc-ai-plan-status-${state.status}`, text: agentPlanProgress(state.plan).label });
    this.planEl.createEl("pre", { cls: "sfc-ai-plan-body", text: formatAgentPlan(state.plan) });
    const meta = this.planEl.createDiv({ cls: "sfc-ai-plan-meta" });
    meta.setText(
      [
        agentStatusText(state),
        `${state.steps.length}/${state.budget.maxSteps} 步`,
        `${state.usage.total} tokens`,
        state.costUsd ? `$${state.costUsd.toFixed(4)}` : "",
      ]
        .filter(Boolean)
        .join("    "),
    );
    const actions = this.planEl.createDiv({ cls: "sfc-ai-plan-actions" });
    if (state.status === "paused_user") {
      const resume = actions.createEl("button", { cls: "mod-cta", text: "继续" });
      resume.onclick = () => this.plugin.getAgentRuntime().resumeRun();
    } else if (state.status === "running" || state.status === "planning") {
      const pause = actions.createEl("button", { text: "暂停" });
      pause.onclick = () => this.plugin.getAgentRuntime().pause();
    }
    if (state.status !== "done" && state.status !== "failed" && state.status !== "cancelled" && state.status !== "budget_exceeded") {
      const stop = actions.createEl("button", { cls: "mod-warning", text: "终止" });
      stop.onclick = () => this.stopCurrent();
    }
    if (state.writes.length) {
      const undo = actions.createEl("button", { text: `撤销本次全部写入（${new Set(state.writes.map((entry) => entry.path)).size} 个文件）` });
      undo.onclick = () => void this.undoAgentBatch(state);
    }
    const pending = state.pendingApproval;
    if (pending) {
      const card = this.planEl.createDiv({ cls: "sfc-ai-approval" });
      card.createDiv({ cls: "sfc-ai-approval-title", text: `等待确认：${pending.summary}` });
      card.createDiv({ cls: "sfc-ai-approval-note", text: `工具 ${pending.tool}${pending.path ? `  ${pending.path}` : ""}` });
      const buttons = card.createDiv({ cls: "sfc-ai-tool-actions" });
      const allow = buttons.createEl("button", { cls: "mod-cta", text: "运行一次" });
      allow.onclick = () => this.plugin.getAgentRuntime().approve(pending.callId, "allow");
      const allowRun = buttons.createEl("button", { text: "本次运行都允许" });
      allowRun.onclick = () => this.plugin.getAgentRuntime().approve(pending.callId, "allow-run");
      const reject = buttons.createEl("button", { text: "拒绝" });
      reject.onclick = () => this.plugin.getAgentRuntime().approve(pending.callId, "reject");
    }
  }

  private async resumeCheckpoint(): Promise<void> {
    const checkpoints = await this.plugin.getAgentRuntime().loadCheckpoints();
    const first = checkpoints[0];
    if (!first) return;
    const workspace = this.plugin.getWorkspace(first.state.workspaceId);
    if (!workspace) {
      new Notice("检查点的工作区已删除，无法继续。");
      await this.plugin.getAgentRuntime().discardCheckpoint(first.state.id);
      this.renderPlanPanel();
      return;
    }
    this.workspaceId = workspace.id;
    this.agentMode = true;
    this.agentConversationId = this.record?.id ?? "";
    this.sending = true;
    this.agentStreamStartedAt = Date.now();
    this.renderComposer();
    this.messages.appendStreaming();
    void this.plugin
      .getAgentRuntime()
      .resume(first)
      .catch((error: unknown) => new Notice(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.sending = false;
        this.renderThread();
      });
  }

  private openTraceFor(runId: string): void {
    this.lastRunId = runId;
    this.setTab("trace");
  }

  // -------------------------------------------------------------------------
  // Message actions
  // -------------------------------------------------------------------------

  private async setMessageStatus(id: string, status: AiChatMessage["status"]): Promise<void> {
    const record = this.record;
    if (!record) return;
    record.messages = record.messages.map((message) => (message.id === id ? { ...message, status, editedAt: Date.now() } : message));
    await this.saveRecord();
    this.renderThread();
  }

  private async editMessage(id: string): Promise<void> {
    const record = this.record;
    if (!record) return;
    const message = record.messages.find((entry) => entry.id === id);
    if (!message) return;
    const next = await promptText(this.app, {
      title: "编辑这条消息",
      value: textOf(message.content),
      placeholder: "保存后会重跑后续回合",
      requireValue: false,
    });
    if (next === null) return;
    const editedAt = Date.now();
    const anchor = record.messages.findIndex((entry) => entry.id === id);
    record.messages = record.messages.map((entry, position) => {
      if (entry.id === id) {
        return { ...entry, content: next, promptContent: next, editedAt, revision: (entry.revision ?? 1) + 1 };
      }
      if (position > anchor && entry.status !== "retracted") return { ...entry, status: "superseded" as const, editedAt };
      return entry;
    });
    this.removeMentionsForMessage(message);
    await this.saveRecord();
    this.renderThread();
    await this.rerun();
  }

  private removeMentionsForMessage(message: AiChatMessage): void {
    for (const mention of message.mentionables ?? []) {
      this.mentions = this.mentions.filter((entry) => mentionKey(entry) !== mentionKey(mention));
    }
    this.renderComposer();
  }

  private async regenerate(id: string): Promise<void> {
    const record = this.record;
    if (!record) return;
    const index = record.messages.findIndex((message) => message.id === id);
    if (index < 0) return;
    record.messages = record.messages.map((message, position) =>
      position >= index && message.status !== "retracted" ? { ...message, status: "superseded" as const, editedAt: Date.now() } : message,
    );
    await this.saveRecord();
    this.renderThread();
    await this.rerun();
  }

  private async deleteMessage(id: string): Promise<void> {
    const record = this.record;
    if (!record) return;
    const target = record.messages.find((message) => message.id === id);
    if (!target) return;
    const removeTitle = target.role === "assistant" ? "删除这条回复及其工具结果？" : "删除这条消息？";
    if (!(await confirmAction(this.app, { title: removeTitle, cta: "删除", warning: true }))) return;
    const orphanIds = new Set((target.toolCalls ?? []).map((call) => call.id));
    record.messages = record.messages.filter((message) => message.id !== id && !(message.toolCallId && orphanIds.has(message.toolCallId)));
    await this.saveRecord();
    this.renderThread();
  }

  /** Re-run the last active user turn: used by 编辑并重跑 / 重新生成. */
  private async rerun(): Promise<void> {
    const record = this.record;
    if (!record) return;
    const history = activeBranch(record.messages);
    const lastUser = [...history].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    const runtime = this.plugin.runtimeFor("chat");
    if (!runtime.ok) {
      new Notice(runtime.message);
      return;
    }
    const settings = this.plugin.getSettings();
    const runId = this.plugin.beginRun({
      pluginId: PLUGIN_IDS.ai,
      kind: "chat",
      title: textOf(lastUser.content).slice(0, MAX_TITLE) || "重新生成",
      conversationId: record.id,
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      providerId: runtime.config.providerId,
      model: runtime.config.model,
    });
    this.lastRunId = runId;
    const toolDefinitions: AiToolDefinition[] = settings.tools.enabled
      ? this.plugin.getVaultTools().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      : [];
    const working = assembleChatMessages({
      level: "default",
      customSystemPrompt: settings.chat.systemPrompt,
      history: history.filter((message) => message.id !== lastUser.id),
      userText: textOf(lastUser.content),
      userPromptContent: lastUser.promptContent,
      userMentions: lastUser.mentionables ?? [],
      currentFile: null,
      includeCurrentFile: false,
      ragSnippets: [],
      maxContextMessages: settings.chat.maxContextMessages,
    });
    await this.runTurnLoop(record, runtime.config, working, toolDefinitions, runId, 0);
  }

  // -------------------------------------------------------------------------
  // Composer: picker and templates
  // -------------------------------------------------------------------------

  private onComposerKeydown(event: KeyboardEvent): boolean {
    const pickerOpen = this.pickerEl !== null && this.pickerEl.style.display !== "none";
    if (!pickerOpen) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.pickerIndex = Math.min(this.pickerItems.length - 1, this.pickerIndex + 1);
      this.renderPicker();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.pickerIndex = Math.max(0, this.pickerIndex - 1);
      this.renderPicker();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      this.choosePicker(this.pickerIndex);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.closePicker();
      return true;
    }
    return false;
  }

  private updatePicker(): void {
    const inputEl = this.composer.inputEl;
    const before = inputEl.value.slice(0, inputEl.selectionStart ?? inputEl.value.length);
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!at) {
      this.closePicker();
      return;
    }
    this.pickerQuery = at[1] ?? "";
    const items: { mention: AiMention; label: string }[] = [];
    const workspace = this.currentWorkspace();
    const vaultMention = normalizeMention({ type: "vault" });
    if (vaultMention && (!this.pickerQuery || "整个库".includes(this.pickerQuery))) {
      items.push({ mention: vaultMention, label: "整个库（触发向量检索）" });
    }
    const active = this.app.workspace.getActiveFile();
    if (active && (!workspace || workspaceAllowsPath(workspace, active.path))) {
      const current = normalizeMention({ type: "current-file", path: active.path });
      if (current && (!this.pickerQuery || active.basename.toLowerCase().includes(this.pickerQuery.toLowerCase()))) {
        items.push({ mention: current, label: `当前文件：${active.basename}` });
      }
    }
    for (const candidate of mentionCandidates(this.app, this.pickerQuery, 20, this.mentionIndex)) {
      if (workspace && !workspaceAllowsPath(workspace, candidate.path)) continue;
      const mention = mentionFromCandidate(candidate);
      if (mention) items.push({ mention, label: `${candidate.name}  ${candidate.path}` });
    }
    if (!items.length) {
      this.closePicker();
      return;
    }
    this.pickerItems = items;
    this.pickerIndex = 0;
    this.renderPicker();
  }

  private renderPicker(): void {
    if (!this.pickerEl) return;
    this.pickerEl.empty();
    this.pickerEl.show();
    this.pickerItems.forEach((item, index) => {
      const row = this.pickerEl!.createDiv({ cls: "sfc-ai-picker-row" });
      row.setText(item.label);
      row.toggleClass("sfc-ai-picker-active", index === this.pickerIndex);
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.choosePicker(index);
      });
    });
  }

  private choosePicker(index: number): void {
    const item = this.pickerItems[index];
    if (!item) return;
    this.addMention(item.mention);
    const value = this.composer.inputEl.value;
    const cursor = this.composer.inputEl.selectionStart ?? value.length;
    const removeFrom = cursor - (this.pickerQuery.length + 1);
    this.composer.replaceRange(removeFrom, cursor, "");
    this.closePicker();
  }

  private closePicker(): void {
    if (!this.pickerEl) return;
    this.pickerEl.empty();
    this.pickerEl.hide();
  }

  private addMention(mention: AiMention): void {
    const key = mentionKey(mention);
    if (this.mentions.some((entry) => mentionKey(entry) === key)) return;
    this.mentions.push(mention);
    this.renderComposer();
  }

  private removeMention(mention: AiMention): void {
    const key = mentionKey(mention);
    this.mentions = this.mentions.filter((entry) => mentionKey(entry) !== key);
    this.renderComposer();
  }

  private openTemplatePicker(): void {
    if (!this.app.workspace.getActiveFile() && this.mentions.length === 0) {
      const selection = selectionMention(this.app);
      if (selection) this.addMention(selection);
    }
    const modal = new TemplateSuggestModal(
      this.app,
      this.plugin.getTemplates(),
      (chosen) => {
        void this.plugin
          .getTemplates()
          .read(chosen)
          .then((content) => {
            this.composer.replaceRange(this.composer.caret(), this.composer.caret(), content);
          });
      },
      () => undefined,
    );
    modal.open();
  }

  // -------------------------------------------------------------------------
  // Sending: chat
  // -------------------------------------------------------------------------

  private async send(): Promise<void> {
    const text = this.composer.value().trim();
    if (!text || this.sending) return;
    if (this.agentMode) {
      await this.startAgent(text);
      return;
    }
    let record = this.record;
    if (!record) {
      record = await this.plugin.getStore().create({
        title: text.slice(0, MAX_TITLE) || "未命名会话",
        ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      });
      this.record = record;
      this.blankIntent = false;
      await this.refreshSidebar();
    }
    const runtime = this.plugin.runtimeFor("chat");
    if (!runtime.ok) {
      new Notice(runtime.message);
      return;
    }
    const settings = this.plugin.getSettings();
    if (record.messages.length === 0) record.title = text.slice(0, MAX_TITLE);
    record.workspaceId = this.workspaceId || undefined;
    const resolved = await Promise.all(this.mentions.map((mention) => resolveMention(this.app, mention)));
    const compiled = compileUserMessage({ text, resolved });
    const mentions = [...this.mentions];
    record.messages.push(
      ensureMessageMeta({
        role: "user",
        content: text,
        promptContent: compiled.promptContent,
        ...(mentions.length ? { mentionables: mentions } : {}),
      }),
    );
    this.composer.clear();
    this.mentions = [];
    this.renderComposer();
    await this.saveRecord();
    this.renderThread();

    const currentFile = this.includeCurrentFile ? await currentFileContext(this.app) : null;
    const snippets = await this.maybeRetrieve(text, compiled.promptContent, currentFile?.content ?? "", mentions);
    const runId = this.plugin.beginRun({
      pluginId: PLUGIN_IDS.ai,
      kind: "chat",
      title: text.slice(0, MAX_TITLE) || "聊天",
      conversationId: record.id,
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      providerId: runtime.config.providerId,
      model: runtime.config.model,
    });
    this.lastRunId = runId;
    this.plugin.traceRun(runId, {
      kind: "context.summary",
      title: `上下文：${mentions.length} 个提及${this.includeCurrentFile ? " + 当前文件" : ""}${snippets.length ? ` + 检索 ${snippets.length} 段` : ""}`,
      meta: { mentions: mentions.length, ragSnippets: snippets.length, history: record.messages.length },
    });
    const toolDefinitions: AiToolDefinition[] = settings.tools.enabled
      ? this.plugin.getVaultTools().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      : [];
    const working = assembleChatMessages({
      level: "default",
      customSystemPrompt: settings.chat.systemPrompt,
      history: activeBranch(record.messages).slice(0, -1),
      userText: text,
      userPromptContent: compiled.promptContent,
      userMentions: mentions,
      currentFile,
      includeCurrentFile: this.includeCurrentFile,
      ragSnippets: snippets,
      maxContextMessages: settings.chat.maxContextMessages,
    });
    this.sessionRounds += 1;
    await this.runTurnLoop(record, runtime.config, working, toolDefinitions, runId, 0);
  }

  private async maybeRetrieve(
    text: string,
    promptContent: string | unknown,
    currentFile: string,
    mentions: readonly AiMention[],
  ): Promise<AiRagSnippet[]> {
    const settings = this.plugin.getSettings();
    if (!settings.rag.enabled) return [];
    const estimated = estimateTokens(text) + estimateTokens(typeof promptContent === "string" ? promptContent : "") + estimateTokens(currentFile);
    if (
      !shouldUseVaultSearch({
        mentions,
        useVaultSearch: this.useVaultSearch,
        estimatedPromptTokens: estimated,
        thresholdTokens: settings.rag.thresholdTokens,
      })
    ) {
      return [];
    }
    const runtime = this.plugin.runtimeFor("embedding");
    if (!runtime.ok) {
      new Notice(`RAG 没有可用模型：${runtime.message}`);
      return [];
    }
    try {
      const workspace = this.currentWorkspace();
      const mentionsScope = ragScopeFromMentions(mentions);
      const scope = workspace?.folders.length ? { folders: workspace.folders } : mentionsScope;
      const hits = await this.plugin.getRag().query(text, { scope });
      return hits.map((hit) => ({
        path: hit.path,
        content: hit.content,
        startLine: hit.metadata.startLine,
        endLine: hit.metadata.endLine,
        similarity: hit.similarity,
      }));
    } catch (error) {
      new Notice(`检索失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** One model turn, then auto-run read-only tools or stop for approval. */
  private async runTurnLoop(
    record: AiConversationRecord<AiChatMessage>,
    config: AiRuntimeConfig,
    working: AiChatMessage[],
    toolDefinitions: AiToolDefinition[],
    runId: string,
    round: number,
  ): Promise<void> {
    const settings = this.plugin.getSettings();
    const maxRounds = settings.tools.enabled ? Math.max(1, settings.tools.maxAutoIterations) : 0;
    this.sending = true;
    this.renderComposer();
    const controller = new AbortController();
    this.controller = controller;
    this.messages.appendStreaming();

    let last: ChatTurnResult | null = null;
    try {
      last = await runChatTurn({
        config,
        messages: working,
        transport: this.plugin.getTransport(),
        signal: controller.signal,
        ...(toolDefinitions.length ? { tools: toolDefinitions } : {}),
        ...(runId ? { hooks: { onStep: (step: ChatRuntimeStep) => this.plugin.traceRun(runId, step) } } : {}),
        callbacks: {
          onText: (_delta, full) => this.messages.setStreamText(full),
          onReasoning: () => this.messages.setStreamMeta("推理中"),
        },
      });
    } finally {
      this.sending = false;
      this.controller = null;
    }

    if (!last) {
      this.messages.finishStream();
      this.renderComposer();
      return;
    }
    if (!last.ok) {
      const card = this.messages.finishStream();
      if (card) {
        card.addClass("sfc-ai-msg-error");
        card.createDiv({ cls: "sfc-ai-msg-error-text", text: last.error ?? "请求失败。" });
        card.createDiv({ cls: "sfc-ai-msg-meta", text: last.aborted ? "已取消" : "失败" });
        if (runId) this.addRunButton(card, runId);
      }
      if (runId) {
        await this.plugin.finishRun(runId, {
          status: last.aborted ? "cancelled" : "failed",
          summary: last.error ?? "请求失败",
          ...(last.aborted ? {} : { error: { message: last.error ?? "请求失败" } }),
        });
      }
      if (!last.aborted) new Notice(last.error ?? "请求失败。");
      this.renderComposer();
      return;
    }

    if (last.usage) this.sessionUsage = addUsage(this.sessionUsage, last.usage);
    const cost = last.usage ? estimateCostUsd(config.model, last.usage) : null;
    const assistantMessage: AiChatMessage = ensureMessageMeta({
      role: "assistant",
      content: last.text,
      ...(last.reasoning ? { reasoning: last.reasoning } : {}),
      ...(last.toolCalls.length ? { toolCalls: last.toolCalls } : {}),
      ...(runId ? { runId } : {}),
      ...(last.usage ? { usage: last.usage } : {}),
    });
    if (!last.toolCalls.length) {
      this.messages.setStreamMeta(usageLine(last, config.model));
      this.messages.finishStream();
      if (last.usage) this.lastTurnUsage = addUsage(emptyTokenTotals(), last.usage);
      record.messages.push(assistantMessage);
      await this.plugin.finishRun(runId, {
        status: "ok",
        summary: "完成",
        ...(last.usage ? { usage: { prompt: last.usage.promptTokens, completion: last.usage.completionTokens, total: last.usage.totalTokens, ...(last.usage.cachedTokens ? { cached: last.usage.cachedTokens } : {}) } } : {}),
        ...(cost ? { costUsd: cost.usd } : {}),
      });
      await this.saveRecord();
      this.renderThread();
      return;
    }

    const hostTools = this.plugin.getVaultTools();
    const states: AiToolCallState[] = last.toolCalls.map((call) => ({ call, status: "pending_approval" as const }));
    for (const state of states) {
      this.plugin.traceRun(runId, { kind: "tool.call", title: `工具 ${state.call.name}`, detail: state.call.arguments, meta: { id: state.call.id } });
    }
    for (const state of states) {
      const tool = hostTools.find((entry) => entry.name === state.call.name);
      const autoAllowed = tool?.readOnly === true && (this.allowedTools.has(state.call.name) || settings.tools.autoAllowed.includes(state.call.name));
      if (tool && autoAllowed) {
        const executed = await executeApprovedTool(state, tool, { signal: controller.signal });
        Object.assign(state, executed);
        this.traceToolResult(runId, state);
      }
    }
    working.push(assistantMessage);
    record.messages.push(assistantMessage);
    const resolvedMessages = toolResultMessages(states);
    working.push(...resolvedMessages);
    record.messages.push(...resolvedMessages);

    const stillPending = states.filter((state) => state.status === "pending_approval");
    this.messages.finishStream();
    if (stillPending.length) {
      this.pending = { record, working, states, tools: hostTools, config, toolDefinitions, runId, round };
      await this.saveRecord();
      this.renderThread();
      for (const state of stillPending) this.renderPendingTool(state);
      this.renderComposer();
      return;
    }
    await this.saveRecord();
    this.renderThread();
    if (round + 1 > maxRounds) {
      await this.plugin.finishRun(runId, { status: "ok", summary: "已到达自动工具轮数上限" });
      new Notice("已到达自动工具轮数上限。");
      return;
    }
    await this.runTurnLoop(record, config, working, toolDefinitions, runId, round + 1);
  }

  private renderPendingTool(state: AiToolCallState): void {
    const index = this.pending?.states.indexOf(state) ?? -1;
    this.messages.addToolState(state, {
      allow: () => void this.resolvePending(index, "allow"),
      allowRun: () => void this.resolvePending(index, "allow-conversation"),
      reject: () => void this.resolvePending(index, "reject"),
    });
  }

  private async resolvePending(index: number, decision: "allow" | "allow-conversation" | "reject"): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const state = pending.states[index];
    if (!state || state.status !== "pending_approval") return;
    const tool = pending.tools.find((entry) => entry.name === state.call.name);
    if (decision === "reject") {
      state.status = "rejected";
      state.error = "用户拒绝了这次工具调用。";
      this.plugin.traceRun(pending.runId, { kind: "tool.approval", level: "warn", title: `用户拒绝 ${state.call.name}` });
    } else if (!tool) {
      state.status = "error";
      state.error = `未知工具：${state.call.name}`;
      this.plugin.traceRun(pending.runId, { kind: "tool.approval", level: "error", status: "failed", title: `未知工具 ${state.call.name}` });
    } else {
      if (decision === "allow-conversation") this.allowedTools.add(state.call.name);
      this.plugin.traceRun(pending.runId, { kind: "tool.approval", title: `用户批准 ${state.call.name}`, meta: { scope: decision } });
      const executed = await executeApprovedTool(state, tool);
      Object.assign(state, executed);
      this.traceToolResult(pending.runId, state);
    }
    if (pending.states.some((entry) => entry.status === "pending_approval")) {
      this.renderThread();
      for (const entry of pending.states.filter((item) => item.status === "pending_approval")) this.renderPendingTool(entry);
      return;
    }
    const rejected = pending.states
      .filter((entry) => entry.status === "rejected")
      .map((entry) => ({
        role: "tool" as const,
        content: "用户拒绝了这次工具调用。",
        toolCallId: entry.call.id,
        name: entry.call.name,
      }));
    const messages = [...toolResultMessages(pending.states), ...rejected];
    pending.working.push(...messages);
    pending.record.messages.push(...messages);
    this.pending = null;
    await this.saveRecord();
    this.renderThread();
    const maxRounds = this.plugin.getSettings().tools.enabled ? Math.max(1, this.plugin.getSettings().tools.maxAutoIterations) : 0;
    if (pending.round + 1 > maxRounds) {
      await this.plugin.finishRun(pending.runId, { status: "ok", summary: "已到达自动工具轮数上限" });
      new Notice("已到达自动工具轮数上限。");
      return;
    }
    await this.runTurnLoop(pending.record, pending.config, pending.working, pending.toolDefinitions, pending.runId, pending.round + 1);
  }

  private traceToolResult(runId: string, state: AiToolCallState): void {
    this.plugin.traceRun(runId, {
      kind: "tool.result",
      level: state.status === "success" ? "info" : "warn",
      title: `${state.call.name} ${state.status}`,
      detail: state.error ?? state.result ?? "",
      meta: { ms: (state.endedAt ?? 0) - (state.startedAt ?? 0) },
    });
  }

  // -------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------

  private async startAgent(goal: string): Promise<void> {
    const workspace = this.currentWorkspace() ?? (await this.plugin.ensureDefaultWorkspace());
    if (!workspace) {
      new Notice("无法创建工作区，Agent 已取消。");
      return;
    }
    let record = this.record;
    if (!record) {
      record = await this.plugin.getStore().create({
        title: goal.slice(0, MAX_TITLE) || "Agent 任务",
        workspaceId: workspace.id,
      });
      this.record = record;
      this.blankIntent = false;
      await this.refreshSidebar();
    }
    this.workspaceId = workspace.id;
    record.workspaceId = workspace.id;
    this.agentConversationId = record.id;
    if (record.messages.length === 0) record.title = goal.slice(0, MAX_TITLE);
    record.messages.push(ensureMessageMeta({ role: "user", content: goal }));
    this.composer.clear();
    this.mentions = [];
    this.sessionRounds += 1;
    await this.saveRecord();
    this.renderThread();
    this.sending = true;
    this.renderComposer();
    const permission = resolveWorkspacePermission(workspace, this.plugin.getSettings()).tier;
    const runtime = this.plugin.getAgentRuntime();
    runtime.start({
      goal,
      workspaceId: workspace.id,
      permission,
      ...(this.plugin.getSettings().agent.maxCostUsd ? { budget: { maxCostUsd: this.plugin.getSettings().agent.maxCostUsd } } : {}),
    }).catch((error: unknown) => {
      new Notice(`Agent 启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Called by the plugin's runtime event bridge for this view. */
  handleAgentEvent(event: AgentEvent): void {
    if (event.type === "delta") {
      if (!this.agentStreamStartedAt) {
        this.agentStreamStartedAt = Date.now();
        this.messages.appendStreaming();
      }
      this.messages.setStreamText(event.text ?? "");
      return;
    }
    if (event.type === "state" && event.state) {
      this.renderPlanPanel();
      this.renderComposer();
      if (event.state.status === "paused_approval") this.renderPlanPanel();
      return;
    }
    if (event.type === "approval" && event.request) {
      new Notice(`Agent 等待确认：${event.request.summary}`, 8000);
      this.renderPlanPanel();
      return;
    }
    if (event.type === "done") {
      this.finishAgent(event.state, event.summary);
    }
  }

  private finishAgent(state: AiAgentRunState, summary: string): void {
    this.agentStreamStartedAt = 0;
    this.sending = false;
    const card = this.messages.finishStream();
    if (card) card.createDiv({ cls: "sfc-ai-msg-meta", text: "Agent 完成，见上方计划与轨迹。" });
    if (this.record && this.record.id === this.agentConversationId) {
      this.record.messages.push(
        ensureMessageMeta({
          role: "assistant",
          content: summary,
          ...(this.lastRunId ? { runId: this.lastRunId } : {}),
        }),
      );
      this.sessionUsage = addUsage(this.sessionUsage, {
        promptTokens: state.usage.prompt,
        completionTokens: state.usage.completion,
        totalTokens: state.usage.total,
        ...(state.usage.cached ? { cachedTokens: state.usage.cached } : {}),
      });
      void this.saveRecord();
    }
    this.renderThread();
  }

  private async undoAgentBatch(state: AiAgentRunState): Promise<void> {
    const plan = await this.plugin.getBackups().planBatch(state.id);
    const stale = plan.stale.length ? `\n其中 ${plan.stale.length} 个文件在 AI 之后被改过，撤销会覆盖这些改动。` : "";
    if (!(await confirmAction(this.app, { title: "撤销本次 Agent 的全部写入？", message: stale.replace(/^\n/, ""), cta: "撤销", warning: true }))) return;
    const result = await this.plugin.getBackups().undoBatch(state.id);
    new Notice(result.ok ? `已撤销：恢复 ${result.restored.length} 个、删除 ${result.removed.length} 个文件。${result.message ?? ""}` : result.message ?? "撤销失败。");
    this.renderThread();
  }

  // -------------------------------------------------------------------------
  // Trace tab
  // -------------------------------------------------------------------------

  private async renderTrace(): Promise<void> {
    this.traceEl.empty();
    const runId = this.lastRunId || (this.record?.meta?.lastRunId as string | undefined) || "";
    const header = this.traceEl.createDiv({ cls: "sfc-ai-trace-head" });
    header.createSpan({ cls: "sfc-ai-trace-title", text: "本次运行轨迹" });
    const open = header.createEl("button", { cls: "sfc-ai-ghost", text: "在运行记录中打开" });
    open.onclick = () => void this.plugin.openRunLog(runId);
    if (!runId) {
      this.traceEl.createDiv({ cls: "sfc-ai-empty", text: "这个会话还没有运行记录。" });
      return;
    }
    const record = await this.plugin.getRunHub().read(runId);
    if (!record) {
      this.traceEl.createDiv({ cls: "sfc-ai-empty", text: "轨迹文件已按保留策略清理，或尚未写入。" });
      return;
    }
    this.traceEl.createDiv({ cls: "sfc-ai-trace-meta", text: `${record.title}  ${runStatusLabel(record.status)}` });
    renderRunTimeline(this.traceEl, record);
  }

  // -------------------------------------------------------------------------
  // Apply / export / helpers
  // -------------------------------------------------------------------------

  private async applyToCurrentFile(): Promise<void> {
    const record = this.record;
    const file = this.app.workspace.getActiveFile();
    if (!record || !file) {
      new Notice("先打开要修改的笔记。");
      return;
    }
    const workspace = this.currentWorkspace();
    if (workspace && !workspaceAllowsPath(workspace, file.path)) {
      new Notice("这篇笔记不在当前工作区范围内。");
      return;
    }
    const lastUser = [...activeBranch(record.messages)].reverse().find((message) => message.role === "user");
    const instruction = await promptText(this.app, {
      title: "要如何修改这篇笔记？",
      value: textOf(lastUser?.content) ?? "",
      multiline: false,
      requireValue: false,
    });
    if (!instruction?.trim()) return;
    const original = await this.app.vault.cachedRead(file);
    const result = await this.plugin.runApply({ file: file.path, originalContent: original, instruction, history: record.messages });
    if (!result.ok) {
      new Notice(result.error);
      return;
    }
    new ApplyDiffModal(this.app, result.session, {
      onAccept: async (content) => {
        await this.plugin.writeWithBackup(file.path, content, result.runId);
      },
    }).open();
  }

  private async exportConversation(): Promise<void> {
    await this.copy(this.conversationMarkdown(), "会话已复制为 Markdown。");
  }

  private conversationMarkdown(): string {
    const record = this.record;
    if (!record) return "";
    const workspace = this.currentWorkspace();
    const lines = [`# ${record.title}`, "", `- 工作区：${workspace?.name ?? "未分组"}`, `- 更新：${new Date(record.updatedAt).toLocaleString()}`, ""];
    for (const message of record.messages) {
      if (message.role === "system") continue;
      const role = message.role === "user" ? "你" : message.role === "assistant" ? "助手" : "工具";
      const status = message.status === "retracted" ? "（已撤回）" : message.status === "superseded" ? "（已被取代）" : "";
      lines.push(`## ${role}${status}`, "", textOf(message.content), "");
    }
    return lines.join("\n");
  }

  private addRunButton(card: HTMLElement, runId: string): void {
    const button = card.createEl("button", { cls: "sfc-ai-ghost", text: "查看轨迹" });
    button.onclick = () => this.openTraceFor(runId);
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

  private stopCurrent(): void {
    const agent = this.plugin.getAgentRuntime().getState();
    if (agent && agent.status !== "done" && agent.status !== "failed" && agent.status !== "cancelled" && agent.status !== "budget_exceeded") {
      this.plugin.getAgentRuntime().stop();
    }
    this.controller?.abort();
    new Notice("已请求停止。");
  }

  private async showCheckpointNotice(): Promise<void> {
    const checkpoints = await this.plugin.getAgentRuntime().loadCheckpoints();
    this.checkpointIds = checkpoints.map((checkpoint) => checkpoint.state.id);
    if (checkpoints.length) {
      new Notice(`发现 ${checkpoints.length} 个未完成的 Agent 检查点，可在计划面板继续。`, 8000);
      this.renderPlanPanel();
    }
  }
}

/** The thread hides superseded turns but keeps retracted ones, greyed. */
function activeBranchView(messages: readonly AiChatMessage[]): AiChatMessage[] {
  return messages.filter((message) => message.status !== "superseded");
}

function usageLine(result: ChatTurnResult, model: string): string {
  if (!result.usage) return "完成";
  const cost = estimateCostUsd(model, result.usage);
  const cache = result.usage.cachedTokens ? `  缓存 ${result.usage.cachedTokens}` : "";
  return `${result.usage.totalTokens} tokens${cache}${cost ? `  $${cost.usd.toFixed(4)}（估算）` : ""}`;
}

function agentStatusText(state: AiAgentRunState): string {
  if (state.status === "done") return "已完成";
  if (state.status === "failed") return "失败";
  if (state.status === "cancelled") return "已终止";
  if (state.status === "budget_exceeded") return "超出预算";
  if (state.status === "paused_approval") return "等待审批";
  if (state.status === "paused_user") return "已暂停";
  if (state.status === "planning") return "制定计划";
  return "执行中";
}

