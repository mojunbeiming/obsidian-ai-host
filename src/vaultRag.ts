/**
 * The vault RAG service: collect notes, index incrementally, query.
 *
 * The service owns the debounce timer and the vector files; the pure policy
 * (what is stale, how to chunk, when to retry) lives in the SDK's `aiRag`. Files
 * live under the plugin's own directory, so deleting the plugin removes the
 * index and never a note.
 */

import { App, normalizePath, type DataAdapter } from "obsidian";
import { isPathIncluded } from "../sdk/src/ai/aiGlob";
import {
  queryRag,
  updateVectorIndex,
  type AiEmbedBatch,
  type AiIndexProgress,
  type AiIndexReport,
  type AiRagSourceFile,
} from "../sdk/src/ai/aiRag";
import { createAiVectorStore, type AiIndexStats, type AiVectorFs, type AiVectorHit, type AiVectorScope } from "../sdk/src/ai/aiVectorStore";
import type { AiSettings } from "../sdk/src/ai/aiSettingsSchema";

/** The vector filesystem over Obsidian's adapter. Binary, unlike the conversation store's. */
export function createVaultVectorFs(adapter: DataAdapter, root: string): AiVectorFs {
  const prefix = (path: string): string => normalizePath(root ? `${root}/${path}` : path);
  return {
    async mkdir(dir) {
      try {
        await adapter.mkdir(prefix(dir));
      } catch {
        // already exists
      }
    },
    async readText(path) {
      try {
        return await adapter.read(prefix(path));
      } catch {
        return null;
      }
    },
    async writeText(path, text) {
      await adapter.write(prefix(path), text);
    },
    async readBinary(path) {
      try {
        return new Uint8Array(await adapter.readBinary(prefix(path)));
      } catch {
        return null;
      }
    },
    async writeBinary(path, data) {
      const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      await adapter.writeBinary(prefix(path), copy);
    },
    async rename(from, to) {
      await adapter.rename(prefix(from), prefix(to));
    },
    async remove(path) {
      try {
        await adapter.remove(prefix(path));
      } catch {
        // already gone
      }
    },
    async rmdir(dir) {
      try {
        await adapter.rmdir(prefix(dir), true);
      } catch {
        // already gone
      }
    },
    async list(dir) {
      try {
        const listed = await adapter.list(prefix(dir));
        return listed.files.map((path) => path.slice(path.lastIndexOf("/") + 1));
      } catch {
        return [];
      }
    },
  };
}

export interface RagServiceOptions {
  app: App;
  settings(): AiSettings;
  embed(): AiEmbedBatch;
  /** The model key used for filtering; must be the same string for writes and reads. */
  modelKey(): string;
  onProgress?(progress: AiIndexProgress): void;
}

export class RagService {
  private readonly store;
  private timer: number | null = null;
  private lastReport: AiIndexReport | null = null;

  constructor(private readonly options: RagServiceOptions, root: string) {
    this.store = createAiVectorStore(createVaultVectorFs(options.app.vault.adapter, root), { dir: "vector" });
  }

  /** Read the notes the settings say are in scope. */
  async collectFiles(): Promise<AiRagSourceFile[]> {
    const rag = this.options.settings().rag;
    const include = rag.includeGlobs;
    const exclude = rag.excludeGlobs;
    const out: AiRagSourceFile[] = [];
    for (const file of this.options.app.vault.getMarkdownFiles()) {
      if (!isPathIncluded(file.path, { include, exclude })) continue;
      try {
        out.push({ path: file.path, mtime: file.stat.mtime, content: await this.options.app.vault.cachedRead(file) });
      } catch {
        // A file that disappeared mid-scan is simply not indexed.
      }
    }
    return out;
  }

  async update(force = false, signal?: AbortSignal): Promise<AiIndexReport> {
    const rag = this.options.settings().rag;
    const files = await this.collectFiles();
    const report = await updateVectorIndex({
      files,
      store: this.store,
      embed: this.options.embed(),
      options: {
        model: this.options.modelKey(),
        chunkSize: rag.chunkSize,
        overlap: rag.chunkOverlap,
        batchSize: rag.batchSize,
        force,
        signal,
        onProgress: this.options.onProgress,
      },
    });
    this.lastReport = report;
    return report;
  }

  async rebuild(signal?: AbortSignal): Promise<AiIndexReport> {
    await this.store.clear();
    return await this.update(true, signal);
  }

  async clear(): Promise<void> {
    await this.store.clear();
    this.lastReport = null;
  }

  async stats(): Promise<AiIndexStats> {
    return await this.store.stats();
  }

  async query(
    text: string,
    options: { scope?: AiVectorScope; limit?: number; minSimilarity?: number; signal?: AbortSignal } = {},
  ): Promise<AiVectorHit[]> {
    const rag = this.options.settings().rag;
    return await queryRag({
      text,
      store: this.store,
      embed: this.options.embed(),
      options: {
        model: this.options.modelKey(),
        limit: options.limit ?? rag.limit,
        minSimilarity: options.minSimilarity ?? rag.minSimilarity,
        scope: options.scope,
        signal: options.signal,
      },
    });
  }

  /** Debounced background update, driven by vault events in `main.ts`. */
  schedule(): void {
    const delay = this.options.settings().rag.debounceMs;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.update(false).catch((error) => console.warn("[sfc-ai] 后台索引失败：", error));
    }, delay);
  }

  cancelScheduled(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  last(): AiIndexReport | null {
    return this.lastReport;
  }
}