/**
 * AI Host: the host plugin.
 *
 * One plugin owns the network path, the provider settings and the credentials.
 * Domain plugins keep their own UI and data formats and call this host's API for
 * model turns; they never open a socket. This file wires that API to Obsidian:
 * the keychain, the vault adapter, the view, the commands and the RAG service.
 *
 * Scope today: settings migration, streaming chat with mentions/RAG/templates,
 * read-only tool approvals, apply-with-undo, diagnostics. No MCP, no automatic
 * indexing, no write tool without confirmation.
 */

import { Notice, Platform, Plugin, TFile, addIcon, type WorkspaceLeaf } from "obsidian";
import { registerFallbackIcons } from "../sdk/src/icons";
import { promptText } from "../sdk/src/uiDialogs";
import { AI_HOST_API_VERSION, API_VERSION, PLUGIN_IDS, publishApi, unpublishApi, type VersionedApi } from "../sdk/src/api";
import {
  collectLegacyAiSecrets,
  deepMerge,
  migrateAiSettingsDetailed,
  normalizeAiSettings,
  resolveProviders,
  secretIdForProvider,
  type AiChatSettings,
  type AiProviderEntry,
  type AiSettings,
} from "../sdk/src/ai/aiSettingsSchema";
import {
  createConversationStore,
  type AiConversationInitInfo,
  type AiConversationStore,
} from "../sdk/src/ai/aiConversationStore";
import type { AiChatMessage, AiToolDefinition } from "../sdk/src/ai/aiChat";
import { isPathIncluded } from "../sdk/src/ai/aiGlob";
import { createAiTransport, type AiTransport } from "../sdk/src/ai/aiTransport";
import { openAiHeaders, openAiModelsUrl } from "../sdk/src/ai/aiAdapters/openai";
import { buildApplyMessages, createApplySession, type AiApplySession } from "../sdk/src/ai/aiApply";
import type { AiEmbedBatch } from "../sdk/src/ai/aiRag";
import type { AiHostTool } from "../sdk/src/ai/aiTools";
import { AI_CHAT_VIEW_TYPE, AiChatView } from "./chatView";
import { httpFailureMessage, runChatTurn, type ChatRuntimeStep } from "./chatRuntime";
import { createVaultConversationFs } from "./conversationFs";
import { buildDiagnosticsReport } from "./diagnostics";
import { createRunStore, type AiRunCreateInput, type AiRunRecordV2, type AiRunStepInput, type AiRunStore, type AiRunSummary } from "../sdk/src/ai/aiRunLog";
import { RunHub, type AiRunFinishPayload } from "./runHub";
import { RUN_LOG_VIEW_TYPE, RunLogView, runBadgeText } from "./runLogView";
import { createEmbeddingClient } from "./embeddingClient";
import { describeRuntime, hostOf, runtimeConfigFor, selectProviderRow, type AiRuntimeResult, type AiRuntimeRole } from "./providerConfig";
import { AiSecretStore, type LegacySecretSource, type SecretHost } from "./secretStore";
import { AiSettingsTab } from "./settingsTab";
import { SkillRegistry, SkillSuggestModal } from "./skillsHost";
import type { AiSkillDefinition } from "../sdk/src/ai/aiSkill";
import { TemplateStore } from "./templateSuggest";
import { createVaultTools } from "./tools";
import { RagService } from "./vaultRag";
import { createAgentToolContext, createAgentTools, createSkillTools, type AgentTool } from "./agentTools";
import { AgentRuntime, type AgentCheckpoint, type AgentEvent, type AgentTurnResult } from "./agentRuntime";
import { BackupStore, type BackupTarget } from "./backups";
import { PermissionGate } from "./permissions";
import { buildWorkspace, patchWorkspace, type WorkspaceDraft } from "./workspaces";
import type { AiPermissionTier, AiWorkspace } from "../sdk/src/ai/aiWorkspace";
import type { AiAgentRunState } from "../sdk/src/ai/aiAgent";
import { estimateCostUsd } from "../sdk/src/ai/aiPricing";

/** What this plugin publishes to siblings; skills arrive in a later version. */
export interface SfcAiApi extends VersionedApi {
  openChat(): void;
  /** Whether the current settings resolve to a usable provider (never includes the key). */
  hasProvider(): boolean;
  /**
   * Run one non-streamed completion for a domain plugin.
   *
   * This is the bridge that lets a legacy AI pane keep its own prompt and parser
   * while the socket, the key and the retries stay in the host.
   */
  chat(request: {
    messages: AiChatMessage[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    /** When set, the host appends its request/stream/usage steps to this run. */
    runId?: string;
  }): Promise<{ ok: true; text: string; reasoning?: string } | { ok: false; error: string }>;
  /** Domain skills register metadata and an entry point; the host runs nothing by itself. */
  registerSkill(skill: AiSkillDefinition): { ok: boolean; reason?: string; message?: string };
  unregisterSkill(id: string): void;
  listSkills(): AiSkillDefinition[];

  /** The trace/log API, versioned separately from the data contract. */
  traceVersion?: number;
  beginRun(input: AiRunCreateInput): string;
  trace(runId: string, step: AiRunStepInput): void;
  finishRun(runId: string, payload: AiRunFinishPayload): void;
  listRuns(filter?: { pluginId?: string; status?: string; kind?: string; query?: string; limit?: number }): Promise<AiRunSummary[]>;
  getRun(runId: string): Promise<AiRunRecordV2 | null>;
  openRunView(runId?: string): void;

  /** API v2: workspaces, permissions and the agent. All optional for old hosts. */
  listWorkspaces?(): AiWorkspace[];
  currentWorkspace?(): AiWorkspace | null;
  setPermission?(workspaceId: string, tier: AiPermissionTier): Promise<void>;
  agentStart?(input: { goal: string; workspaceId: string }): Promise<{ ok: boolean; message: string }>;
  agentPause?(): void;
  agentResume?(): void;
  agentStop?(): void;
  getAgentState?(): AiAgentRunState | null;
}

export default class SfcAiPlugin extends Plugin {
  private aiSettings!: AiSettings;
  private secretStore!: AiSecretStore;
  private conversations!: AiConversationStore<AiChatMessage>;
  private transport!: AiTransport;
  private rag!: RagService;
  private vaultTools!: AiHostTool[];
  private templates!: TemplateStore;
  private readonly skills = new SkillRegistry();
  private runStore!: AiRunStore;
  private runHub!: RunHub;
  private statusBarEl: HTMLElement | null = null;
  /** Last few run summaries, kept for the (synchronous) diagnostics report. */
  private runLines: string[] = [];
  /** The run a RAG index command is writing steps into, if any. */
  private indexRunId: string | null = null;
  private warnings: string[] = [];
  private indexRebuilt = false;
  /** Write backups and their batch undo. One writer for Apply and Agent. */
  private backups!: BackupStore;
  private permissionGate!: PermissionGate;
  private agentRuntime!: AgentRuntime;
  private agentCheckpointIds: string[] = [];

