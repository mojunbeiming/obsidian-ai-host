/**
 * The built-in read-only tools.
 *
 * v3 ships exactly three, all read-only, all bounded: search, read, list. There
 * is no write tool to approve yet, which is why the approval UI can be simple;
 * when one is added it arrives with its own confirmation and backup path.
 */

import { App, TFile } from "obsidian";
import type { AiHostTool } from "../sdk/src/ai/aiTools";

const MAX_SEARCH_FILES = 800;
const MAX_SEARCH_HITS = 20;
const MAX_LIST_ENTRIES = 200;

export function createVaultTools(app: App): AiHostTool[] {
  return [
    {
      name: "vault.search",
      description: "在库里的 Markdown 笔记中搜索一个字符串，返回 路径:行号: 内容。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "要搜索的文字" } },
        required: ["query"],
      },
      readOnly: true,
      execute: async (args) => {
        const query = String(args.query ?? "").trim();
        if (!query) return "搜索词为空。";
        const needle = query.toLowerCase();
        const files = app.vault.getMarkdownFiles().slice(0, MAX_SEARCH_FILES);
        const hits: string[] = [];
        for (const file of files) {
          const content = await app.vault.cachedRead(file);
          const lines = content.split(/\r\n|\r|\n/);
          for (let index = 0; index < lines.length; index += 1) {
            if (lines[index].toLowerCase().includes(needle)) {
              hits.push(`${file.path}:${index + 1}: ${lines[index].trim().slice(0, 160)}`);
              if (hits.length >= MAX_SEARCH_HITS) break;
            }
          }
          if (hits.length >= MAX_SEARCH_HITS) break;
        }
        return hits.length ? hits.join("\n") : "没有找到匹配的内容。";
      },
    },
    {
      name: "vault.read",
      description: "读取一篇 Markdown 笔记的内容，可选指定起止行。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "库内相对路径" },
          fromLine: { type: "integer", description: "起始行（从 1 开始，可选）" },
          toLine: { type: "integer", description: "结束行（含，可选）" },
        },
        required: ["path"],
      },
      readOnly: true,
      execute: async (args) => {
        const path = String(args.path ?? "");
        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return `找不到笔记：${path}`;
        const content = await app.vault.cachedRead(file);
        const from = typeof args.fromLine === "number" ? Math.max(1, Math.floor(args.fromLine)) : 1;
        const to = typeof args.toLine === "number" ? Math.floor(args.toLine) : Number.POSITIVE_INFINITY;
        const lines = content.split(/\r\n|\r|\n/);
        return lines.slice(from - 1, Number.isFinite(to) ? to : undefined).map((line, index) => `${from + index}| ${line}`).join("\n");
      },
    },
    {
      name: "vault.list",
      description: "列出库里的 Markdown 文件路径，可按文件夹前缀过滤。",
      parameters: {
        type: "object",
        properties: { folder: { type: "string", description: "可选的文件夹前缀" } },
      },
      readOnly: true,
      execute: async (args) => {
        const folder = String(args.folder ?? "").replace(/\/+$/, "");
        const files = app.vault
          .getMarkdownFiles()
          .filter((file) => !folder || file.path.startsWith(`${folder}/`))
          .slice(0, MAX_LIST_ENTRIES)
          .map((file) => file.path);
        return files.length ? files.join("\n") : "没有匹配的笔记。";
      },
    },
  ];
}