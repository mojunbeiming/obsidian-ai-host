/**
 * The agent's tools: five reads, six writes, two destructive operations, and
 * one tool per agent-capable domain skill.
 *
 * ## Every tool goes through one context
 *
 * A tool never touches the vault directly. `AgentToolContext` is the only door:
 * it normalizes the path, checks the workspace sandbox *again* (the runtime
 * checks before approval; this is the check that a resumed checkpoint cannot
 * skip), and writes the backup before it writes the note. A tool that forgot
 * one of those would be a tool whose call site forgot it too -- there is no
 * call site.
 *
 * ## Destructive defaults
 *
 * `vault.rename` and `vault.trash` are `destructive`: even `full` confirms them
 * unless the user turned that off. A rename records two audit entries -- restore
 * the old path, remove the new one -- so a batch undo puts the vault back
 * instead of leaving a copy.
 *
 * ## Skill tools
 *
 * A domain skill with `agent()` becomes `skill.<id>`, and the host never parses
 * what it returns. A skill without `agent()` simply has no tool: the UI-first
 * migration path stays open.
 */

import { TFile, type App } from "obsidian";
import {
  checkWorkspacePath,
  workspaceAllowsPath,
  type AiToolEffect,
  type AiWorkspace,
} from "../sdk/src/ai/aiWorkspace";
import type { AiWriteAudit } from "../sdk/src/ai/aiAudit";
import type { AiAgentSkillResult, AiSkillDefinition } from "../sdk/src/ai/aiSkill";
import type { AiAgentPlanItem, AiAgentPlanStatus } from "../sdk/src/ai/aiAgent";
import type { BackupStore } from "./backups";

const MAX_SEARCH_HITS = 25;
const MAX_SEARCH_FILES = 800;
const MAX_LIST_ENTRIES = 200;
const MAX_READ_LINES = 400;

export interface AgentToolResult {
  text: string;
  audits?: AiWriteAudit[];
}

