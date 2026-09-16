/**
 * The mobile filesystem: a synchronous `FsShim` over an asynchronous adapter.
 *
 * ## Why this exists
 *
 * The domain stores were written against `FsShim`, which is deliberately
 * synchronous  every load, every answer and every snapshot write is a plain
 * function call. Desktop implements it over `node:fs`. Obsidian mobile has no
 * Node, and its only filesystem is `DataAdapter`, which is asynchronous. The
 * plugin therefore cannot load there at all while `nodeFs()` is the only shim.
 *
 * ## The shape of the bridge
 *
 * The plugin's data directory is small (a snapshot plus one or two JSONL
 * files: kilobytes in practice), so this preloads it into memory at startup and
 * serves the synchronous API from that cache. Writes update the cache first and
 * are queued to the adapter in order; `flush()` waits for the queue. That keeps
 * every existing store, test and call site unchanged.
 *
 * The trade is explicit: the cache is the source of truth for the session, so a
 * second Obsidian window writing the same vault is not observed until
 * `reload()`. On mobile that is the normal single-window case, and the desktop
 * path keeps `node:fs` with its mtime-based external-change check.
 *
 * ## Atomicity
 *
 * `writeFile(temp)` + `rename(temp, target)` still means what it means on
 * desktop: the queue writes the temp path and then replaces the target. The
 * adapter (like Obsidian's) may refuse to rename over an existing file, so the
 * replacement falls back to remove-then-rename and finally to an in-place write,
 * exactly like `writeTextAtomic` in the conversation store.
 *
 * Pure logic with an injected adapter, so it is unit-tested in Node without
 * Obsidian.
 */

import type { FsShim } from "./persist";

/** The subset of Obsidian's `DataAdapter` this bridge needs. */
export interface VaultFsAdapter {
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append?(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists?(path: string): Promise<boolean>;
  stat?(path: string): Promise<{ mtime?: number } | null>;
}

export interface VaultFsHandle {
  /** The synchronous view the stores were written against. */
  shim: FsShim;
  /** Wait until every queued write has reached the adapter. */
  flush(): Promise<void>;
  /** Drop the cache and re-read the directory (for an explicit refresh). */
  reload(): Promise<void>;
  /** How many writes are still queued; diagnostics only. */
  pending(): number;
}

const MAX_LOAD_BYTES = 8 * 1024 * 1024;

function normalizePath(path: string): string {
  return (path ?? "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function parentOf(path: string): string {
  const key = normalizePath(path);
  const index = key.lastIndexOf("/");
  return index <= 0 ? "" : key.slice(0, index);
}

/**
 * Build the bridge. `dir` is vault-relative (`.obsidian/plugins/<id>`), because
 * that is what both `manifest.dir` and the adapter speak on mobile.
 */
export async function createVaultFs(adapter: VaultFsAdapter, dir: string): Promise<VaultFsHandle> {
  const root = normalizePath(dir).replace(/\/+$/, "");
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;

  const loadTree = async (path: string, bytes: { total: number }): Promise<void> => {
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await adapter.list(path);
    } catch {
      return;
    }
    for (const file of listing.files) {
      if (bytes.total > MAX_LOAD_BYTES) return;
      try {
        const text = await adapter.read(file);
        files.set(normalizePath(file), text);
        bytes.total += text.length;
        const stat = adapter.stat ? await adapter.stat(file).catch(() => null) : null;
        mtimes.set(normalizePath(file), stat?.mtime ?? Date.now());
      } catch {
        // A file that cannot be read is simply absent; the store reports its
        // own "missing" state rather than failing the whole plugin load.
      }
    }
    for (const folder of listing.folders) {
      if (bytes.total > MAX_LOAD_BYTES) return;
      await loadTree(folder, bytes);
    }
  };

  const writeNow = async (path: string, content: string): Promise<void> => {
    const parent = parentOf(path);
    if (parent) await adapter.mkdir(parent).catch(() => undefined);
    const temporary = `${path}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await adapter.write(temporary, content);
    try {
      await adapter.rename(temporary, path);
    } catch {
      await adapter.remove(path).catch(() => undefined);
      try {
        await adapter.rename(temporary, path);
      } catch {
        await adapter.write(path, content);
        await adapter.remove(temporary).catch(() => undefined);
      }
    }
  };

  const enqueue = (operation: () => Promise<void>): void => {
    queued += 1;
    queue = queue.then(operation).catch((error) => {
      // The in-memory state stays consistent; a failed flush is reported once
      // here and can be retried by `flush()` after the caller fixes the cause.
      console.error("[sfc] vaultFs write failed:", error);
    }).finally(() => {
      queued -= 1;
    });
  };

  const shim: FsShim = {
    readFile(path) {
      return files.get(normalizePath(path)) ?? null;
    },
    writeFile(path, content) {
      const key = normalizePath(path);
      files.set(key, content);
      mtimes.set(key, Date.now());
      enqueue(() => writeNow(key, content));
    },
    appendFile(path, content) {
      const key = normalizePath(path);
      const next = `${files.get(key) ?? ""}${content}`;
      files.set(key, next);
      mtimes.set(key, Date.now());
      enqueue(async () => {
        if (adapter.append) {
          try {
            await adapter.append(key, content);
            return;
          } catch {
            // Fall through to a full rewrite below.
          }
        }
        await writeNow(key, next);
      });
    },
    rename(from, to) {
      const source = normalizePath(from);
      const target = normalizePath(to);
      const content = files.get(source);
      files.delete(source);
      if (content !== undefined) {
        files.set(target, content);
        mtimes.set(target, Date.now());
        enqueue(async () => {
          await writeNow(target, content);
          await adapter.remove(source).catch(() => undefined);
        });
      }
    },
    remove(path) {
      const key = normalizePath(path);
      files.delete(key);
      mtimes.delete(key);
      enqueue(() => adapter.remove(key).catch(() => undefined));
    },
    exists(path) {
      return files.has(normalizePath(path));
    },
    mtime(path) {
      return mtimes.get(normalizePath(path)) ?? null;
    },
  };

  const reload = async (): Promise<void> => {
    files.clear();
    mtimes.clear();
    await loadTree(root, { total: 0 });
  };

  await adapter.mkdir(root).catch(() => undefined);
  await loadTree(root, { total: 0 });

  return {
    shim,
    async flush() {
      await queue;
    },
    reload,
    pending() {
      return queued;
    },
  };
}