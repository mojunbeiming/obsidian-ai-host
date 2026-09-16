/**
 * The vault side of context: reading mentions, listing picker candidates, apply.
 *
 * Everything here is Obsidian API and stays out of `node --test`; the parts with
 * decisions (what a mention compiles to, how many lines a block covers) are
 * delegated to the SDK helpers, so this file is a thin, readable adapter.
 */

import { App, MarkdownView, TFile } from "obsidian";
import type { AiMention, AiResolvedMention } from "../sdk/src/ai/aiChat";
import { mentionLabel, normalizeMention } from "../sdk/src/ai/aiChat";

/** Read one mention into the shape `compileUserMessage` consumes. */
export async function resolveMention(app: App, mention: AiMention): Promise<AiResolvedMention> {
  const label = mentionLabel(mention);
  try {
    switch (mention.type) {
      case "file":
        return { mention, label, text: await readFileRange(app, mention.path ?? "", mention.fromLine, mention.toLine) };
      case "current-file": {
        const file = app.workspace.getActiveFile();
        if (!file) return { mention, label, error: "当前没有打开的笔记。" };
        return { mention, label, text: await readFileRange(app, file.path, mention.fromLine, mention.toLine) };
      }
      case "block": {
        const text = await readBlock(app, mention.path ?? "", mention.block ?? "");
        return text ? { mention, label, text } : { mention, label, error: "没有找到这个块或标题。" };
      }
      case "folder": {
        const files = listMarkdownFiles(app, mention.path ?? "");
        if (!files.length) return { mention, label, error: "这个文件夹里没有 Markdown 笔记。" };
        const parts: string[] = [];
        const limit = Math.min(files.length, 12);
        for (const file of files.slice(0, limit)) {
          const content = await app.vault.cachedRead(file);
          parts.push(`--- ${file.path} ---\n${content}`);
        }
        if (files.length > limit) parts.unshift(`（文件夹共 ${files.length} 篇，只读取了前 ${limit} 篇）`);
        return { mention, label, text: parts.join("\n\n") };
      }
      case "vault":
        return { mention, label, text: "" };
      case "image": {
        if (mention.base64 && mention.mediaType) {
          return { mention, label, image: { type: "image", mediaType: mention.mediaType, base64: mention.base64, name: label } };
        }
        if (!mention.path) return { mention, label, error: "图片缺少路径。" };
        const file = app.vault.getAbstractFileByPath(mention.path);
        if (!(file instanceof TFile)) return { mention, label, error: `找不到图片：${mention.path}` };
        const bytes = new Uint8Array(await app.vault.readBinary(file));
        return {
          mention,
          label,
          image: { type: "image", mediaType: mediaTypeFor(file.extension), base64: base64FromBytes(bytes), name: file.name },
        };
      }
      case "url":
        return { mention, label, error: "URL 提及需要联网抓取，当前版本未开启。" };
      default:
        return { mention, label, error: "不支持的提及类型。" };
    }
  } catch (error) {
    return { mention, label, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readFileRange(app: App, path: string, fromLine?: number, toLine?: number): Promise<string> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`找不到笔记：${path}`);
  const content = await app.vault.cachedRead(file);
  if (!fromLine) return content;
  const lines = content.split(/\r\n|\r|\n/);
  const end = toLine && toLine >= fromLine ? toLine : fromLine;
  return lines.slice(fromLine - 1, end).join("\n");
}

/** A heading section (`# 标题`) or a block id (`^id`). */
async function readBlock(app: App, path: string, block: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return "";
  const content = await app.vault.cachedRead(file);
  const lines = content.split(/\r\n|\r|\n/);
  if (!block) return content;
  if (block.startsWith("^")) {
    const id = block.slice(1).trim();
    const end = lines.findIndex((line) => new RegExp(`\\^${escapeRegExp(id)}\\s*$`).test(line));
    if (end < 0) return "";
    let start = end;
    while (start > 0 && !lines[start - 1].trim()) start -= 1;
    while (start > 0 && !/^\s*$/.test(lines[start - 1]) && !/^#{1,6}\s/.test(lines[start - 1])) start -= 1;
    return lines.slice(start, end + 1).join("\n");
  }
  const wanted = block.replace(/^#+\s*/, "").trim().toLowerCase();
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.replace(/^#+\s*/, "").trim().toLowerCase() === wanted);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Markdown files under a folder, or under the whole vault for an empty path. */
export function listMarkdownFiles(app: App, folder: string): TFile[] {
  const prefix = folder ? `${folder.replace(/\/+$/, "")}/` : "";
  return app.vault
    .getMarkdownFiles()
    .filter((file) => file.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface MentionCandidate {
  path: string;
  name: string;
  kind: "file" | "folder" | "image";
}

/** Candidates for the @ picker: files whose path contains the query. */
/**
 * A cached file/folder index for the @ picker.
 *
 * The old lookup walked every file and derived every parent folder on every
 * keystroke; on a large vault that is enough work to make typing feel dead.
 * The index is built once, invalidated by vault events, and searched with a
 * simple substring filter.
 */
export class MentionIndex {
  private files: MentionCandidate[] = [];
  private folders: MentionCandidate[] = [];
  private built = false;

  constructor(private readonly app: App) {}

  invalidate(): void {
    this.built = false;
  }

  search(query: string, limit = 20): MentionCandidate[] {
    if (!this.built) this.rebuild();
    const needle = query.trim().toLowerCase();
    const out: MentionCandidate[] = [];
    for (const candidate of this.files) {
      if (needle && !candidate.path.toLowerCase().includes(needle)) continue;
      out.push(candidate);
      if (out.length >= limit) return out;
    }
    for (const candidate of this.folders) {
      if (needle && !candidate.path.toLowerCase().includes(needle)) continue;
      out.push(candidate);
      if (out.length >= limit) break;
    }
    return out;
  }

  private rebuild(): void {
    this.built = true;
    this.files = [];
    const folders = new Set<string>();
    for (const file of this.app.vault.getFiles()) {
      const markdown = /\.md$/i.test(file.path);
      const image = /\.(png|jpe?g|webp|gif)$/i.test(file.path);
      if (markdown || image) {
        this.files.push({ path: file.path, name: file.name, kind: markdown ? "file" : "image" });
      }
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
    }
    this.folders = [...folders].sort().map((folder) => ({ path: folder, name: folder + "/", kind: "folder" as const }));
  }
}

/** Direct lookup for callers with no index (small vaults / tests). */
export function mentionCandidates(app: App, query: string, limit = 20, index?: MentionIndex): MentionCandidate[] {
  return index ? index.search(query, limit) : new MentionIndex(app).search(query, limit);
}

export function mentionFromCandidate(candidate: MentionCandidate): AiMention | null {
  if (candidate.kind === "file") return normalizeMention({ type: "file", path: candidate.path });
  if (candidate.kind === "image") return normalizeMention({ type: "image", path: candidate.path });
  return normalizeMention({ type: "folder", path: candidate.path });
}

/** The active note, as the current-file context (or null). */
export async function currentFileContext(app: App): Promise<{ path: string; content: string } | null> {
  const file = app.workspace.getActiveFile();
  if (!file) return null;
  return { path: file.path, content: await app.vault.cachedRead(file) };
}

/** A selection in the active editor, as a block mention with an exact range. */
export function selectionMention(app: App): AiMention | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view || !view.file) return null;
  const editor = view.editor;
  if (!editor.somethingSelected()) return null;
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  return normalizeMention({
    type: "block",
    path: view.file.path,
    fromLine: from.line + 1,
    toLine: to.line + 1,
    block: "",
  });
}

function mediaTypeFor(extension: string): string {
  const lower = extension.toLowerCase();
  if (lower === "jpg" || lower === "jpeg") return "image/jpeg";
  if (lower === "webp") return "image/webp";
  if (lower === "gif") return "image/gif";
  return "image/png";
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}