export interface AgentToolContext {
  workspace: AiWorkspace;
  runId: string;
  batchId: string;
  signal?: AbortSignal;
  readNote(path: string): Promise<string | null>;
  listNotes(folder?: string): Promise<string[]>;
  searchNotes(query: string): Promise<string>;
  outlineNote(path: string): Promise<string>;
  createNote(path: string, content: string, tool: string): Promise<AiWriteAudit>;
  writeNote(path: string, content: string, tool: string): Promise<AiWriteAudit>;
  renameNote(path: string, nextPath: string, tool: string): Promise<AiWriteAudit[]>;
  trashNote(path: string, tool: string): Promise<AiWriteAudit>;
  ragSearch(query: string): Promise<string>;
  /** Replace the visible plan; the runtime owns what that means. */
  replacePlan(items: AiAgentPlanItem[]): void;
  runSkill(skill: AiSkillDefinition, instruction: string): Promise<AiAgentSkillResult>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: AiToolEffect;
  /** Whether `pathOf` names a file (default) or a folder, for the sandbox. */
  pathKind?: "file" | "directory";
  /** The path this call touches, for the sandbox check and the approval banner. */
  pathOf(args: Record<string, unknown>): string | undefined;
  run(args: Record<string, unknown>, ctx: AgentToolContext): Promise<AgentToolResult>;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

export function createAgentTools(): AgentTool[] {
  return [
    {
      name: "vault.search",
      description: "在库中搜索文字，返回 路径:行号: 内容。适合先定位再精读。",
      effect: "read",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "要搜索的文字" } },
        required: ["query"],
      },
      pathOf: () => undefined,
      run: async (args, ctx) => ({ text: await ctx.searchNotes(stringArg(args, "query")) }),
    },
    {
      name: "vault.read",
      description: "读取一篇 Markdown 笔记，可选起止行；行号从 1 开始。",
      effect: "read",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "库内相对路径" },
          fromLine: { type: "integer", description: "起始行（可选）" },
          toLine: { type: "integer", description: "结束行，含（可选）" },
        },
        required: ["path"],
      },
      pathOf: (args) => stringArg(args, "path") || undefined,
      run: async (args, ctx) => {
        const path = stringArg(args, "path");
        const content = await ctx.readNote(path);
        if (content === null) return { text: `找不到笔记：${path}` };
        const lines = content.split(/\r\n|\r|\n/);
        const from = Math.max(1, numberArg(args, "fromLine") ?? 1);
        const to = Math.min(lines.length, numberArg(args, "toLine") ?? from + MAX_READ_LINES - 1);
        const slice = lines.slice(from - 1, to);
        return { text: `${path}:${from}-${to}\n${slice.map((line, index) => `${from + index}| ${line}`).join("\n")}` };
      },
    },
    {
      name: "vault.list",
      description: "列出工作区范围内的 Markdown 文件路径，可按文件夹前缀过滤。",
      effect: "read",
      pathKind: "directory",
      parameters: {
        type: "object",
        properties: { folder: { type: "string", description: "可选的文件夹路径" } },
      },
      pathOf: (args) => stringArg(args, "folder") || undefined,
      run: async (args, ctx) => ({ text: (await ctx.listNotes(stringArg(args, "folder") || undefined)).join("\n") || "没有匹配的笔记。" }),
    },
    {
      name: "vault.outline",
      description: "列出一篇笔记的标题结构（层级 + 标题 + 行号）。",
      effect: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "库内相对路径" } },
        required: ["path"],
      },
      pathOf: (args) => stringArg(args, "path") || undefined,
      run: async (args, ctx) => ({ text: await ctx.outlineNote(stringArg(args, "path")) }),
    },
    {
      name: "rag.search",
      description: "在已建好的向量索引里做语义检索，返回最相关的片段。",
      effect: "read",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "检索问题" } },
        required: ["query"],
      },
      pathOf: () => undefined,
      run: async (args, ctx) => ({ text: await ctx.ragSearch(stringArg(args, "query")) }),
    },
    {
      name: "vault.create",
      description: "新建一篇 Markdown 笔记（父文件夹不存在时自动创建）。",
      effect: "write",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "库内相对路径，需以 .md 结尾" },
          content: { type: "string", description: "完整正文" },
        },
        required: ["path", "content"],
      },
      pathOf: (args) => stringArg(args, "path") || undefined,
      run: async (args, ctx) => {
        const path = stringArg(args, "path");
        const content = typeof args.content === "string" ? args.content : "";
        const audit = await ctx.createNote(path, content, "vault.create");
        return { text: `已新建 ${path}（${content.length} 字）`, audits: [audit] };
      },
    },
    {
      name: "vault.append",
      description: "在笔记末尾追加内容（自动补一个换行）。",
      effect: "write",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "库内相对路径" },
          text: { type: "string", description: "要追加的 Markdown" },
        },
        required: ["path", "text"],
      },
      pathOf: (args) => stringArg(args, "path") || undefined,
      run: async (args, ctx) => {
        const path = stringArg(args, "path");
        const text = typeof args.text === "string" ? args.text : "";
        const before = (await ctx.readNote(path)) ?? "";
        const next = before && !before.endsWith("\n") ? `${before}\n${text}` : `${before}${text}`;
        const audit = await ctx.writeNote(path, next, "vault.append");
        return { text: `已追加到 ${path}（+${text.length} 字）`, audits: [audit] };
      },
    },
    {
      name: "vault.replaceRange",
      description: "用新内容替换笔记的指定行区间（行号从 1 开始，含首尾）。",
      effect: "write",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "库内相对路径" },
          fromLine: { type: "integer", description: "起始行" },
          toLine: { type: "integer", description: "结束行，含" },
          replacement: { type: "string", description: "替换后的文字（可为空）" },
        },
        required: ["path", "fromLine", "toLine", "replacement"],
      },
      pathOf: (args) => stringArg(args, "path") || undefined,
      run: async (args, ctx) => {
        const path = stringArg(args, "path");
        const before = await ctx.readNote(path);
        if (before === null) return { text: `找不到笔记：${path}` };
        const from = Math.max(1, numberArg(args, "fromLine") ?? 1);
        const to = Math.max(from, numberArg(args, "toLine") ?? from);
        const replacement = typeof args.replacement === "string" ? args.replacement : "";
        const lines = before.split(/\r\n|\r|\n/);
        if (from > lines.length) return { text: `${path} 只有 ${lines.length} 行，无法替换第 ${from} 行。` };
        const next = [...lines.slice(0, from - 1), ...replacement.split(/\r\n|\r|\n/), ...lines.slice(to)].join("\n");
        const audit = await ctx.writeNote(path, next, "vault.replaceRange");
        return { text: `已替换 ${path} 的 ${from}-${to} 行`, audits: [audit] };
      },
    },
    {
      name: "vault.rewriteNote",
      description: "用新正文整体重写一篇笔记。适合已知全文的情况。",
      effect: "write",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "库内相对路径" },
          content: { type: "string", description: "新的完整正文" },
        },
        required: ["path", "content"],
      },
      pathOf: (args) => stringArg(args, "path") || undefined,
      run: async (args, ctx) => {
        const path = stringArg(args, "path");
        const content = typeof args.content === "string" ? args.content : "";
        const audit = await ctx.writeNote(path, content, "vault.rewriteNote");
        return { text: `已重写 ${path}（${content.length} 字）`, audits: [audit] };
      },
    },
    {
      name: "vault.rename",
      description: "重命名或移动一篇笔记。移动后原路径不再存在。",
      effect: "destructive",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "现在的路径" },
          nextPath: { type: "string", description: "新路径，需以 .md 结尾" },
        },
        required: ["path", "nextPath"],
      },
      pathOf: (args) => stringArg(args, "path") || undefined,
      run: async (args, ctx) => {
        const path = stringArg(args, "path");
        const nextPath = stringArg(args, "nextPath");
        if (!nextPath) return { text: "缺少 nextPath。" };
        const audits = await ctx.renameNote(path, nextPath, "vault.rename");
        return { text: `已移动 ${path}  ${nextPath}`, audits };
      },
    },
    {
      name: "vault.trash",
      description: "把一篇笔记移到系统回收站（可恢复，但默认需要确认）。",
      effect: "destructive",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "要移入回收站的路径" } },
        required: ["path"],
      },
      pathOf: (args) => stringArg(args, "path") || undefined,
      run: async (args, ctx) => {
        const path = stringArg(args, "path");
        const audit = await ctx.trashNote(path, "vault.trash");
        return { text: `已把 ${path} 移入回收站`, audits: [audit] };
      },
    },
    {
      name: "agent.updatePlan",
      description: "用一份完整的新计划替换当前计划。发现原计划不合适、或某步需要拆分时调用。",
      effect: "read",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "array",
            description: "完整的计划列表，不是增量",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "可选，沿用原步骤 id" },
                title: { type: "string", description: "一步可验证的动作" },
                status: { type: "string", description: "todo/doing/done/failed/skipped" },
              },
              required: ["title"],
            },
          },
        },
        required: ["plan"],
      },
      pathOf: () => undefined,
      run: async (args, ctx) => {
        const raw = Array.isArray(args.plan) ? args.plan : [];
        const items: AiAgentPlanItem[] = [];
        for (const [index, entry] of raw.entries()) {
          if (items.length >= 10) break;
          if (!entry || typeof entry !== "object") continue;
          const record = entry as Record<string, unknown>;
          const title = typeof record.title === "string" ? record.title.trim() : "";
          if (!title) continue;
          const status: AiAgentPlanStatus =
            record.status === "doing" || record.status === "done" || record.status === "failed" || record.status === "skipped"
              ? record.status
              : "todo";
          items.push({
            id: typeof record.id === "string" && record.id ? record.id : `p${index + 1}`,
            title: title.slice(0, 160),
            status,
          });
        }
        if (!items.length) return { text: "计划为空或每步都缺少 title，未更新。" };
        ctx.replacePlan(items);
        return { text: `计划已更新为 ${items.length} 步。` };
      },
    },
  ];
}

