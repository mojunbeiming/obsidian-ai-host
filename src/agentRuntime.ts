/**
 * The agent loop: goal -> plan -> tool turns -> observations -> checkpoint.
 *
 * ## The shape of one iteration
 *
 *     budget? -> model turn -> tool calls -> permission -> execute -> observe -> checkpoint
 *
 * Every arrow is a place the run can stop without losing anything: the budget
 * check happens between turns, approval pauses with the state on disk, and the
 * checkpoint after each turn means a killed Obsidian can resume instead of
 * restarting a run that has already written files.
 *
 * ## What this file does not own
 *
 * The model call arrives as `requestTurn`, the tools as `tools()`, the vault as
 * `createContext`, and the user's answers through an injected `PermissionGate`.
 * That keeps this file about *order*: which call runs when, what is written
 * down, and how the loop ends. Everything with a decision in it lives in the
 * SDK and is tested there.
 */

import type { AiChatMessage, AiToolCall, AiToolDefinition, AiUsage } from "../sdk/src/ai/aiChat";
import type { AiRunStepInput } from "../sdk/src/ai/aiRunLog";
import {
  AI_OBSERVATION_MAX_CHARS,
  agentPlanPrompt,
  agentPlanProgress,
  createAgentRun,
  detectNoProgress,
  evaluateAgentBudget,
  firstOpenPlanItem,
  formatAgentPlan,
  markPlanItem,
  normalizeAgentRun,
  parseAgentPlan,
  summarizeAgentDelivery,
  truncateObservation,
  wrapToolResult,
  type AiAgentPlanItem,
  type AiAgentRunState,
  type AiAgentStepRecord,
  type AiToolFingerprint,
} from "../sdk/src/ai/aiAgent";
import { addUsage } from "../sdk/src/ai/aiUsageStats";
import { parseToolArguments } from "../sdk/src/ai/aiTools";
import { workspaceAllowsPath, type AiWorkspace } from "../sdk/src/ai/aiWorkspace";
import type { AgentTool, AgentToolContext } from "./agentTools";
import { buildAgentSystemPrompt } from "./agentPrompt";
import type { ApprovalAnswer, ApprovalRequest, PermissionGate } from "./permissions";
import type { AiRunFinishPayload } from "./runHub";

/** One model turn, as the runtime consumes it. */
export interface AgentTurnResult {
  ok: boolean;
  text: string;
  toolCalls: AiToolCall[];
  reasoning?: string;
  usage?: AiUsage;
  error?: string;
  aborted?: boolean;
}

export type AgentTurnRequest = (input: {
  messages: AiChatMessage[];
  tools: AiToolDefinition[];
  signal?: AbortSignal;
  onText?: (delta: string, full: string) => void;
}) => Promise<AgentTurnResult>;

export interface AgentCheckpoint {
  schema: number;
  savedAt: number;
  state: AiAgentRunState;
  /** The working transcript, so a resume does not rebuild it from summaries. */
  messages: AiChatMessage[];
}

export type AgentEvent =
  | { type: "state"; state: AiAgentRunState }
  | { type: "delta"; text: string }
  | { type: "approval"; state: AiAgentRunState; request: ApprovalRequest }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { type: "done"; state: AiAgentRunState; summary: string; runId: string };

export interface AgentRuntimeDeps {
  tools(): readonly AgentTool[];
  getWorkspace(id: string): AiWorkspace | null;
  createContext(input: {
    workspace: AiWorkspace;
    runId: string;
    batchId: string;
    signal?: AbortSignal;
    onUpdatePlan?: (items: AiAgentPlanItem[]) => void;
  }): AgentToolContext;
  requestTurn: AgentTurnRequest;
  gate: PermissionGate;
  beginRun(input: { title: string; workspaceId: string }): string;
  finishRun(runId: string, payload: AiRunFinishPayload): Promise<void>;
  trace(runId: string, step: AiRunStepInput): void;
  persistCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
  loadCheckpoints(): Promise<AgentCheckpoint[]>;
  removeCheckpoint(runId: string): Promise<void>;
  estimateCost(model: string, usage: AiUsage): number | null;
  model(): string;
  onEvent(event: AgentEvent): void;
  now?(): number;
}

const MAX_TRANSCRIPT_MESSAGES = 80;
const MAX_STEP_RECORDS = 60;
const MAX_AUDIT_ENTRIES = 200;

