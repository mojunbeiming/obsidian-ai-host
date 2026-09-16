/**
 * The backup store: one JSON file per write, batched by agent run.
 *
 * Two callers, one folder. The Apply flow has always written
 * `{path, original, createdAt}` and offered "撤销上次 AI 写入"; the agent needs
 * the same data plus a `batchId`, hashes and a tool name, so that the delivery
 * summary can offer "撤销本次全部写入" without restoring a file twice. The
 * record here is a superset of the old shape, and `undoLastWrite` reads both --
 * an upgrade must not orphan yesterday's backups.
 *
 * The filesystem is the SDK's injected `AiStoreFs` (the plugin passes its vault
 * adapter), so the undo decision is the tested `planUndo` and this class is just
 * the I/O around it. Vault reads/writes/removes come from `BackupTarget`, since
 * deleting a note must go through the vault (and its trash), not the adapter.
 */

import {
  createWriteAudit,
  matchesAfterHash,
  planUndo,
  type AiUndoPlan,
  type AiWriteAudit,
} from "../sdk/src/ai/aiAudit";
import type { AiStoreFs } from "../sdk/src/ai/aiConversationStore";

export const BACKUP_SCHEMA = 1;

export interface BackupRecord {
  schema: number;
  id: string;
  batchId: string;
  runId?: string;
  tool: string;
  path: string;
  /** The full previous content; empty when the file did not exist. */
  original: string;
  created: boolean;
  at: number;
  beforeHash: string;
  afterHash: string;
}

/** The vault side of an undo; implemented over `app.vault` by the plugin. */
export interface BackupTarget {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface BackupUndoResult {
  ok: boolean;
  restored: string[];
  removed: string[];
  stale: string[];
  message?: string;
}

const MAX_BACKUPS = 500;

export class BackupStore {
  private readonly dir: string;

  constructor(
    private readonly fs: AiStoreFs,
    private readonly target: BackupTarget,
    pluginDir: string,
  ) {
    const clean = (pluginDir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    this.dir = clean ? `${clean}/backups` : "backups";
  }

  /** Where the JSON files live, shown in diagnostics. */
  get folder(): string {
    return this.dir;
  }

  /**
   * Store the previous content and return the audit entry for it.
   *
   * The caller has already produced `after` but has not written it yet: this
   * method must be called *before* the vault write, so a crash between the two
   * leaves a backup of a file that is still unchanged -- harmless -- instead of
   * a changed file with no backup.
   */
  async record(input: {
    batchId: string;
    runId?: string;
    tool: string;
    path: string;
    before: string | null;
    after: string;
  }): Promise<AiWriteAudit> {
    const audit = createWriteAudit({
      batchId: input.batchId,
      ...(input.runId ? { runId: input.runId } : {}),
      tool: input.tool,
      path: input.path,
      before: input.before,
      after: input.after,
    });
    const record: BackupRecord = {
      schema: BACKUP_SCHEMA,
      id: audit.id,
      batchId: audit.batchId,
      ...(audit.runId ? { runId: audit.runId } : {}),
      tool: audit.tool,
      path: audit.path,
      original: input.before ?? "",
      created: audit.created === true,
      at: audit.at,
      beforeHash: audit.beforeHash,
      afterHash: audit.afterHash,
    };
    await this.fs.mkdir(this.dir);
    await this.fs.writeText(`${this.dir}/${audit.id}.json`, JSON.stringify(record, null, 2));
    await this.prune();
    return audit;
  }

  async list(): Promise<BackupRecord[]> {
    const names = await this.fs.list(this.dir);
    const records: BackupRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const text = await this.fs.readText(`${this.dir}/${name}`);
      if (text === null) continue;
      const record = normalizeBackup(text);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.at - a.at);
  }

  /** Backups belonging to one agent run or Apply batch. */
  async batch(batchId: string): Promise<BackupRecord[]> {
    return (await this.list()).filter((record) => record.batchId === batchId);
  }

  /** What an undo would do, without doing it; the UI shows this before asking. */
  async planBatch(batchId: string): Promise<AiUndoPlan> {
    const records = await this.batch(batchId);
    const current = new Map<string, string | null>();
    for (const record of records) current.set(record.path, await this.target.read(record.path));
    return planUndo(records.map(toAudit), (path) => current.get(path) ?? null);
  }

