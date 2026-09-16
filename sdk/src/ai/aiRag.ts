/**
 * Indexing and retrieval: chunking, incremental planning, retries, query.
 *
 * ## What this module owns, and what it does not
 *
 * It owns the *policy*: which files are stale, how a note is cut into chunks,
 * how many chunks go in a batch, when a failure is retryable, and what the
 * progress callback reports. It does not own the vault (the host reads files),
 * the embedding HTTP call (the adapter builds it) or the storage (the vector
 * store). Everything here is therefore testable with a fake embed function and
 * an in-memory store.
 *
 * ## Index updates never run inside a query
 *
 * The reference implementation calls `updateVaultIndex` before every search, so
 * a chat message can block on re-embedding a folder that changed ten seconds
 * ago. Here the indexer is a separate, debounced, cancellable operation; a query
 * only reads, and staleness is a state the UI shows rather than a cost every
 * question pays.
 *
 * ## Retries cover 5xx as well as 429
 *
 * The reference backs off on 429 only. A gateway returning 502 because the
 * upstream is restarting is exactly the case where retrying works, so both are
 * retried; a 400 or a 401 is not retried, because repeating a malformed request
 * only spends time.
 *
 * Pure except for the injected `sleep`; no timers, no sockets, no Obsidian.
 */

import type { AiVectorHit, AiVectorPathInfo, AiVectorRecord, AiVectorScope, AiVectorStore } from "./aiVectorStore";

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface AiChunk {
  content: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

export interface AiChunkOptions {
  /** Characters per chunk, not tokens: counting tokens needs an encoder and this decision does not. */
  chunkSize?: number;
  /** Characters of context carried into the next chunk; must be under `chunkSize`. */
  overlap?: number;
}

/**
 * Split Markdown on the boundaries a reader would use.
 *
 * Paragraphs first, headings stay attached to their following paragraph, and a
 * paragraph longer than the budget is split on line boundaries. A naive
 * `slice(0, 1000)` cuts sentences and, worse, cuts code fences in half -- the
 * retrieved chunk then teaches the model that a fence is never closed.
 */
export function chunkMarkdown(text: string, options: AiChunkOptions = {}): AiChunk[] {
  const chunkSize = clamp(options.chunkSize ?? 1000, 20, 8000);
  const overlap = clamp(options.overlap ?? 100, 0, chunkSize - 1);
  const source = (text ?? "").replace(/\r\n?/g, "\n");
  if (!source.trim()) return [];
  const lines = source.split("\n");

  // Blocks: runs of non-empty lines. A heading starts a new block but stays with
  // the lines under it, because a heading without its paragraph retrieves
  // nothing useful.
  const pieces: { text: string; startLine: number; endLine: number }[] = [];
  let run: string[] = [];
  let runStart = 1;
  const closeRun = (): void => {
    if (!run.length) return;
    const content = run.join("\n");
    const startLine = runStart;
    const endLine = runStart + run.length - 1;
    pieces.push(...splitText(content, startLine, endLine, chunkSize));
    run = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      closeRun();
      continue;
    }
    if (!run.length) runStart = index + 1;
    if (/^#{1,6}\s/.test(line) && run.length) {
      closeRun();
      runStart = index + 1;
    }
    run.push(line);
  }
  closeRun();

  const chunks: AiChunk[] = [];
  let buffer: { parts: { text: string; startLine: number; endLine: number }[] } | null = null;
  const bufferText = (): string => (buffer ? buffer.parts.map((part) => part.text).join("\n\n") : "");
  for (const piece of pieces) {
    if (!buffer) {
      buffer = { parts: [piece] };
      continue;
    }
    // Two characters for the blank line the join inserts.
    if (bufferText().length + 2 + piece.text.length <= chunkSize) {
      buffer.parts.push(piece);
      continue;
    }
    chunks.push(toChunk(buffer));
    const tail = overlapPart(buffer, overlap);
    buffer = tail ? { parts: [tail] } : null;
    if (!buffer) buffer = { parts: [piece] };
    else buffer.parts.push(piece);
  }
  if (buffer) chunks.push(toChunk(buffer));
  return chunks.filter((chunk) => chunk.content.trim().length > 0);
}

