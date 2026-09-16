/**
 * Durable local storage without a database.
 *
 * Two files per plugin, chosen for their failure modes rather than their
 * elegance:
 *
 * * **snapshot JSON** (``data.json``) holds the objects that are read as a
 *   whole -- settings, card state, todos. Written atomically: the new content
 *   goes to a sibling temp file, is flushed, and is then renamed over the
 *   target. A crash at any point leaves either the old file or the new one
 *   intact, never a truncated one.
 * * **append-only JSONL** (``reviews.jsonl``, ``todos.jsonl``) holds history.
 *   Appending is O(1) instead of O(file), and a crash can only lose the last
 *   line, which the reader already tolerates because it skips unparseable
 *   lines rather than throwing.
 *
 * The filesystem is injected rather than imported, so this module stays free of
 * Node types and can be unit tested with an in-memory stub.
 */

export interface FsShim {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  appendFile(path: string, content: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
  /** Last-write time in ms, used to detect a second window writing the file. */
  mtime(path: string): number | null;
}

export type ReadOutcome<T> =
  | { kind: "missing"; data: null }
  | { kind: "ok"; data: T }
  /** The file exists but could not be parsed; it was backed up, not lost. */
  | { kind: "corrupt"; data: null; backup: string; error: string };

/**
 * Read a snapshot. A corrupt file is **never** overwritten silently: it is
 * moved aside to ``<name>.corrupt-<timestamp>`` first, so a user with a
 * half-written file keeps their data and gets told where it went.
 */
export function readSnapshot<T>(fs: FsShim, path: string): ReadOutcome<T> {
  if (!fs.exists(path)) return { kind: "missing", data: null };
  const raw = fs.readFile(path);
  if (raw === null || raw.trim() === "") return { kind: "missing", data: null };
  try {
    const parsed = JSON.parse(raw) as T;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("snapshot is not an object");
    }
    return { kind: "ok", data: parsed };
  } catch (error) {
    const backup = `${path}.corrupt-${timestampSlug()}`;
    try {
      fs.writeFile(backup, raw);
      fs.remove(path);
    } catch {
      // If even the backup fails, report the original problem and leave the
      // file where it is; destroying it would be strictly worse.
      return {
        kind: "corrupt",
        data: null,
        backup: "",
        error: describe(error),
      };
    }
    return { kind: "corrupt", data: null, backup, error: describe(error) };
  }
}

/** Write a snapshot atomically. */
export function writeSnapshot(fs: FsShim, path: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2);
  const temp = `${path}.tmp`;
  fs.writeFile(temp, content);
  fs.rename(temp, path);
}

/** Append one record. The caller supplies the newline. */
export function appendRecord(fs: FsShim, path: string, record: unknown): void {
  fs.appendFile(path, `${JSON.stringify(record)}\n`);
}

/**
 * Read a JSONL file, skipping lines that cannot be parsed.
 *
 * Skipping rather than throwing is the whole point of the format: a process
 * killed mid-append leaves one partial line, and losing it must not cost the
 * user their entire history.
 */
export function readLines<T>(fs: FsShim, path: string, options: { dedupeBy?: keyof T } = {}): T[] {
  const raw = fs.readFile(path);
  if (!raw) return [];
  const out: T[] = [];
  const seen = new Set<unknown>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: T;
    try {
      parsed = JSON.parse(trimmed) as T;
    } catch {
      continue;
    }
    if (options.dedupeBy) {
      const key = (parsed as Record<string, unknown>)[options.dedupeBy as string];
      if (key !== undefined) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
    }
    out.push(parsed);
  }
  return out;
}

/**
 * Serialise writes so a burst of answers costs one file write instead of one
 * per answer, while an explicit ``flush`` still lands immediately.
 */
export class DebouncedWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly write: () => void,
    private readonly delayMs = 400,
  ) {}

  schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.write();
  }

  get pending(): boolean {
    return this.dirty;
  }
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}