export class AgentRuntime {
  private state: AiAgentRunState | null = null;
  private messages: AiChatMessage[] = [];
  private controller: AbortController | null = null;
  private runId = "";
  private stopRequested = false;
  private pauseRequested = false;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private approval: { callId: string; resolve: (answer: ApprovalAnswer) => void } | null = null;
  private recentCalls: AiToolFingerprint[] = [];
  private rejections = 0;

  constructor(private readonly deps: AgentRuntimeDeps) {}

  getState(): AiAgentRunState | null {
    return this.state;
  }

  isRunning(): boolean {
    return this.state !== null && (this.state.status === "running" || this.state.status === "planning" || this.state.status === "paused_approval");
  }

  /** Start a fresh run; resolves when the run ends. */
  async start(input: {
    goal: string;
    workspaceId: string;
    permission: AiAgentRunState["permission"];
    budget?: Partial<AiAgentRunState["budget"]>;
  }): Promise<AiAgentRunState> {
    if (this.isRunning()) throw new Error("已有一个 Agent 在运行，请先停止。");
    const workspace = this.deps.getWorkspace(input.workspaceId);
    if (!workspace) throw new Error("找不到工作区，无法启动 Agent。");
    const state = createAgentRun({
      goal: input.goal,
      workspaceId: input.workspaceId,
      permission: input.permission,
      ...(input.budget ? { budget: input.budget } : {}),
    });
    this.runId = this.deps.beginRun({ title: input.goal.slice(0, 40) || "Agent 任务", workspaceId: input.workspaceId });
    this.prepare(state, [], workspace);
    this.deps.trace(this.runId, {
      kind: "agent.start",
      title: `目标：${state.goal}`,
      detail: `工作区 ${workspace.name}（${workspace.folders.length ? workspace.folders.join("、") : "整个库"}） 权限 ${state.permission}`,
      meta: { budgetSteps: state.budget.maxSteps, budgetTokens: state.budget.maxTokens, workspaceId: state.workspaceId },
    });
    await this.loop(workspace);
    return state;
  }

  /** Continue a checkpoint that survived a restart. */
  async resume(checkpoint: AgentCheckpoint): Promise<AiAgentRunState> {
    if (this.isRunning()) throw new Error("已有一个 Agent 在运行。");
    const state = normalizeAgentRun(checkpoint.state);
    if (!state) throw new Error("检查点已损坏，无法继续。");
    const workspace = this.deps.getWorkspace(state.workspaceId);
    if (!workspace) throw new Error("检查点引用的工作区已不存在。");
    state.status = "running";
    delete state.error;
    delete state.pendingApproval;
    this.prepare(state, repairTranscript(sanitizeTranscript(checkpoint.messages)), workspace);
    this.runId = this.deps.beginRun({ title: `${state.goal.slice(0, 32)}（继续）`, workspaceId: state.workspaceId });
    this.deps.trace(this.runId, { kind: "agent.resume", title: "从检查点继续", detail: `第 ${state.steps.length} 步` });
    await this.loop(workspace);
    return state;
  }

  private prepare(state: AiAgentRunState, messages: AiChatMessage[], workspace: AiWorkspace): void {
    this.state = state;
    const transcript = messages.length ? [...messages] : [];
    if (transcript[0]?.role !== "system") transcript.unshift({ role: "system", content: buildAgentSystemPrompt(workspace) });
    this.messages = transcript;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.paused = false;
    this.recentCalls = [];
    this.rejections = 0;
    this.controller = new AbortController();
    this.deps.onEvent({ type: "state", state });
  }

  /** Stop at the next safe point; the signal aborts the live turn. */
  stop(): void {
    this.stopRequested = true;
    this.controller?.abort();
    const pending = this.approval;
    this.approval = null;
    pending?.resolve("reject");
  }

  /** Pause between turns; a paused run keeps its checkpoint. */
  pause(): void {
    if (!this.isRunning()) return;
    this.pauseRequested = true;
  }

  /** Continue a paused run. */
  resumeRun(): void {
    this.pauseRequested = false;
    if (!this.paused) return;
    this.paused = false;
    for (const waiter of this.resumeWaiters.splice(0)) waiter();
  }

  /** The approval bridge the gate calls; parks until the user answers. */
  requestApproval(request: ApprovalRequest, _signal?: AbortSignal): Promise<ApprovalAnswer> {
    void _signal;
    const state = this.state;
    if (!state || this.stopRequested) return Promise.resolve("reject");
    return this.waitForApproval(request, state);
  }