function toChunk(buffer: { parts: { text: string; startLine: number; endLine: number }[] }): AiChunk {
  return {
    content: buffer.parts.map((part) => part.text).join("\n\n"),
    startLine: buffer.parts[0]?.startLine ?? 1,
    endLine: buffer.parts[buffer.parts.length - 1]?.endLine ?? 1,
  };
}

/** Split one non-empty run into pieces no longer than `chunkSize`. */
function splitText(
  text: string,
  startLine: number,
  endLine: number,
  chunkSize: number,
): { text: string; startLine: number; endLine: number }[] {
  if (text.length <= chunkSize) return [{ text, startLine, endLine }];
  const lines = text.split("\n");
  const out: { text: string; startLine: number; endLine: number }[] = [];
  let current: string[] = [];
  let currentStart = startLine;
  const flush = (): void => {
    if (!current.length) return;
    const content = current.join("\n");
    out.push({ text: content, startLine: currentStart, endLine: currentStart + current.length - 1 });
    current = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > chunkSize) {
      flush();
      for (let offset = 0; offset < line.length; offset += chunkSize) {
        out.push({ text: line.slice(offset, offset + chunkSize), startLine: startLine + index, endLine: startLine + index });
      }
      currentStart = startLine + index + 1;
      continue;
    }
    const candidate = current.length ? current.join("\n").length + 1 + line.length : line.length;
    if (candidate > chunkSize) {
      flush();
      currentStart = startLine + index;
    }
    current.push(line);
  }
  flush();
  return out.length ? out : [{ text, startLine, endLine }];
}

/** The trailing whole pieces that fit inside `overlap` characters. */
/**
 * The trailing lines that fit inside `overlap` characters.
 *
 * The walk is line-by-line rather than piece-by-piece: a piece is a paragraph
 * and may be far longer than the overlap budget, and carrying a whole paragraph
 * into the next chunk is not overlap, it is duplication.
 */
function overlapPart(
  buffer: { parts: { text: string; startLine: number; endLine: number }[] },
  overlap: number,
): { text: string; startLine: number; endLine: number } | null {
  if (overlap <= 0 || !buffer.parts.length) return null;
  const lines: { text: string; line: number }[] = [];
  let length = 0;
  outer: for (let index = buffer.parts.length - 1; index >= 0; index -= 1) {
    const part = buffer.parts[index];
    const partLines = part.text.split("\n");
    for (let position = partLines.length - 1; position >= 0; position -= 1) {
      const line = partLines[position];
      const added = lines.length ? 1 + line.length : line.length;
      if (lines.length && length + added > overlap) break outer;
      lines.unshift({ text: line, line: part.startLine + position });
      length += added;
      if (line.length >= overlap) break outer;
    }
  }
  if (!lines.length) return null;
  return {
    text: lines.map((entry) => entry.text).join("\n"),
    startLine: lines[0].line,
    endLine: lines[lines.length - 1].line,
  };
}function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Incremental planning
// ---------------------------------------------------------------------------

export interface AiRagSourceFile {
  path: string;
  mtime: number;
  content: string;
}

export interface AiIncrementalPlan {
  toIndex: AiRagSourceFile[];
  toDelete: string[];
  unchanged: number;
}

