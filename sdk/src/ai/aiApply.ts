/**
 * The apply prompt and session: whole-file rewrite, cleaned, never written here.
 *
 * The model is asked for the whole file rather than a patch because a patch
 * needs a format contract, a parser and a failure mode for a bad hunk, while a
 * whole file needs only a diff. The response is cleaned of code fences because
 * models add them regardless of instructions -- refusing that reply would refuse
 * the common case.
 *
 * `createApplySession` computes the diff immediately: the session is what the
 * UI renders, and the user's per-block choices never touch the disk. Writing is
 * the host's job, after every block has an answer.
 */

import type { AiChatMessage } from "./aiChat";
import type { AiDiffBlock } from "./aiDiff";
import { diffLines } from "./aiDiff";

export const AI_APPLY_SYSTEM_PROMPT = [
  "你是一个文件重写器。只输出应用了用户要求之后的**完整文件内容**。",
  "保留与要求无关的所有内容，不要解释，不要总结，不要用 Markdown 代码围栏包裹整份文件。",
  "如果要求只涉及某个片段，其余部分必须逐字节保持原样。",
].join("\n");

export interface AiApplyInput {
  file: string;
  originalContent: string;
  instruction: string;
  /** Recent conversation, so "把上面那句改短" has a referent. */
  history?: readonly AiChatMessage[];
  /** When set, only this slice is the subject; it is included verbatim. */
  block?: { fromLine: number; toLine: number; content: string };
  maxContextMessages?: number;
}

export function buildApplyMessages(input: AiApplyInput): AiChatMessage[] {
  const lines: string[] = [];
  lines.push(`目标文件：${input.file}`);
  lines.push("");
  lines.push("## 当前完整内容");
  lines.push("```");
  lines.push(input.originalContent);
  lines.push("```");
  if (input.block) {
    lines.push("");
    lines.push(`## 只修改这一段（第 ${input.block.fromLine}-${input.block.toLine} 行）`);
    lines.push("```");
    lines.push(input.block.content);
    lines.push("```");
  }
  lines.push("");
  lines.push("## 要求");
  lines.push(input.instruction);
  const history = (input.history ?? []).slice(-Math.max(0, input.maxContextMessages ?? 10));
  return [{ role: "system", content: AI_APPLY_SYSTEM_PROMPT }, ...history, { role: "user", content: lines.join("\n") }];
}

/**
 * Remove a wrapping code fence, and only a wrapping one.
 *
 * A file that legitimately starts with a fence (a Markdown document *about*
 * Markdown) must not lose its first line, so the fence is stripped only when it
 * is the first line, has a matching closer, and the closer is the last
 * non-empty line.
 */
export function stripCodeFences(text: string): string {
  const source = text.replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start += 1;
  let end = lines.length - 1;
  while (end > start && !lines[end].trim()) end -= 1;
  if (start >= end) return source;
  if (!/^\s*```/.test(lines[start]) || !/^\s*```\s*$/.test(lines[end])) return source;
  return lines.slice(start + 1, end).join("\n");
}

export interface AiApplySession {
  file: string;
  originalContent: string;
  incomingContent: string;
  blocks: AiDiffBlock[];
  createdAt: number;
  /** True when the diff was too large for an exact line table. */
  coarse: boolean;
}

export function createApplySession(input: {
  file: string;
  originalContent: string;
  incomingContent: string;
  now?: () => number;
}): AiApplySession {
  const incoming = stripCodeFences(input.incomingContent);
  const result = diffLines(input.originalContent, incoming);
  return {
    file: input.file,
    originalContent: input.originalContent,
    incomingContent: incoming,
    blocks: result.blocks,
    createdAt: input.now?.() ?? Date.now(),
    coarse: result.coarse,
  };
}

/** How many blocks actually change something. */
export function changedBlockCount(session: AiApplySession): number {
  return session.blocks.filter((block) => block.type === "modified").length;
}