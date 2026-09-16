/**
 * The material a run sends, and the budget that decides how much of it goes.
 *
 * The old panels took one selection or one picture; a user who wanted "these
 * three notes and that folder" had to paste them by hand. This module is the
 * pure half of the fix: the view reads the vault and hands over `ContextFile`
 * values, and this module decides -- visibly -- what fits, what is clipped and
 * what is skipped. The decision is a value the panel shows, not a silent rule
 * hidden in a prompt builder.
 *
 * Nothing here touches the vault. That separation is what lets `node --test`
 * assert the budget behaviour without a fake Obsidian.
 */

export interface ContextFile {
  /** Vault-relative path, used as the card's source label. */
  path: string;
  title: string;
  text: string;
}

export type AiContextItem =
  | { kind: "text"; text: string; label?: string }
  | { kind: "selection"; file: string; fromLine: number; toLine: number; text: string; label?: string }
  | { kind: "notes"; files: ContextFile[]; label?: string }
  | { kind: "folder"; path: string; recursive: boolean; files: ContextFile[] }
  | { kind: "image"; paths: string[]; label?: string };

export interface ContextBudget {
  maxFiles: number;
  maxChars: number;
  perFileChars: number;
  maxImages: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxFiles: 30,
  maxChars: 40_000,
  perFileChars: 8_000,
  maxImages: 6,
};

export interface ContextFileReport {
  path: string;
  title: string;
  chars: number;
  truncated: boolean;
  included: boolean;
}

export interface ContextBuildResult {
  /** The text body the prompt builder embeds, already labelled and budgeted. */
  text: string;
  files: ContextFileReport[];
  /** One line per read/skip decision, for the trace panel. */
  notes: string[];
  /** Problems worth showing the user before they spend a request. */
  problems: string[];
  charCount: number;
  fileCount: number;
  imageCount: number;
  sections: { label: string; chars: number }[];
}

/** Read a budget out of a plugin's stored settings, clamped into usable values. */
export function contextBudgetFromSettings(raw: Record<string, unknown>): ContextBudget {
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.floor(value)))
      : fallback;
  };
  return {
    maxFiles: number("aiContextMaxFiles", DEFAULT_CONTEXT_BUDGET.maxFiles, 1, 200),
    maxChars: number("aiContextMaxChars", DEFAULT_CONTEXT_BUDGET.maxChars, 1000, 400_000),
    perFileChars: number("aiContextPerFileChars", DEFAULT_CONTEXT_BUDGET.perFileChars, 200, 200_000),
    maxImages: number("aiMaxImages", DEFAULT_CONTEXT_BUDGET.maxImages, 1, 20),
  };
}

/**
 * Turn the chosen items into one text body plus the report the panel shows.
 *
 * Order is kept: what the user put first is what the model reads first, and when
 * the budget runs out the later items are the ones marked skipped. Every clip
 * says how much was dropped, because "the model ignored my last note" is the
 * failure this report exists to make impossible.
 */
export function buildContextBundle(
  items: readonly AiContextItem[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): ContextBuildResult {
  const result: ContextBuildResult = {
    text: "",
    files: [],
    notes: [],
    problems: [],
    charCount: 0,
    fileCount: 0,
    imageCount: 0,
    sections: [],
  };
  const parts: string[] = [];
  const append = (label: string, section: string): boolean => {
    const chars = section.length;
    if (result.charCount + chars > budget.maxChars) {
      result.problems.push(`「${label}」超出上下文上限（${budget.maxChars} 字），已跳过。`);
      return false;
    }
    parts.push(section);
    result.charCount += chars;
    result.sections.push({ label, chars });
    return true;
  };
  const clip = (text: string, limit: number): { text: string; truncated: boolean } => {
    if (text.length <= limit) return { text, truncated: false };
    return { text: text.slice(0, limit), truncated: true };
  };
  const readFiles = (label: string, files: readonly ContextFile[]): void => {
    for (const file of files) {
      if (result.fileCount >= budget.maxFiles) {
        result.notes.push(`跳过 ${file.path}：已达到 ${budget.maxFiles} 篇文件上限。`);
        result.problems.push(`超过 ${budget.maxFiles} 篇文件上限，后面的笔记没有发送。`);
        result.files.push({ path: file.path, title: file.title, chars: 0, truncated: false, included: false });
        continue;
      }
      const clipped = clip(file.text, budget.perFileChars);
      const section =
        `### 笔记：${file.title}\n路径：${file.path}\n` +
        (clipped.truncated ? `（这篇只发送了前 ${budget.perFileChars} 字）\n` : "") +
        `${clipped.text}`;
      const included = append(file.title, section);
      result.files.push({
        path: file.path,
        title: file.title,
        chars: clipped.text.length,
        truncated: clipped.truncated,
        included,
      });
      if (included) {
        result.fileCount += 1;
        if (clipped.truncated) result.notes.push(`${file.path}：已截断到 ${budget.perFileChars} 字。`);
      } else {
        result.notes.push(`${file.path}：因总字数上限没有发送。`);
      }
    }
    result.notes.push(`${label}：发送 ${result.files.filter((entry) => entry.included).length} 篇笔记。`);
  };

  for (const item of items) {
    if (item.kind === "text") {
      append(item.label ?? "手打文本", `${item.text.trim()}`);
      continue;
    }
    if (item.kind === "selection") {
      append(
        item.label ?? `选区 ${item.file}`,
        `### 选区：${item.file}（第 ${item.fromLine + 1} 行起）\n${item.text.trim()}`,
      );
      continue;
    }
    if (item.kind === "notes") {
      readFiles(item.label ?? "笔记", item.files);
      continue;
    }
    if (item.kind === "folder") {
      result.notes.push(`文件夹 ${item.path}${item.recursive ? "（含子目录）" : ""}：${item.files.length} 篇。`);
      readFiles(`文件夹 ${item.path}`, item.files);
      continue;
    }
    // image
    result.imageCount += item.paths.length;
    if (result.imageCount > budget.maxImages) {
      const over = result.imageCount - budget.maxImages;
      result.imageCount = budget.maxImages;
      result.problems.push(`图片超过 ${budget.maxImages} 张上限，最后 ${over} 张不会发送。`);
    }
    result.notes.push(`图片 ${item.paths.length} 张。`);
  }

  result.text = parts.join("\n\n---\n\n");
  return result;
}

/** The one-line count the panel puts above the file list. */
export function contextSummaryLine(result: ContextBuildResult): string {
  const pieces = [`${result.fileCount} 篇笔记`, `${result.charCount} 字`];
  if (result.imageCount) pieces.push(`${result.imageCount} 张图片`);
  return pieces.join(" · ");
}