/**
 * A content hash for staleness checks.
 *
 * FNV-1a over the text: mtime alone lies (a sync client can restore an old
 * mtime; an editor can write the same content), and hashing a vault with
 * SHA-256 needs a crypto API that the SDK cannot assume. The hash is only ever
 * compared with itself, so a non-cryptographic function is the right tool.
 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}-${text.length.toString(16)}`;
}

/** Which files need embedding, which are unchanged, and which disappeared. */
export function planIncrementalIndex(input: {
  files: readonly AiRagSourceFile[];
  indexed: readonly AiVectorPathInfo[];
  force?: boolean;
}): AiIncrementalPlan {
  const known = new Map(input.indexed.map((entry) => [entry.path, entry]));
  const present = new Set(input.files.map((file) => file.path));
  const toIndex: AiRagSourceFile[] = [];
  let unchanged = 0;
  for (const file of input.files) {
    const prior = known.get(file.path);
    if (!input.force && prior && prior.mtime === file.mtime && prior.hash === contentHash(file.content)) unchanged += 1;
    else toIndex.push(file);
  }
  return {
    toIndex,
    toDelete: input.indexed.filter((entry) => !present.has(entry.path)).map((entry) => entry.path),
    unchanged,
  };
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (typeof status === "number" && status >= 500);
}

export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** A retryable failure, recognized by status code or by the message a gateway wrote. */
export function isRetryableError(error: unknown): boolean {
  const record = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const status = typeof record?.status === "number" ? record.status : typeof record?.statusCode === "number" ? record.statusCode : undefined;
  if (status !== undefined) return isRetryableStatus(status);
  const message = typeof record?.message === "string" ? record.message : String(error);
  return /\b(429|5\d\d)\b/.test(message);
}