/** One tool per registered skill that opted into the agent contract. */
export function createSkillTools(skills: readonly AiSkillDefinition[]): AgentTool[] {
  return skills
    .filter((skill) => typeof skill.agent === "function")
    .map((skill) => ({
      name: `skill.${skill.id}`,
      description: `${skill.description}（由领域插件执行，返回草稿；是否落盘由技能决定）`,
      effect: "write" as AiToolEffect,
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "这一步要做什么，尽量具体" },
          scope: { type: "string", description: "可选的笔记路径前缀" },
        },
        required: ["instruction"],
      },
      pathOf: (args) => stringArg(args, "scope") || undefined,
      run: async (args, ctx) => {
        const result = await ctx.runSkill(skill, stringArg(args, "instruction"));
        const body = result.message ?? result.draft.slice(0, 4000);
        return { text: result.files?.length ? `${body}\n改动：${result.files.join("、")}` : body };
      },
    }));
}



// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export interface AgentToolContextInput {
  app: App;
  workspace: AiWorkspace;
  runId: string;
  batchId: string;
  backups: BackupStore;
  signal?: AbortSignal;
  ragSearch?: (query: string) => Promise<string>;
  /** One host model turn for a skill's `ask`; undefined makes `ask` fail loudly. */
  askModel?: (prompt: string) => Promise<string>;
  /** Called by `agent.updatePlan`; the runtime applies and traces it. */
  onUpdatePlan?: (items: AiAgentPlanItem[]) => void;
  /** Trace sink for write steps; the runtime owns the run. */
  trace?: (kind: string, title: string, detail?: string) => void;
}