  async onload(): Promise<void> {
    // The same fallback icons the other two plugins register, so a name Obsidian
    // renames (`pin`, `settings`) still draws here instead of leaving a blank
    // button behind. Idempotent: `addIcon` overwrites.
    registerFallbackIcons((name, svg) => addIcon(name, svg));
    const raw = await this.readRawSettings();
    const outcome = migrateAiSettingsDetailed(raw);
    this.aiSettings = outcome.settings;
    this.warnings = [...outcome.report.warnings];

    const legacyEntries = collectLegacyAiSecrets(raw);
    this.secretStore = new AiSecretStore(detectSecretHost(this.app), legacySource(raw));
    const migration = this.secretStore.migrate(legacyEntries);
    if (migration.migrated) this.warnings.push(`已迁移 ${migration.migrated} 个旧版明文密钥到钥匙串。`);
    if (migration.unavailable && legacyEntries.length) {
      this.warnings.push("这个 Obsidian 版本没有可用的钥匙串，旧版明文密钥没有迁移。");
    }
    // A grant is session-scoped: Obsidian exiting revokes it. This is the
    // plan's "退出即失效" rule, and it is why the stored expiry alone is
    // not enough -- a laptop closed for a week would keep the grant.
    const grantedOnDisk = this.aiSettings.workspaces.filter(
      (workspace) => workspace.permission === "full" || workspace.permission === "trusted",
    );
    if (grantedOnDisk.length) {
      this.aiSettings = normalizeAiSettings({
        ...this.aiSettings,
        workspaces: this.aiSettings.workspaces.map((workspace) =>
          workspace.permission === "full" || workspace.permission === "trusted"
            ? { ...workspace, permission: "standard", permissionExpiresAt: undefined }
            : workspace,
        ),
      });
      this.warnings.push(`已把 ${grantedOnDisk.length} 个工作区的授权降回标准（重启后授权失效）。`);
    }
    await this.persist();

    // One socket, two carriers: desktop uses Node's clients; Obsidian mobile has
    // no Node builtins, so it uses the WebView's XMLHttpRequest. The choice is
    // made once, here. Since the desktop loader now falls back to the XHR
    // carrier if a renderer refuses `node:http`, `mobile` is a preference rather
    // than a hard branch.
    this.transport = createAiTransport({ mobile: Platform.isMobile });
    this.conversations = createConversationStore<AiChatMessage>(
      createVaultConversationFs(this.app.vault.adapter, this.manifest.dir ?? ""),
      { dir: "conversations" },
    );
    const info = await this.conversations.init();
    this.indexRebuilt = info.rebuilt;
    if (info.rebuilt) this.warnings.push("会话索引已重建。");

    const logging = this.aiSettings.logging;
    this.runStore = createRunStore(createVaultConversationFs(this.app.vault.adapter, this.manifest.dir ?? ""), {
      dir: "runs",
      retention: {
        maxRuns: logging.keepRuns,
        maxAgeDays: logging.keepDays,
        maxBytes: logging.maxBytesMB * 1024 * 1024,
      },
    });
    this.runHub = new RunHub({
      store: this.runStore,
      onUpdate: (summary) => this.updateRunBadge(summary),
    });
    const runInfo = await this.runHub.init();
    if (runInfo.rebuilt) this.warnings.push("运行记录索引已重建。");

    this.vaultTools = createVaultTools(this.app);
    this.templates = new TemplateStore(this.app, () => this.aiSettings.chat.templatesFolder);
    this.rag = new RagService(
      {
        app: this.app,
        settings: () => this.aiSettings,
        embed: () => this.embedBatchFor("embedding"),
        modelKey: () => this.embeddingModelKey(),
        onProgress: (progress) => {
          if (this.indexRunId) {
            this.traceRun(this.indexRunId, {
              kind: `index.${progress.phase}`,
              title: `${progress.phase}：${progress.filesDone}/${progress.filesTotal} 文件  ${progress.chunksDone}/${progress.chunksTotal} 块`,
              status: progress.phase === "done" ? "ok" : "running",
              ...(progress.message ? { detail: progress.message } : {}),
            });
          }
          if (progress.phase === "done") console.warn(`[sfc-ai] 索引完成：${progress.chunksDone} 块`);
        },
      },
      this.manifest.dir ?? "",
    );
    const vaultTarget: BackupTarget = {
      read: async (targetPath) => {
        const file = this.app.vault.getAbstractFileByPath(targetPath);
        return file instanceof TFile ? await this.app.vault.cachedRead(file) : null;
      },
      write: async (targetPath, content) => {
        const file = this.app.vault.getAbstractFileByPath(targetPath);
        if (file instanceof TFile) await this.app.vault.modify(file, content);
        else await this.app.vault.create(targetPath, content);
      },
      remove: async (targetPath) => {
        const file = this.app.vault.getAbstractFileByPath(targetPath);
        if (file instanceof TFile) await this.app.fileManager.trashFile(file);
      },
    };
    this.backups = new BackupStore(
      createVaultConversationFs(this.app.vault.adapter, this.manifest.dir ?? ""),
      vaultTarget,
      this.manifest.dir ?? "",
    );
    this.permissionGate = new PermissionGate(() => this.aiSettings);
    this.agentRuntime = new AgentRuntime({
      tools: () => this.agentToolList(),
      getWorkspace: (id) => this.getWorkspace(id),
      createContext: (input) =>
        createAgentToolContext({
          app: this.app,
          workspace: input.workspace,
          runId: input.runId,
          batchId: input.batchId,
          backups: this.backups,
          ...(input.signal ? { signal: input.signal } : {}),
          ragSearch: (query) => this.agentRagSearch(input.workspace, query),
          askModel: (prompt) => this.agentAskModel(prompt),
          trace: (kind, title, detail) =>
            this.traceRun(input.runId, { kind, title, ...(detail ? { detail } : {}) }),
        }),
      requestTurn: (input) => this.agentTurn(input),
      gate: this.permissionGate,
      beginRun: (input) =>
        this.beginRun({ pluginId: PLUGIN_IDS.ai, kind: "agent", title: input.title, workspaceId: input.workspaceId }),
      finishRun: (runId, payload) => this.finishRun(runId, payload),
      trace: (runId, step) => this.traceRun(runId, step),
      persistCheckpoint: (checkpoint) => this.persistAgentCheckpoint(checkpoint),
      loadCheckpoints: () => this.loadAgentCheckpoints(),
      removeCheckpoint: (runId) => this.removeAgentCheckpoint(runId),
      estimateCost: (model, usage) => {
        const cost = estimateCostUsd(model, usage);
        return cost ? cost.usd : null;
      },
      model: () => {
        const runtime = this.runtimeFor("chat");
        return runtime.ok ? runtime.config.model : this.aiSettings.chat.model;
      },
      onEvent: (event) => this.broadcastAgentEvent(event),
    });
    this.permissionGate.setApprover((request, signal) => this.agentRuntime.requestApproval(request, signal));

    for (const warning of this.warnings) console.warn(`[sfc-ai] ${warning}`);
    this.registerView(AI_CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new AiChatView(leaf, this));
    this.registerView(RUN_LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RunLogView(leaf, this));
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("sfc-run-statusbar");
    this.statusBarEl.setText("");
    this.statusBarEl.onclick = () => void this.openRunLog();
    this.addRibbonIcon("bot", "AI Host 聊天", () => void this.openChat());
    this.addCommand({ id: "open-ai-chat", name: "打开 AI 聊天", callback: () => void this.openChat() });
    this.addCommand({ id: "update-ai-index", name: "更新 AI 检索索引", callback: () => void this.runIndexCommand("update") });
    this.addCommand({ id: "rebuild-ai-index", name: "重建 AI 检索索引", callback: () => void this.runIndexCommand("rebuild") });
    this.addCommand({ id: "clear-ai-index", name: "删除 AI 检索索引", callback: () => void this.runIndexCommand("clear") });
    this.addCommand({
      id: "export-ai-diagnostics",
      name: "导出 AI 诊断到剪贴板",
      callback: () => void this.copyDiagnostics(),
    });
    this.addCommand({ id: "undo-ai-write", name: "撤销上次 AI 写入", callback: () => void this.undoLastWrite() });
    this.addCommand({ id: "run-domain-skill", name: "运行领域技能", callback: () => this.openSkillPicker() });
    this.addCommand({ id: "open-run-log", name: "打开 AI 运行记录", callback: () => void this.openRunLog() });
    this.addCommand({ id: "open-last-run", name: "打开最近一次 AI 运行", callback: () => void this.openLastRun() });
    this.addCommand({ id: "clear-run-log", name: "清空 AI 运行记录", callback: () => void this.clearRunLog() });
    this.addCommand({
      id: "cleanup-empty-ai-conversations",
      name: "清理空的 AI 会话",
      callback: () =>
        void this.cleanupEmptyConversations().then((removed) =>
          new Notice(removed ? `已清理 ${removed} 个空会话。` : "没有需要清理的空会话。"),
        ),
    });
    this.addSettingTab(new AiSettingsTab(this.app, this));

    // Background incremental index: a vault edit schedules a debounced update,
    // never a query-time rebuild.
    const schedule = (): void => {
      if (this.aiSettings.rag.enabled) this.rag.schedule();
    };
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));