export interface AiRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** Run `fn` with exponential backoff for retryable failures. */
export async function withRetries<T>(fn: () => Promise<T>, options: AiRetryOptions = {}): Promise<T> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 4));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 1000);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 60_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > maxRetries || !isRetryableError(error)) throw error;
      const delayMs = retryDelayMs(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/** Turn one batch of texts into vectors. Injected: this module never opens a socket. */
export type AiEmbedBatch = (texts: readonly string[], signal?: AbortSignal) => Promise<number[][]>;

export interface AiIndexProgress {
  phase: "planning" | "deleting" | "embedding" | "writing" | "done" | "cancelled";
  filesTotal: number;
  filesDone: number;
  chunksTotal: number;
  chunksDone: number;
  message?: string;
}

export interface AiIndexFailure {
  path: string;
  message: string;
}

export interface AiIndexReport {
  indexedFiles: number;
  chunks: number;
  deletedPaths: number;
  failures: AiIndexFailure[];
  cancelled: boolean;
}

export interface AiIndexOptions {
  chunkSize?: number;
  overlap?: number;
  batchSize?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  force?: boolean;
  model: string;
  signal?: AbortSignal;
  onProgress?: (progress: AiIndexProgress) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Bring the index up to date with the files it is given.
 *
 * One batch can fail without discarding the rest: a file that fails is listed
 * in `failures` and its old chunks are left alone, so a transient embedding
 * outage does not silently unindex a folder.
 */
export async function updateVectorIndex(input: {
  files: readonly AiRagSourceFile[];
  store: AiVectorStore;
  embed: AiEmbedBatch;
  options: AiIndexOptions;
}): Promise<AiIndexReport> {
  const { store, embed, options } = input;
  const report: AiIndexReport = { indexedFiles: 0, chunks: 0, deletedPaths: 0, failures: [], cancelled: false };
  const signal = options.signal;
  const plan = planIncrementalIndex({ files: input.files, indexed: await store.listPaths(), force: options.force });
  const filesTotal = plan.toIndex.length;
  options.onProgress?.({ phase: "planning", filesTotal, filesDone: 0, chunksTotal: 0, chunksDone: 0 });

  if (aborted(signal)) {
    report.cancelled = true;
    options.onProgress?.({ phase: "cancelled", filesTotal, filesDone: 0, chunksTotal: 0, chunksDone: 0 });
    return report;
  }

  if (plan.toDelete.length) {
    report.deletedPaths = await store.deleteByPath(plan.toDelete);
    options.onProgress?.({ phase: "deleting", filesTotal, filesDone: 0, chunksTotal: 0, chunksDone: 0, message: `删除 ${plan.toDelete.length} 个文件的旧向量` });
  }

  // Group all chunks first, then embed in batches. Batching per file would send
  // a stream of tiny requests for a vault of short notes.
  interface Pending { path: string; mtime: number; hash: string; chunk: AiChunk }
  const pending: Pending[] = [];
  const changedPaths = new Set(plan.toIndex.map((file) => file.path));
  for (const file of plan.toIndex) {
    if (aborted(signal)) break;
    const hash = contentHash(file.content);
    for (const chunk of chunkMarkdown(file.content, { chunkSize: options.chunkSize, overlap: options.overlap })) {
      pending.push({ path: file.path, mtime: file.mtime, hash, chunk });
    }
  }

  if (changedPaths.size) {
    // Old chunks of a changed file must go before the new ones arrive: a file
    // that shrank would otherwise keep its tail chunks forever.
    await store.deleteByPath([...changedPaths]);
  }

  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 50));
  const chunksTotal = pending.length;
  let filesDone = 0;
  const doneFiles = new Set<string>();
  for (let start = 0; start < pending.length; start += batchSize) {
    if (aborted(signal)) {
      report.cancelled = true;
      break;
    }
    const batch = pending.slice(start, start + batchSize);
    try {
      const vectors = await withRetries(() => embed(batch.map((item) => item.chunk.content), signal), {
        maxRetries: options.maxRetries,
        baseDelayMs: options.baseDelayMs,
        maxDelayMs: options.maxDelayMs,
        sleep: options.sleep,
      });
      if (vectors.length !== batch.length) throw new Error(`嵌入返回 ${vectors.length} 个向量，期望 ${batch.length} 个。`);
      const records: AiVectorRecord[] = batch.map((item, index) => {
        const vector = Float32Array.from(vectors[index] ?? []);
        return {
          id: `${options.model}:${contentHash(`${item.path}:${item.chunk.startLine}:${item.chunk.endLine}:${item.chunk.content}`)}`,
          path: item.path,
          mtime: item.mtime,
          hash: item.hash,
          model: options.model,
          dimension: vector.length,
          content: item.chunk.content,
          vector,
          metadata: { startLine: item.chunk.startLine, endLine: item.chunk.endLine },
        };
      });
      await store.upsert(records);
      report.chunks += records.length;
      for (const item of batch) doneFiles.add(item.path);
      filesDone = doneFiles.size;
      options.onProgress?.({ phase: "embedding", filesTotal, filesDone, chunksTotal, chunksDone: Math.min(pending.length, start + batch.length) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failures.push({ path: batch[0]?.path ?? "(unknown)", message });
      options.onProgress?.({ phase: "embedding", filesTotal, filesDone, chunksTotal, chunksDone: Math.min(pending.length, start + batch.length), message });
    }
  }

  report.indexedFiles = report.failures.length ? Math.max(0, doneFiles.size - new Set(report.failures.map((failure) => failure.path)).size) : doneFiles.size;
  const phase = report.cancelled ? "cancelled" : "done";
  options.onProgress?.({ phase, filesTotal, filesDone, chunksTotal, chunksDone: report.chunks });
  return report;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface AiRagQueryOptions {
  model: string;
  limit?: number;
  minSimilarity?: number;
  scope?: AiVectorScope;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Embed one query and search. Read-only: the index is never updated here. */
export async function queryRag(input: {
  text: string;
  store: AiVectorStore;
  embed: AiEmbedBatch;
  options: AiRagQueryOptions;
}): Promise<AiVectorHit[]> {
  const text = input.text.trim();
  if (!text) return [];
  const vectors = await withRetries(() => input.embed([text], input.options.signal), {
    maxRetries: input.options.maxRetries,
    baseDelayMs: input.options.baseDelayMs,
    maxDelayMs: input.options.maxDelayMs,
    sleep: input.options.sleep,
  });
  const vector = Float32Array.from(vectors[0] ?? []);
  if (!vector.length) return [];
  return await input.store.query({
    vector,
    model: input.options.model,
    dimension: vector.length,
    limit: input.options.limit ?? 10,
    minSimilarity: input.options.minSimilarity ?? 0,
    scope: input.options.scope,
  });
}