/**
 * Build the only way an agent tool reaches the vault.
 *
 * The sandbox is re-checked here rather than trusted from the caller, so a
 * checkpoint resumed after a restart -- or a skill returning a path -- cannot
 * route around it. A refused path throws, and the runtime turns that into a
 * tool result the model can read.
 */
export function createAgentToolContext(input: AgentToolContextInput): AgentToolContext {
  const { app, workspace, runId, batchId, backups } = input;

  const assertFile = (path: string): string => {
    const normalized = normalize(path);
    if (!normalized) throw new Error("路径为空。");
    const verdict = checkWorkspacePath(workspace, normalized, "file");
    if (!verdict.allowed) throw new Error(`路径越界（${verdict.reason}）：${normalized}`);
    return normalized;
  };

  const assertDirectory = (path: string): string => {
    const normalized = normalize(path);
    // The empty path is the workspace root: `vault.list` with no folder must
    // list exactly the scope, and the per-file check below still applies.
    if (!normalized) return "";
    const verdict = checkWorkspacePath(workspace, normalized, "directory");
    if (!verdict.allowed) throw new Error(`路径越界（${verdict.reason}）：${normalized}`);
    return normalized;
  };

  const fileAt = (path: string): TFile | null => {
    const file = app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  };

  const readNote = async (path: string): Promise<string | null> => {
    const file = fileAt(assertFile(path));
    return file ? await app.vault.cachedRead(file) : null;
  };

  const backupAndWrite = async (path: string, content: string, tool: string): Promise<AiWriteAudit> => {
    const before = await readNote(path);
    const audit = await backups.record({ batchId, runId, tool, path, before, after: content });
    const file = fileAt(path);
    // `vault.modify` rather than `adapter.write`: the vault keeps an in-memory
    // cache, and writing underneath it is how an open editor shows stale text.
    if (!file) throw new Error(`写入过程中笔记消失了：${path}`);
    await app.vault.modify(file, content);
    input.trace?.("agent.write", `${tool}：${path}`, `${before?.length ?? 0}  ${content.length} 字`);
    return audit;
  };

  return {
    workspace,
    runId,
    batchId,
    ...(input.signal ? { signal: input.signal } : {}),

    readNote,

    async listNotes(folder) {
      const prefix = assertDirectory(folder ?? "");
      const files = app.vault
        .getMarkdownFiles()
        .filter((file) => workspaceAllowsPath(workspace, file.path))
        .filter((file) => !prefix || file.path === prefix || file.path.startsWith(`${prefix}/`))
        .map((file) => file.path)
        .sort();
      return files.slice(0, MAX_LIST_ENTRIES);
    },

    async searchNotes(query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return "搜索词为空。";
      const hits: string[] = [];
      for (const file of app.vault.getMarkdownFiles().slice(0, MAX_SEARCH_FILES)) {
        if (hits.length >= MAX_SEARCH_HITS) break;
        if (!workspaceAllowsPath(workspace, file.path)) continue;
        const content = await app.vault.cachedRead(file);
        const lines = content.split(/\r\n|\r|\n/);
        for (let index = 0; index < lines.length && hits.length < MAX_SEARCH_HITS; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            hits.push(`${file.path}:${index + 1}: ${lines[index].trim().slice(0, 160)}`);
          }
        }
      }
      return hits.length ? hits.join("\n") : "没有找到匹配的内容。";
    },

    async outlineNote(path) {
      const file = fileAt(assertFile(path));
      if (!file) return `找不到笔记：${path}`;
      const content = await app.vault.cachedRead(file);
      const lines = content.split(/\r\n|\r|\n/);
      const headings: string[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
        if (match) headings.push(`${"  ".repeat(match[1].length - 1)}${match[1]} ${match[2]}  (${index + 1})`);
      }
      return headings.length ? headings.join("\n") : "这篇笔记没有标题。";
    },

    async createNote(path, content, tool) {
      const target = assertFile(path);
      if (fileAt(target)) throw new Error(`笔记已存在：${target}`);
      const audit = await backups.record({ batchId, runId, tool, path: target, before: null, after: content });
      await app.vault.create(target, content);
      input.trace?.("agent.write", `${tool}：${target}`, `新建 ${content.length} 字`);
      return audit;
    },

    async writeNote(path, content, tool) {
      const target = assertFile(path);
      if (!fileAt(target)) throw new Error(`找不到笔记：${target}`);
      return await backupAndWrite(target, content, tool);
    },

    async renameNote(path, nextPath, tool) {
      const from = assertFile(path);
      const to = assertFile(nextPath);
      const file = fileAt(from);
      if (!file) throw new Error(`找不到笔记：${from}`);
      if (fileAt(to)) throw new Error(`目标已存在：${to}`);
      const original = await app.vault.cachedRead(file);
      const auditFrom = await backups.record({ batchId, runId, tool, path: from, before: original, after: original });
      const auditTo = await backups.record({ batchId, runId, tool, path: to, before: null, after: original });
      await app.vault.rename(file, to);
      input.trace?.("agent.write", `${tool}：${from}  ${to}`, `移动 ${original.length} 字`);
      return [auditFrom, auditTo];
    },

    async trashNote(path, tool) {
      const target = assertFile(path);
      const file = fileAt(target);
      if (!file) throw new Error(`找不到笔记：${target}`);
      const original = await app.vault.cachedRead(file);
      const audit = await backups.record({ batchId, runId, tool, path: target, before: original, after: original });
      await app.vault.trash(file, true);
      input.trace?.("agent.write", `${tool}：${target}`, `移入回收站（${original.length} 字）`);
      return audit;
    },

    async ragSearch(query) {
      if (!input.ragSearch) return "RAG 索引未启用。";
      return await input.ragSearch(query);
    },

    replacePlan(items) {
      input.onUpdatePlan?.(items);
    },

    async runSkill(skill, instruction) {
      if (typeof skill.agent !== "function") throw new Error(`技能 ${skill.id} 不支持 Agent 调用。`);
      return await skill.agent({
        instruction,
        workspace: { id: workspace.id, name: workspace.name, folders: workspace.folders },
        ...(input.signal ? { signal: input.signal } : {}),
        ask: async (prompt) => {
          if (!input.askModel) throw new Error("宿主没有提供模型调用。");
          return await input.askModel(prompt);
        },
      });
    },
  };
}

function normalize(path: string): string {
  return (path ?? "").replace(/\\/g, "/").trim().replace(/^\.?\/*/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}