    const api: SfcAiApi = {
      version: API_VERSION,
      openChat: () => void this.openChat(),
      hasProvider: () => this.runtimeFor("chat").ok,
      chat: (request) => this.chatForSibling(request),
      registerSkill: (skill) => this.skills.register(skill),
      unregisterSkill: (id) => this.skills.unregister(id),
      listSkills: () => this.skills.list(),
      traceVersion: AI_HOST_API_VERSION,
      beginRun: (input) => this.beginRun(input),
      trace: (runId, step) => this.traceRun(runId, step),
      finishRun: (runId, payload) => void this.finishRun(runId, payload),
      listRuns: (filter) => this.runHub.list(filter ?? {}),
      getRun: (runId) => this.runHub.read(runId),
      openRunView: (runId) => void this.openRunLog(runId),
      listWorkspaces: () => this.listWorkspaces(),
      currentWorkspace: () => this.getWorkspace(this.aiSettings.defaultWorkspaceId) ?? this.listWorkspaces()[0] ?? null,
      setPermission: async (workspaceId, tier) => {
        const minutes = this.aiSettings.permission.fullExpiryMinutes;
        await this.patchWorkspace(workspaceId, {
          permission: tier,
          ...(tier === "full" || tier === "trusted" ? { permissionExpiresAt: Date.now() + minutes * 60_000 } : { permissionExpiresAt: undefined }),
        });
      },
      agentStart: async (input) => {
        try {
          const workspace = this.getWorkspace(input.workspaceId) ?? (await this.ensureDefaultWorkspace());
          void this.agentRuntime.start({
            goal: input.goal,
            workspaceId: workspace.id,
            permission: this.permissionGate.resolveTier(workspace),
          });
          return { ok: true, message: "已启动" };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
      agentPause: () => this.agentRuntime.pause(),
      agentResume: () => this.agentRuntime.resumeRun(),
      agentStop: () => this.agentRuntime.stop(),
      getAgentState: () => this.agentRuntime.getState(),
    };
    publishApi(this.app, PLUGIN_IDS.ai, api);
    this.register(() => {
      this.rag.cancelScheduled();
      unpublishApi(this.app, PLUGIN_IDS.ai);
    });
  }

  // -------------------------------------------------------------------------
  // Accessors used by the view, the settings tab and sibling plugins
  // -------------------------------------------------------------------------

  getSettings(): AiSettings {
    return this.aiSettings;
  }

  getSecrets(): AiSecretStore {
    return this.secretStore;
  }

  getTransport(): AiTransport {
    return this.transport;
  }

  getStore(): AiConversationStore<AiChatMessage> {
    return this.conversations;
  }

  getRunHub(): RunHub {
    return this.runHub;
  }

  getRag(): RagService {
    return this.rag;
  }

  getVaultTools(): AiHostTool[] {
    return this.vaultTools;
  }

  getTemplates(): TemplateStore {
    return this.templates;
  }

  getProviderRows(): AiProviderEntry[] {
    return resolveProviders(this.aiSettings);
  }

  currentProviderId(): string {
    return selectProviderRow(this.aiSettings, "chat").id;
  }

  /** Resolve a settings slot into a request config, key included for this call only. */
  runtimeFor(role: AiRuntimeRole): AiRuntimeResult {
    return runtimeConfigFor(this.aiSettings, role, (ref) => this.secretStore.read(ref).value);
  }

  // -------------------------------------------------------------------------
  // Settings mutation (all writes go through normalize)
  // -------------------------------------------------------------------------

  async setChatProvider(providerId: string): Promise<void> {
    await this.patchChat({ providerId });
  }

  async patchChat(patch: Partial<AiChatSettings>): Promise<void> {
    this.aiSettings = normalizeAiSettings(deepMerge(this.aiSettings, { chat: patch }));
    await this.persist();
  }

  async patchApply(patch: Partial<{ providerId: string; model: string }>): Promise<void> {
    this.aiSettings = normalizeAiSettings(deepMerge(this.aiSettings, { apply: patch }));
    await this.persist();
  }

  async patchRag(patch: Partial<AiSettings["rag"]>): Promise<void> {
    this.aiSettings = normalizeAiSettings(deepMerge(this.aiSettings, { rag: patch }));
    await this.persist();
  }

  async patchTools(patch: Partial<AiSettings["tools"]>): Promise<void> {
    this.aiSettings = normalizeAiSettings(deepMerge(this.aiSettings, { tools: patch }));
    await this.persist();
  }

  async patchLogging(patch: Partial<AiSettings["logging"]>): Promise<void> {
    this.aiSettings = normalizeAiSettings(deepMerge(this.aiSettings, { logging: patch }));
    this.runHub.setRetention({
      maxRuns: this.aiSettings.logging.keepRuns,
      maxAgeDays: this.aiSettings.logging.keepDays,
      maxBytes: this.aiSettings.logging.maxBytesMB * 1024 * 1024,
    });
    await this.persist();
  }

  async patchProvider(providerId: string, patch: Record<string, unknown>): Promise<void> {
    const rows = [...this.aiSettings.providers];
    const index = rows.findIndex((row) => row.id === providerId);
    if (index >= 0) rows[index] = deepMerge(rows[index], patch);
    else rows.push(deepMerge({ id: providerId } as AiProviderEntry, patch));
    this.aiSettings = normalizeAiSettings({ ...this.aiSettings, providers: rows });
    await this.persist();
  }

  // -------------------------------------------------------------------------
  // Model turns
  // -------------------------------------------------------------------------

  private async chatForSibling(request: {
    messages: AiChatMessage[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    runId?: string;
  }): Promise<{ ok: true; text: string; reasoning?: string } | { ok: false; error: string }> {
    const runtime = this.runtimeFor("chat");
    if (!runtime.ok) return { ok: false, error: runtime.message };
    const turn = await runChatTurn({
      config: { ...runtime.config, stream: false, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) },
      messages: request.messages,
      transport: this.transport,
      signal: request.signal,
      maxTokens: request.maxTokens,
      ...(request.runId ? { hooks: { onStep: (step: ChatRuntimeStep) => this.traceRun(request.runId as string, step) } } : {}),
    });
    if (!turn.ok) return { ok: false, error: turn.error ?? "请求失败。" };
    return { ok: true, text: turn.text, ...(turn.reasoning ? { reasoning: turn.reasoning } : {}) };
  }

  async runApply(input: {
    file: string;
    originalContent: string;
    instruction: string;
    history: readonly AiChatMessage[];
  }): Promise<{ ok: true; session: AiApplySession; runId: string } | { ok: false; error: string }> {
    const runtime = this.runtimeFor("apply");
    if (!runtime.ok) return { ok: false, error: runtime.message };
    const runId = this.beginRun({ pluginId: PLUGIN_IDS.ai, kind: "apply", title: `AI 应用到 ${input.file}`, skillId: "host.apply" });
    this.traceRun(runId, { kind: "prompt.build", title: "构造整文件重写请求", meta: { file: input.file, history: input.history.length } });
    const messages = buildApplyMessages({
      file: input.file,
      originalContent: input.originalContent,
      instruction: input.instruction,
      history: input.history,
      maxContextMessages: 10,
    });
    const turn = await runChatTurn({
      config: runtime.config,
      messages,
      transport: this.transport,
      maxTokens: 8192,
      ...(runId ? { hooks: { onStep: (step: ChatRuntimeStep) => this.traceRun(runId, step) } } : {}),
    });
    if (!turn.ok) {
      await this.finishRun(runId, { status: "failed", summary: turn.error ?? "生成失败", error: { message: turn.error ?? "生成失败" } });
      return { ok: false, error: turn.error ?? "生成失败。" };
    }
    const session = createApplySession({ file: input.file, originalContent: input.originalContent, incomingContent: turn.text });
    this.traceRun(runId, {
      kind: "apply.diff",
      title: `生成 diff：${session.blocks.filter((block) => block.type === "modified").length} 处修改`,
      meta: { coarse: session.coarse },
    });
    await this.finishRun(runId, { status: "ok", summary: "diff 已生成，等待确认" });
    return { ok: true, session, runId };
  }

  /** Write a note, after storing its previous content under the plugin directory. */
  async writeWithBackup(path: string, content: string, parentRunId?: string): Promise<{ backupId: string }> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`找不到笔记：${path}`);
    const original = await this.app.vault.cachedRead(file);
    const runId = this.beginRun({ pluginId: PLUGIN_IDS.ai, kind: "apply", title: `写入 ${path}`, ...(parentRunId ? { parentRunId } : {}) });
    try {
      const batchId = `apply-${Date.now().toString(36)}`;
      this.traceRun(runId, { kind: "backup", title: "保存原文备份", meta: { bytes: original.length } });
      const audit = await this.backups.record({ batchId, runId, tool: "host.apply", path, before: original, after: content });
      this.traceRun(runId, { kind: "apply.write", title: `写入 ${content.length} 字符`, meta: { path, bytes: content.length } });
      await this.app.vault.modify(file, content);
      await this.finishRun(runId, { status: "ok", summary: `已写入 ${path}` });
      return { backupId: audit.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finishRun(runId, { status: "failed", summary: `写入失败：${path}`, error: { message } });
      throw error;
    }
  }

