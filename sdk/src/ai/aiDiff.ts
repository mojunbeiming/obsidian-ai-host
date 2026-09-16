/**
 * A line-level diff, small enough to read and exact enough to trust.
 *
 * The reference implementation pulls in `vscode-diff` for this. A whole editor's
 * dependency for one algorithm is the trade this project keeps refusing: the
 * LCS table below is thirty lines, has no runtime dependencies, and its output
 * shape is the one the apply UI needs -- runs of unchanged lines and pairs of
 * removed/added lines.
 *
 * Files large enough to make the O(n*m) table expensive fall back to one
 * modified block, which is honest: the user sees "this file differs" and accepts
 * or cancels it, instead of the page hanging.
 */

export type AiDiffBlock =
  | { type: "unchanged"; value: string }
  | { type: "modified"; originalValue?: string; modifiedValue?: string };

export interface AiDiffResult {
  blocks: AiDiffBlock[];
  /** True when the table was skipped for size; the single block is all-or-nothing. */
  coarse: boolean;
}

export function diffLines(original: string, modified: string): AiDiffResult {
  const left = splitLines(original);
  const right = splitLines(modified);
  if (left.join("\n") === right.join("\n")) {
    return { blocks: original ? [{ type: "unchanged", value: original }] : [], coarse: false };
  }
  if (left.length * right.length > 4_000_000) {
    return {
      blocks: [
        {
          type: "modified",
          ...(original ? { originalValue: original } : {}),
          ...(modified ? { modifiedValue: modified } : {}),
        },
      ],
      coarse: true,
    };
  }
  const table = lcsTable(left, right);
  const blocks: AiDiffBlock[] = [];
  let positionLeft = 0;
  let positionRight = 0;
  let pendingOriginal: string[] = [];
  let pendingModified: string[] = [];
  const flush = (): void => {
    if (!pendingOriginal.length && !pendingModified.length) return;
    blocks.push({
      type: "modified",
      ...(pendingOriginal.length ? { originalValue: pendingOriginal.join("\n") } : {}),
      ...(pendingModified.length ? { modifiedValue: pendingModified.join("\n") } : {}),
    });
    pendingOriginal = [];
    pendingModified = [];
  };

  const pushUnchanged = (count: number): void => {
    if (count <= 0) return;
    flush();
    // Slice by the walk position, not by a separate counter: a counter that is
    // only advanced here goes stale as soon as a differing line is consumed, and
    // the next unchanged block repeats an already-emitted line.
    const lines = left.slice(positionLeft, positionLeft + count);
    blocks.push({ type: "unchanged", value: lines.join("\n") });
    positionLeft += count;
    positionRight += count;
  };

  while (positionLeft < left.length && positionRight < right.length) {
    if (left[positionLeft] === right[positionRight]) {
      pushUnchanged(1);
      continue;
    }
    if (table[positionLeft + 1][positionRight] >= table[positionLeft][positionRight + 1]) {
      pendingOriginal.push(left[positionLeft]);
      positionLeft += 1;
    } else {
      pendingModified.push(right[positionRight]);
      positionRight += 1;
    }
  }
  while (positionLeft < left.length) {
    pendingOriginal.push(left[positionLeft]);
    positionLeft += 1;
  }
  while (positionRight < right.length) {
    pendingModified.push(right[positionRight]);
    positionRight += 1;
  }
  flush();
  return { blocks, coarse: false };
}

/** Join the blocks back into a file, choosing one side per modified block. */
export function applyDiffBlocks(
  original: string,
  blocks: readonly AiDiffBlock[],
  accept: (block: AiDiffBlock, index: number) => "current" | "incoming" | "both",
): string {
  const trailingNewline = original.endsWith("\n");
  const out: string[] = [];
  blocks.forEach((block, index) => {
    if (block.type === "unchanged") {
      out.push(block.value);
      return;
    }
    const choice = accept(block, index);
    if (choice === "current" || choice === "both") if (block.originalValue !== undefined) out.push(block.originalValue);
    if (choice === "incoming" || choice === "both") if (block.modifiedValue !== undefined) out.push(block.modifiedValue);
  });
  const text = out.filter((part) => part.length > 0).join("\n");
  return trailingNewline && text && !text.endsWith("\n") ? `${text}\n` : text;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function lcsTable(left: readonly string[], right: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}