  /** Undo the newest single write, whatever batch it belongs to. */
  async undoLastWrite(): Promise<BackupUndoResult> {
    const newest = (await this.list())[0];
    if (!newest) return { ok: false, restored: [], removed: [], stale: [], message: "没有可撤销的 AI 写入。" };
    return await this.undoRecords([newest]);
  }

  /** Undo every write in a batch, as one action. */
  async undoBatch(batchId: string): Promise<BackupUndoResult> {
    const records = await this.batch(batchId);
    if (!records.length) return { ok: false, restored: [], removed: [], stale: [], message: "这个批次没有备份记录。" };
    return await this.undoRecords(records);
  }

  private async undoRecords(records: readonly BackupRecord[]): Promise<BackupUndoResult> {
    const byId = new Map(records.map((record) => [record.id, record]));
    const plan = planUndo(records.map(toAudit), () => null);
    const restored: string[] = [];
    const removed: string[] = [];
    const stale: string[] = [];
    for (const step of plan.steps) {
      const record = byId.get(step.entry.id);
      if (!record) continue;
      const current = await this.target.read(record.path);
      if (current === null) {
        if (record.created) {
          // The file this batch created is already gone: nothing to undo.
          await this.fs.remove(`${this.dir}/${record.id}.json`);
          continue;
        }
        // The file was moved or trashed after the batch wrote it -- which is
        // exactly what `vault.rename` / `vault.trash` do. Restoring the
        // content at the recorded path is the undo; the rename's paired
        // `created` entry removes the new path.
        stale.push(record.path);
        try {
          await this.target.write(record.path, record.original);
          restored.push(record.path);
        } catch (error) {
          return {
            ok: false,
            restored,
            removed,
            stale,
            message: `恢复 ${record.path} 失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
        await this.fs.remove(`${this.dir}/${record.id}.json`);
        continue;
      }
      if (!matchesAfterHash(toAudit(record), current)) stale.push(record.path);
      try {
        if (record.created) {
          await this.target.remove(record.path);
          removed.push(record.path);
        } else {
          await this.target.write(record.path, record.original);
          restored.push(record.path);
        }
        await this.fs.remove(`${this.dir}/${record.id}.json`);
      } catch (error) {
        return {
          ok: false,
          restored,
          removed,
          stale,
          message: `撤销 ${record.path} 失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const message = stale.length ? `已撤销，但以下文件在 AI 之后被改过或已不存在：${stale.join("、")}` : "";
    return { ok: true, restored, removed, stale, ...(message ? { message } : {}) };
  }

  /** Keep the newest backups; a 500-file folder is tens of MB at worst. */
  private async prune(): Promise<void> {
    const records = await this.list();
    if (records.length <= MAX_BACKUPS) return;
    for (const record of records.slice(MAX_BACKUPS)) {
      await this.fs.remove(`${this.dir}/${record.id}.json`);
    }
  }
}

/** The audit shape the undo planner understands, rebuilt from the stored record. */
function toAudit(record: BackupRecord): AiWriteAudit {
  return {
    id: record.id,
    batchId: record.batchId,
    ...(record.runId ? { runId: record.runId } : {}),
    tool: record.tool,
    path: record.path,
    bytes: record.original.length,
    beforeChars: record.original.length,
    afterChars: 0,
    beforeHash: record.beforeHash,
    afterHash: record.afterHash,
    at: record.at,
    ...(record.created ? { created: true } : {}),
  };
}

/** Tolerant reader: the pre-batch shape (`{path, original, createdAt}`) still loads. */
function normalizeBackup(text: string): BackupRecord | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    const original = typeof record.original === "string" ? record.original : "";
    if (!path) return null;
    const at = typeof record.at === "number" ? record.at : typeof record.createdAt === "number" ? record.createdAt : Date.now();
    return {
      schema: typeof record.schema === "number" ? record.schema : BACKUP_SCHEMA,
      id: typeof record.id === "string" && record.id ? record.id : `legacy-${at}`,
      batchId: typeof record.batchId === "string" && record.batchId ? record.batchId : `legacy-${at}`,
      ...(typeof record.runId === "string" && record.runId ? { runId: record.runId } : {}),
      tool: typeof record.tool === "string" ? record.tool : "host.apply",
      path,
      original,
      created: record.created === true,
      at,
      beforeHash: typeof record.beforeHash === "string" ? record.beforeHash : "",
      afterHash: typeof record.afterHash === "string" ? record.afterHash : "",
    };
  } catch {
    return null;
  }
}