  /** Restore the newest backed-up write; the batch granularity is a separate action. */
  async undoLastWrite(): Promise<{ ok: boolean; path?: string; message?: string }> {
    const result = await this.backups.undoLastWrite();
    return {
      ok: result.ok,
      ...(result.restored[0] ? { path: result.restored[0] } : result.removed[0] ? { path: result.removed[0] } : {}),
      ...(result.message ? { message: result.message } : {}),
    };
  }
  // -------------------------------------------------------------------------
  // RAG
  // -------------------------------------------------------------------------

  private embeddingModelKey(): string {
    const runtime = this.runtimeFor("embedding");
    if (runtime.ok) return `${runtime.config.providerId}:${runtime.config.model}`;
    const rag = this.aiSettings.rag;
    return `${rag.embeddingProviderId || this.aiSettings.chat.providerId}:${rag.embeddingModel || "(unset)"}`;
  }

  embedBatchFor(role: AiRuntimeRole): AiEmbedBatch {
    const runtime = this.runtimeFor(role);
    if (!runtime.ok) throw new Error(runtime.message);
    return createEmbeddingClient(runtime.config, this.transport, {
      onStep: (step) => {
        if (this.indexRunId) this.traceRun(this.indexRunId, step);
      },
    });
  }

  async runIndexCommand(kind: "update" | "rebuild" | "clear"): Promise<void> {
    if (kind === "clear") {
      const runId = this.beginRun({ pluginId: PLUGIN_IDS.ai, kind: "rag.index", title: "删除 AI 检索索引" });
      try {
        this.rag.cancelScheduled();
        await this.rag.clear();
        this.traceRun(runId, { kind: "index.clear", title: "索引已删除" });
        await this.finishRun(runId, { status: "ok", summary: "索引已删除" });
      } catch (error) {
        await this.finishRun(runId, { status: "failed", summary: "删除索引失败", error: { message: error instanceof Error ? error.message : String(error) } });
      }
      new Notice("AI 检索索引已删除。");
      return;
    }
    const runtime = this.runtimeFor("embedding");
    if (!runtime.ok) {
      new Notice(`索引需要 embedding 模型：${runtime.message}`);
      return;
    }
    const runId = this.beginRun({ pluginId: PLUGIN_IDS.ai, kind: "rag.index", title: kind === "rebuild" ? "重建 AI 检索索引" : "更新 AI 检索索引" });
    const notice = new Notice(kind === "rebuild" ? "正在重建索引" : "正在更新索引", 0);
    this.indexRunId = runId;
    try {
      const report = kind === "rebuild" ? await this.rag.rebuild() : await this.rag.update(false);
      notice.hide();
      for (const failure of report.failures) {
        this.runHub.error(runId, new Error(failure.message), { where: `rag:${failure.path}`, retryable: false });
      }
      if (report.cancelled) {
        await this.finishRun(runId, { status: "cancelled", summary: "索引已取消" });
        new Notice("索引已取消。");
      } else if (report.failures.length) {
        await this.finishRun(runId, { status: "failed", summary: `索引完成：${report.indexedFiles} 篇 / ${report.chunks} 块，${report.failures.length} 个失败` });
        new Notice(`索引完成：${report.indexedFiles} 篇 / ${report.chunks} 块，${report.failures.length} 个失败。`);
      } else {
        await this.finishRun(runId, { status: "ok", summary: `索引完成：${report.indexedFiles} 篇 / ${report.chunks} 块` });
        new Notice(`索引完成：${report.indexedFiles} 篇 / ${report.chunks} 块。`);
      }
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      this.runHub.error(runId, error, { where: "rag.index", retryable: true });
      await this.finishRun(runId, { status: "failed", summary: "索引失败", error: { message } });
      new Notice(`索引失败：${message}`);
    } finally {
      this.indexRunId = null;
    }
  }