  /** Answer the approval the run is parked on. */
  approve(callId: string, answer: ApprovalAnswer): void {
    this.deps.gate.remember(callId, answer);
    const pending = this.approval;
    if (!pending || pending.callId !== callId) return;
    this.approval = null;
    pending.resolve(answer);
  }

  /** Every checkpoint on disk, newest first; corrupt ones are skipped by the store. */
  async loadCheckpoints(): Promise<AgentCheckpoint[]> {
    return this.deps.loadCheckpoints();
  }

  /** Delete a checkpoint the user chose not to continue. */
  async discardCheckpoint(runId: string): Promise<void> {
    await this.deps.removeCheckpoint(runId);
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  private async loop(workspace: AiWorkspace): Promise<void> {
    const state = this.state;
    if (!state) return;
    try {
      await this.plan(state, workspace);
      for (;;) {
        if (this.stopRequested) return await this.finish(state, "cancelled", "已终止");
        await this.maybePause(state);
        const verdict = evaluateAgentBudget(state.budget, state, this.now());
        if (verdict.exceeded) {
          this.deps.trace(this.runId, { kind: "agent.budget", level: "warn", title: verdict.message, meta: { reason: verdict.reason } });
          return await this.finish(state, "budget_exceeded", verdict.message);
        }

        const step: AiAgentStepRecord = { index: state.steps.length, at: this.now(), toolCalls: [] };
        state.steps.push(step);
        if (state.steps.length > MAX_STEP_RECORDS) state.steps.shift();
        state.status = "running";
        this.deps.onEvent({ type: "state", state });

        const open = firstOpenPlanItem(state.plan);
        this.messages.push({ role: "user", content: this.stepMessage(state, open?.title) });
        const turn = await this.callModel(state, this.deps.tools());
        step.thought = turn.text.slice(0, 2000);
        step.endedAt = this.now();
        if (turn.usage) step.tokens = turn.usage.totalTokens;

        if (!turn.ok) {
          await this.finish(state, turn.aborted || this.stopRequested ? "cancelled" : "failed", turn.error ?? "模型调用失败。", turn.error);
          return;
        }
        this.messages.push({
          role: "assistant",
          content: turn.text,
          ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
          ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
        });
        if (!turn.toolCalls.length) {
          await this.finish(state, "done", turn.text || "已完成。");
          return;
        }

        const outcome = await this.runCalls(state, workspace, turn.toolCalls);
        step.toolCalls = outcome.records;
        this.trimMessages();

        const item = firstOpenPlanItem(state.plan);
        if (item) {
          state.plan = markPlanItem(state.plan, item.id, outcome.anyOk ? "done" : "failed");
          this.deps.trace(this.runId, {
            kind: "agent.plan",
            title: `${item.id} ${outcome.anyOk ? "完成" : "失败"}：${item.title}`,
            detail: agentPlanProgress(state.plan).label,
          });
        }
        await this.checkpoint(state);
        if (this.stopRequested) return await this.finish(state, "cancelled", "已终止");
        if (this.rejections >= 3) return await this.finish(state, "failed", "连续多次审批被拒绝，已停止。");
        if (detectNoProgress(this.recentCalls)) {
          return await this.finish(state, "failed", "连续两次相同的工具调用没有进展，已停止。");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(state, "failed", "Agent 运行出错。", message);
    }
  }

  private async plan(state: AiAgentRunState, workspace: AiWorkspace): Promise<void> {
    if (state.plan.length) return;
    state.status = "planning";
    this.deps.onEvent({ type: "state", state });
    const scope = workspace.folders.length ? workspace.folders.join("、") : "整个库";
    this.messages.push({ role: "user", content: agentPlanPrompt({ goal: state.goal, scopeLabel: scope }) });
    const turn = await this.callModel(state, []);
    const parsed = parseAgentPlan(turn.ok ? turn.text : "");
    state.plan = parsed.items;
    this.deps.trace(this.runId, {
      kind: "agent.plan",
      level: turn.ok && !parsed.degraded ? "info" : "warn",
      title: !turn.ok ? "计划生成失败，改为动态执行" : parsed.degraded ? "计划解析失败，改为动态执行" : `计划：${state.plan.length} 步`,
      detail: turn.ok ? formatAgentPlan(state.plan) : turn.error ?? "",
    });
    if (turn.ok && turn.text) this.messages.push({ role: "assistant", content: turn.text });
    await this.checkpoint(state);
  }

  /** One model turn, with usage/cost folded into the run state and the trace. */
  private async callModel(state: AiAgentRunState, tools: readonly AgentTool[]): Promise<AgentTurnResult> {
    const definitions = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    const turn = await this.deps.requestTurn({
      messages: [...this.messages],
      tools: definitions,
      ...(this.controller ? { signal: this.controller.signal } : {}),
      onText: (_delta, full) => this.deps.onEvent({ type: "delta", text: full }),
    });
    if (turn.usage) {
      state.usage = addUsage(state.usage, turn.usage);
      const cost = this.deps.estimateCost(this.deps.model(), turn.usage);
      if (cost !== null) state.costUsd += cost;
    }
    this.deps.trace(this.runId, {
      kind: "agent.think",
      title: turn.toolCalls.length ? `请求 ${turn.toolCalls.length} 个工具` : "给出结论",
      detail: turn.text.slice(0, 2000),
      ...(turn.usage
        ? { meta: { prompt: turn.usage.promptTokens, completion: turn.usage.completionTokens, cached: turn.usage.cachedTokens ?? 0 } }
        : {}),
    });
    this.deps.onEvent({ type: "state", state });
    return turn;
  }

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  private async runCalls(
    state: AiAgentRunState,
    workspace: AiWorkspace,
    calls: readonly AiToolCall[],
  ): Promise<{ records: AiAgentStepRecord["toolCalls"]; anyOk: boolean }> {
    const context = this.deps.createContext({
      workspace,
      runId: this.runId,
      batchId: state.id,
      ...(this.controller ? { signal: this.controller.signal } : {}),
      onUpdatePlan: (items) => {
        state.plan = items;
        this.deps.trace(this.runId, {
          kind: "agent.plan",
          title: `模型更新计划：${items.length} 步`,
          detail: formatAgentPlan(items),
        });
      },
    });
    const tools = this.deps.tools();
    const records: AiAgentStepRecord["toolCalls"] = [];
    let anyOk = false;
    /** Reads may run concurrently; every write waits for its own approval. */
    const readBatch: { call: AiToolCall; tool: AgentTool; args: Record<string, unknown> }[] = [];

    const flushReads = async (): Promise<void> => {
      if (!readBatch.length) return;
      const batch = readBatch.splice(0);
      const results = await Promise.all(
        batch.map(async (item) => ({ item, result: await this.executeOne(state, context, item.tool, item.call, item.args) })),
      );
      for (const { item, result } of results) {
        records.push(result.record);
        this.pushToolMessage(item.call, result.message, result.observation);
        if (result.record.ok) anyOk = true;
      }
    };

    for (const call of calls) {
      const tool = tools.find((entry) => entry.name === call.name);
      const parsed = parseToolArguments(call);
      const path = tool && parsed.ok ? tool.pathOf(parsed.args) : undefined;
      this.recentCalls.push({ name: call.name, argsKey: canonicalArgs(call.arguments) });
      if (this.recentCalls.length > 8) this.recentCalls.shift();

      if (!tool) {
        await flushReads();
        records.push({ name: call.name, ok: false, note: "未知工具" });
        this.pushToolMessage(call, `未知工具：${call.name}`);
        continue;
      }
      if (!parsed.ok) {
        await flushReads();
        records.push({ name: call.name, ok: false, note: parsed.message });
        this.pushToolMessage(call, parsed.message);
        continue;
      }
      if (path && !workspaceAllowsPath(workspace, path, tool.pathKind ?? "file")) {
        await flushReads();
        const message = `路径越界，已拒绝：${path}`;
        records.push({ name: call.name, ok: false, note: message });
        this.deps.trace(this.runId, { kind: "agent.tool.run", level: "warn", title: `${call.name} 越界被拒绝`, detail: path });
        this.pushToolMessage(call, message);
        continue;
      }

      // Reads auto-run only when the tier allows them; otherwise each call
      // goes through its own approval, one at a time.
      const canBatchRead = tool.effect === "read" && this.deps.gate.decide(workspace, "read") === "allow";
      if (canBatchRead) {
        readBatch.push({ call, tool, args: parsed.args });
        continue;
      }
      await flushReads();
      const result = await this.executeOne(state, context, tool, call, parsed.args);
      records.push(result.record);
      this.pushToolMessage(call, result.message, result.observation);
      if (result.record.ok) anyOk = true;
      await this.checkpoint(state);
    }
    await flushReads();
    return { records, anyOk };
  }

  /** Permission, execution, observation for one call. Never throws. */
  private async executeOne(
    state: AiAgentRunState,
    context: AgentToolContext,
    tool: AgentTool,
    call: AiToolCall,
    args: Record<string, unknown>,
  ): Promise<{ record: AiAgentStepRecord["toolCalls"][number]; message: string; observation: string }> {
    const path = tool.pathOf(args);
    const request: ApprovalRequest = {
      callId: call.id,
      tool: tool.name,
      effect: tool.effect,
      ...(path ? { path } : {}),
      summary: describeToolCall(tool, args),
    };
    const grant = await this.deps.gate.authorize(context.workspace, request, this.controller?.signal);
    if (!grant.allowed) {
      const message = grant.reason ?? "已拒绝。";
      this.rejections += 1;
      this.deps.trace(this.runId, { kind: "agent.tool.approval", level: "warn", title: `拒绝 ${call.name}`, detail: message });
      return { record: { name: call.name, ok: false, note: message }, message, observation: message };
    }
    if (grant.answer === "allow-run") this.recentCalls = [];

    const startedAt = this.now();
    this.deps.trace(this.runId, { kind: "agent.tool.run", status: "running", title: `${call.name}`, detail: path ?? "" });
    try {
      const result = await tool.run(args, context);
      const observation = truncateObservation(result.text, AI_OBSERVATION_MAX_CHARS);
      if (result.audits?.length) {
        state.writes = [...state.writes, ...result.audits].slice(-MAX_AUDIT_ENTRIES);
        for (const audit of result.audits) {
          this.deps.trace(this.runId, {
            kind: "agent.write",
            title: `写入 ${audit.path}`,
            detail: `${audit.beforeChars}  ${audit.afterChars} 字  ${audit.beforeHash || ""}  ${audit.afterHash}`,
            meta: { backupId: audit.id, batchId: audit.batchId, path: audit.path },
          });
        }
      }
      this.deps.trace(this.runId, {
        kind: "agent.observe",
        title: `${call.name} 返回 ${observation.chars} 字`,
        detail: observation.text.slice(0, 1000),
        meta: { chars: observation.chars, truncated: observation.truncated, hash: observation.hash, ms: this.now() - startedAt },
      });
      const record: AiAgentStepRecord["toolCalls"][number] = {
        name: call.name,
        ok: true,
        ...(path ? { note: path } : {}),
        ...(result.audits?.length ? { auditIds: result.audits.map((audit) => audit.id) } : {}),
      };
      return { record, message: wrapToolResult({ name: call.name, text: observation.text, truncated: observation.truncated }), observation: observation.text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.trace(this.runId, { kind: "agent.tool.run", level: "error", status: "failed", title: `${call.name} 失败`, detail: message });
      return { record: { name: call.name, ok: false, note: message }, message: `工具执行失败：${message}`, observation: message };
    }
  }

  /** The tool turn the model reads. */
  private pushToolMessage(call: AiToolCall, content: string, raw = content): void {
    const step = this.state?.steps[this.state.steps.length - 1];
    if (step) step.observation = truncateObservation(raw, 1500).text;
    this.messages.push({ role: "tool", content, toolCallId: call.id, name: call.name });
  }

  // -------------------------------------------------------------------------
  // Control-flow helpers
  // -------------------------------------------------------------------------

  private async maybePause(state: AiAgentRunState): Promise<void> {
    if (!this.pauseRequested) return;
    this.paused = true;
    state.status = "paused_user";
    await this.checkpoint(state);
    this.deps.onEvent({ type: "state", state });
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    if (!this.stopRequested) {
      state.status = "running";
      this.deps.onEvent({ type: "state", state });
    }
  }

  private stepMessage(state: AiAgentRunState, currentTitle?: string): string {
    const lines = [`目标：${state.goal}`];
    if (state.plan.length) {
      lines.push(`当前计划：\n${formatAgentPlan(state.plan)}`);
      lines.push(currentTitle ? `请执行下一步：${currentTitle}` : "计划步骤已执行完：请检查目标是否达成，给出最终答复。");
    } else {
      lines.push("没有固定计划：请根据目标决定下一个最有用的动作，完成后给出结论。");
    }
    lines.push("任务完成就给出最终答复，不要再调用工具。");
    return lines.join("\n\n");
  }

  /** Keep the transcript bounded without cutting an assistant/tool pair apart. */
  private trimMessages(): void {
    if (this.messages.length <= MAX_TRANSCRIPT_MESSAGES) return;
    const head = this.messages.slice(0, this.messages[0]?.role === "system" ? 2 : 1);
    let tail = this.messages.slice(-(MAX_TRANSCRIPT_MESSAGES - head.length));
    while (tail.length && tail[0].role !== "user") tail = tail.slice(1);
    this.messages = [...head, ...tail];
  }

  /** Park on an approval and wait for the UI; a stop rejects every waiter. */
  private waitForApproval(request: ApprovalRequest, state: AiAgentRunState): Promise<ApprovalAnswer> {
    state.status = "paused_approval";
    state.pendingApproval = { callId: request.callId, tool: request.tool, ...(request.path ? { path: request.path } : {}), summary: request.summary };
    return new Promise<ApprovalAnswer>((resolve) => {
      this.approval = { callId: request.callId, resolve };
      void this.checkpoint(state).then(() => {
        this.deps.onEvent({ type: "state", state });
        this.deps.onEvent({ type: "approval", state, request });
      });
    });
  }

  private async checkpoint(state: AiAgentRunState): Promise<void> {
    state.checkpointId = `${state.id}-${state.steps.length}`;
    await this.deps.persistCheckpoint({ schema: 1, savedAt: this.now(), state, messages: this.messages });
  }

  private async finish(
    state: AiAgentRunState,
    status: AiAgentRunState["status"],
    message: string,
    error?: string,
  ): Promise<void> {
    const terminal = state.status === "done" || state.status === "failed" || state.status === "cancelled" || state.status === "budget_exceeded";
    if (terminal) return;
    state.status = status;
    state.endedAt = this.now();
    if (error) state.error = error;
    delete state.pendingApproval;
    const summary = summarizeAgentDelivery(state);
    await this.checkpoint(state);
    this.deps.trace(this.runId, {
      kind: status === "done" ? "agent.deliver" : "agent.stop",
      level: status === "failed" || status === "budget_exceeded" ? "warn" : "info",
      title: message.slice(0, 120) || state.goal,
      detail: summary,
    });
    await this.deps.finishRun(this.runId, {
      status: status === "done" ? "ok" : status === "cancelled" ? "cancelled" : "failed",
      summary,
      usage: {
        prompt: state.usage.prompt,
        completion: state.usage.completion,
        total: state.usage.total,
        ...(state.usage.cached ? { cached: state.usage.cached } : {}),
      },
      ...(state.costUsd ? { costUsd: state.costUsd } : {}),
      ...(status === "failed" || status === "budget_exceeded" ? { error: { message: state.error ?? message } } : {}),
    });
    this.deps.onEvent({ type: "done", state, summary, runId: this.runId });
    // A finished run is not resumable; the run log keeps the record.
    await this.deps.removeCheckpoint(state.id);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** One sentence for the approval banner and the trace. */
function describeToolCall(tool: AgentTool, args: Record<string, unknown>): string {
  const path = tool.pathOf(args);
  const detail = path ? path : typeof args.query === "string" ? `${args.query}` : "";
  return detail ? `${tool.name}：${detail}` : tool.name;
}

/** Malformed JSON and reordered keys compare as the same call. */
function canonicalArgs(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  try {
    return JSON.stringify(sortKeys(JSON.parse(text) as Record<string, unknown>));
  } catch {
    return text || "{}";
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Close an assistant tool-call turn that has no tool results yet.
 *
 * An approval pause writes the checkpoint *after* the assistant asked for a
 * tool and before it ran; resuming without the tool messages would send a
 * protocol-invalid transcript (every protocol wants each call answered).
 * The synthetic answer says what happened and lets the model decide again.
 */
function repairTranscript(messages: AiChatMessage[]): AiChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !last.toolCalls?.length) return messages;
  const answers: AiChatMessage[] = last.toolCalls.map((call) => ({
    role: "tool" as const,
    content: "（上次运行在这个调用等待审批时中断，调用没有执行；请重新决定。）",
    toolCallId: call.id,
    name: call.name,
  }));
  return [...messages, ...answers];
}

/** A checkpoint transcript is model input; keep only well-formed turns. */
function sanitizeTranscript(value: unknown): AiChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: AiChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.role !== "system" && record.role !== "user" && record.role !== "assistant" && record.role !== "tool") continue;
    if (typeof record.content !== "string" && !Array.isArray(record.content)) continue;
    out.push(item as AiChatMessage);
  }
  return out.slice(-MAX_TRANSCRIPT_MESSAGES);
}