  async indexStatsText(): Promise<string> {
    const stats = await this.rag.stats();
    const last = this.rag.last();
    return [
      `块：${stats.chunks}`,
      `文件：${stats.files}`,
      `模型：${stats.models.length ? stats.models.join(", ") : "无"}`,
      `分片：${stats.shards}`,
      `大小：${Math.round(stats.bytes / 1024)} KB`,
      last ? `上次：${last.indexedFiles} 篇 / ${last.chunks} 块` : "上次：未运行",
    ].join("  ");
  }

  // -------------------------------------------------------------------------
  // Diagnostics and connectivity
  // -------------------------------------------------------------------------

  async testConnection(): Promise<string> {
    const runtime = this.runtimeFor("chat");
    if (!runtime.ok) return runtime.message;
    try {
      const response = await this.transport.send(
        {
          url: openAiModelsUrl(runtime.config.baseUrl),
          method: "GET",
          headers: openAiHeaders({
            apiKey: runtime.config.apiKey,
            authHeader: runtime.config.authHeader,
            authPrefix: runtime.config.authPrefix,
            extraHeaders: runtime.config.extraHeaders,
          }),
        },
        { timeoutMs: Math.min(runtime.config.timeoutMs, 20_000) },
      );
      if (response.status >= 200 && response.status < 300) return `连接成功：${describeRuntime(runtime.config)}`;
      return httpFailureMessage(response.status, response.text);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async conversationCount(): Promise<number> {
    return (await this.conversations.list()).length;
  }

  /**
   * Delete the empty untitled conversations an earlier store bug created
   * (one per pane open, because the index could not be rewritten).
   * Deliberately narrow: a titled or non-empty record is never touched.
   */
  async cleanupEmptyConversations(): Promise<number> {
    const list = await this.conversations.list();
    let removed = 0;
    for (const summary of list) {
      if (summary.messageCount > 0 || summary.title !== "未命名会话") continue;
      if (await this.conversations.remove(summary.id)) removed += 1;
    }
    return removed;
  }

  async rebuildConversationIndex(): Promise<AiConversationInitInfo> {
    return await this.conversations.rebuildIndex();
  }

  exportDiagnostics(): string {
    return this.buildDiagnostics();
  }

  buildDiagnostics(): string {
    return buildDiagnosticsReport({
      hostVersion: this.manifest.version,
      appVersion: (this.app as unknown as { version?: string }).version,
      settings: this.aiSettings,
      providers: this.getProviderRows().map((row) => ({
        id: row.id,
        label: row.label,
        protocol: row.protocol,
        host: hostOf(row.baseUrl),
        model: row.model,
        local: row.local,
        secretOrigin: this.secretStore.readForProvider(row.id).origin,
      })),
      conversations: this.indexRebuilt ? 0 : 0,
      indexRebuilt: this.indexRebuilt,
      runLines: this.runLines,
      warnings: this.warnings,
    });
  }

  /** List the registered domain skills; an empty registry says why. */
  openSkillPicker(): void {
    const skills = this.skills.list();
    if (!skills.length) {
      new Notice("没有已注册的领域技能。安装并启用 flashcards / todo 后，它们的技能会出现在这里。", 8000);
      return;
    }
    new SkillSuggestModal(this.app, skills).open();
  }

  // -------------------------------------------------------------------------
  // Runs (trace/log)
  // -------------------------------------------------------------------------

  /** Begin a run unless logging is off; an empty id makes every later call a no-op. */
  beginRun(input: AiRunCreateInput): string {
    if (this.aiSettings.logging.level === "off") return "";
    return this.runHub.begin(input);
  }

  traceRun(runId: string, step: AiRunStepInput): void {
    if (!runId) return;
    if (this.aiSettings.logging.level === "error" && step.level !== "error" && step.level !== "warn") return;
    this.runHub.step(runId, step);
  }

  async finishRun(runId: string, payload: AiRunFinishPayload): Promise<void> {
    if (!runId) return;
    await this.runHub.finish(runId, payload);
  }

  /** Status bar text plus the last few lines the diagnostics report embeds. */
  updateRunBadge(summary: AiRunSummary): void {
    this.runLines = [
      `${new Date(summary.startedAt).toISOString()} ${summary.pluginId} ${summary.kind} ${summary.status}${summary.firstErrorCode ? ` ${summary.firstErrorCode}` : ""}  ${summary.title}`,
      ...this.runLines,
    ].slice(0, 10);
    if (!this.statusBarEl) return;
    if (!this.aiSettings.logging.statusBar || this.aiSettings.logging.level === "off") {
      this.statusBarEl.setText("");
      return;
    }
    const label = summary.status === "running" ? "运行中" : summary.status === "failed" ? "失败" : summary.status === "ok" ? "完成" : "已取消";
    this.statusBarEl.setText(`AI ${label}：${summary.title}`);
    this.statusBarEl.setAttr("aria-label", runBadgeText(summary));
  }

  async openRunLog(runId?: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(RUN_LOG_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: RUN_LOG_VIEW_TYPE, active: true });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
    if (runId && leaf?.view instanceof RunLogView) leaf.view.select(runId);
  }

  async openLastRun(): Promise<void> {
    const latest = (await this.runHub.list({ limit: 1 }))[0];
    await this.openRunLog(latest?.id);
  }

  async clearRunLog(): Promise<void> {
    await this.runHub.clear();
    new Notice("运行记录已清空。");
  }

  async openChat(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: AI_CHAT_VIEW_TYPE, active: true });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  /** Files the indexer would read, for the settings preview. */
  ragFilePreview(limit = 20): string[] {
    const rag = this.aiSettings.rag;
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => isPathIncluded(file.path, { include: rag.includeGlobs, exclude: rag.excludeGlobs }))
      .slice(0, limit)
      .map((file) => file.path);
  }

  // -------------------------------------------------------------------------
  // Workspaces and permissions
  // -------------------------------------------------------------------------

  /** Every stored workspace, normalized on read. */
  listWorkspaces(): AiWorkspace[] {
    return this.aiSettings.workspaces;
  }

  getWorkspace(id: string): AiWorkspace | null {
    if (!id) return null;
    return this.aiSettings.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  getBackups(): BackupStore {
    return this.backups;
  }

  getAgentRuntime(): AgentRuntime {
    return this.agentRuntime;
  }

  /** Create or update one workspace; every write goes back through the normalizer. */
  async patchWorkspace(id: string, patch: Partial<AiWorkspace>): Promise<void> {
    const rows = this.aiSettings.workspaces.map((workspace) => (workspace.id === id ? patchWorkspace(workspace, patch) : workspace));
    this.aiSettings = normalizeAiSettings({ ...this.aiSettings, workspaces: rows });
    await this.persist();
  }

  async createWorkspace(draft: WorkspaceDraft): Promise<AiWorkspace> {
    const workspace = buildWorkspace(draft);
    this.aiSettings = normalizeAiSettings({
      ...this.aiSettings,
      workspaces: [...this.aiSettings.workspaces, workspace],
      defaultWorkspaceId: this.aiSettings.defaultWorkspaceId || workspace.id,
    });
    await this.persist();
    return this.getWorkspace(workspace.id) ?? workspace;
  }

  /** Delete a workspace; conversations are kept as 未分组 or deleted, per the caller. */
  async removeWorkspace(id: string, mode: "ungroup" | "delete"): Promise<void> {
    const list = await this.conversations.list();
    for (const summary of list) {
      if (summary.workspaceId !== id) continue;
      if (mode === "delete") {
        await this.conversations.remove(summary.id);
        continue;
      }
      const record = await this.conversations.read(summary.id);
      if (!record) continue;
      delete record.workspaceId;
      await this.conversations.save(record);
    }
    this.aiSettings = normalizeAiSettings({
      ...this.aiSettings,
      workspaces: this.aiSettings.workspaces.filter((workspace) => workspace.id !== id),
      defaultWorkspaceId: this.aiSettings.defaultWorkspaceId === id ? "" : this.aiSettings.defaultWorkspaceId,
    });
    await this.persist();
  }

  /** The implicit whole-vault workspace: agents need a scope, even before the user makes one. */
  async ensureDefaultWorkspace(): Promise<AiWorkspace> {
    const existing = this.listWorkspaces()[0];
    if (existing) return existing;
    return await this.createWorkspace({ name: "整个库", folders: [], permission: "standard" });
  }

  /** The sidebar's 「新建工作区」: two prompts now, full editing in settings. */
  async openWorkspaceBuilder(): Promise<void> {
    const name = await promptText(this.app, { title: "新工作区名称", value: "新工作区" });
    if (!name?.trim()) return;
    const foldersRaw = await promptText(this.app, {
      title: "限定文件夹（逗号分隔，留空 = 整个库）",
      placeholder: "例如：Notes/Solar, Notes/复盘",
      requireValue: false,
    });
    if (foldersRaw === null) return;
    const folders = foldersRaw.split(/[,，]/).map((entry) => entry.trim()).filter(Boolean);
    await this.createWorkspace({ name: name.trim(), folders, permission: "standard" });
    new Notice(`工作区「${name.trim()}」已创建，可在设置里调整权限、模型与文件夹。`);
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  async patchPermission(patch: Partial<AiSettings["permission"]>): Promise<void> {
    this.aiSettings = normalizeAiSettings(deepMerge(this.aiSettings, { permission: patch }));
    await this.persist();
  }

  async patchAgent(patch: Partial<AiSettings["agent"]>): Promise<void> {
    this.aiSettings = normalizeAiSettings(deepMerge(this.aiSettings, { agent: patch }));
    await this.persist();
  }

  async setDefaultWorkspace(id: string): Promise<void> {
    this.aiSettings = normalizeAiSettings({ ...this.aiSettings, defaultWorkspaceId: id });
    await this.persist();
  }

  // -------------------------------------------------------------------------
  // Agent plumbing
  // -------------------------------------------------------------------------

  private agentToolList(): AgentTool[] {
    return [...createAgentTools(), ...createSkillTools(this.skills.list())];
  }

  private async agentTurn(input: {
    messages: AiChatMessage[];
    tools: AiToolDefinition[];
    signal?: AbortSignal;
    onText?: (delta: string, full: string) => void;
  }): Promise<AgentTurnResult> {
    const runtime = this.runtimeFor("chat");
    if (!runtime.ok) return { ok: false, text: "", toolCalls: [], error: runtime.message };
    const turn = await runChatTurn({
      config: runtime.config,
      messages: input.messages,
      transport: this.transport,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.tools.length ? { tools: input.tools } : {}),
      ...(input.onText ? { callbacks: { onText: input.onText } } : {}),
    });
    return {
      ok: turn.ok,
      text: turn.text,
      toolCalls: turn.toolCalls,
      ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(turn.error ? { error: turn.error } : {}),
      ...(turn.aborted ? { aborted: true } : {}),
    };
  }

  /** RAG for the agent: one index, narrowed to the workspace's folders. */
  private async agentRagSearch(workspace: AiWorkspace, query: string): Promise<string> {
    if (!this.aiSettings.rag.enabled) return "RAG 检索未启用。";
    const hits = await this.rag.query(query, {
      ...(workspace.folders.length ? { scope: { folders: workspace.folders } } : {}),
    });
    if (!hits.length) return "没有检索到相关片段。";
    return hits
      .map((hit, index) => `[${index + 1}] ${hit.path}:${hit.metadata.startLine ?? "?"}-${hit.metadata.endLine ?? "?"}\n${hit.content}`)
      .join("\n\n");
  }

  /** One host model turn for a domain skill's `ask`. */
  private async agentAskModel(prompt: string): Promise<string> {
    const runtime = this.runtimeFor("chat");
    if (!runtime.ok) throw new Error(runtime.message);
    const turn = await runChatTurn({
      config: { ...runtime.config, stream: false },
      messages: [{ role: "user", content: prompt }],
      transport: this.transport,
    });
    if (!turn.ok) throw new Error(turn.error ?? "模型调用失败。");
    return turn.text;
  }

  private broadcastAgentEvent(event: AgentEvent): void {
    for (const leaf of this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof AiChatView) view.handleAgentEvent(event);
    }
  }

  private agentFolder(): string {
    // `runs/agent` rather than `runs/`: the run store lists only `v1_*.json`,
    // so a checkpoint directory beside the index cannot be mistaken for a run.
    return `${this.manifest.dir ?? ""}/runs/agent`;
  }

  private async persistAgentCheckpoint(checkpoint: AgentCheckpoint): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.agentFolder();
    this.agentCheckpointIds = [...new Set([...this.agentCheckpointIds, checkpoint.state.id])];
    try {
      await adapter.mkdir(dir);
    } catch {
      // already exists
    }
    await adapter.write(`${dir}/${checkpoint.state.id}.json`, JSON.stringify(checkpoint));
  }

  private async loadAgentCheckpoints(): Promise<AgentCheckpoint[]> {
    const dir = this.agentFolder();
    let files: string[] = [];
    try {
      files = (await this.app.vault.adapter.list(dir)).files;
    } catch {
      return [];
    }
    const out: AgentCheckpoint[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed: unknown = JSON.parse(await this.app.vault.adapter.read(file));
        if (!parsed || typeof parsed !== "object") continue;
        const checkpoint = parsed as AgentCheckpoint;
        if (checkpoint.state && typeof checkpoint.state.id === "string") out.push(checkpoint);
      } catch {
        // One corrupt checkpoint is skipped; the rest still resume.
      }
    }
    return out.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  }

  private async removeAgentCheckpoint(runId: string): Promise<void> {
    this.agentCheckpointIds = this.agentCheckpointIds.filter((id) => id !== runId);
    try {
      await this.app.vault.adapter.remove(`${this.agentFolder()}/${runId}.json`);
    } catch {
      // Already gone is success.
    }
  }

  private async persist(): Promise<void> {
    await this.saveData(this.aiSettings);
  }

  private async readRawSettings(): Promise<Record<string, unknown>> {
    const raw: unknown = await this.loadData();
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  private async copyDiagnostics(): Promise<void> {
    const report = this.buildDiagnostics();
    try {
      await navigator.clipboard.writeText(report);
      new Notice("诊断报告已复制到剪贴板。");
    } catch {
      new Notice("剪贴板不可用，报告已写入控制台。");
      console.log(report);
    }
  }
}

/** `app.secretStorage` exists from Obsidian 1.11.4; older versions get null. */
function detectSecretHost(app: unknown): SecretHost | null {
  const storage = (app as { secretStorage?: SecretHost }).secretStorage;
  if (!storage || typeof storage.getSecret !== "function" || typeof storage.setSecret !== "function") return null;
  return storage;
}

function legacySource(raw: Record<string, unknown>): LegacySecretSource {
  let value = typeof raw.aiApiKey === "string" ? raw.aiApiKey : "";
  const providerId = typeof raw.aiProvider === "string" && raw.aiProvider ? raw.aiProvider : "deepseek";
  const id = secretIdForProvider(providerId);
  return {
    read: (secretId) => (secretId === id ? value : ""),
    clear: (secretId) => {
      if (secretId === id) value = "";
    },
  };
}