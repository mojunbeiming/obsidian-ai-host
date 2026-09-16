/**
 * Conversations as one JSON file each, with an index beside them.
 *
 * ## Why this shape rather than one big data.json
 *
 * Every session in one object means a corrupt byte takes every conversation with
 * it, and every save rewrites the whole history -- which is exactly what
 * Obsidian's sync then uploads. Smart Composer moved its chats and templates to
 * one file per record for the same reason, and kept a metadata index so the list
 * can be drawn without reading every file.
 *
 * ## Where this improves on the reference
 *
 * * **File names are ids, never titles.** The reference renames a file whenever
 *   the title or timestamp changes, so a vault sync treats every rename as a
 *   delete plus an add churn. Here `v1_<id>.json` is immutable; title and time
 *   live in the index and in the record body.
 * * **Writes are atomic.** A temporary file is renamed over the target, so a
 *   crash mid-write leaves the previous record intact instead of a truncated
 *   JSON file. `AiStoreFs.rename` is required to replace an existing target.
 * * **The index is disposable.** It is a cache, not the source of truth: if it
 *   is missing or corrupt, `rebuildIndex` reconstructs it from the files, and a
 *   single unreadable record is skipped rather than failing the list.
 * * **No gzip, no bundled database.** The files stay readable with `cat` and
 *   diffable in version control.
 *
 * ## The injected filesystem
 *
 * This module is Obsidian-free and Node-free, so it cannot call `fs` or the
 * vault adapter itself. `AiStoreFs` is the small surface it needs; the host
 * implements it over `app.vault.adapter` (and the tests over a `Map`). Paths are
 * always forward-slash relative paths; the implementation decides what that
 * means, which is what lets the same code address a vault folder or a test
 * directory.
 *
 * Pure logic: every effect goes through the injected `fs`.
 */

/**
 * The record schema. Bump when the record shape changes; the store rejects newer.
 *
 * 1 -> 2 added message identity (`id`/`createdAt`/`status`/`parentId`), the
 * `workspaceId` a conversation belongs to, and the `pin` operation. Migration is
 * *copy-forward*: a v1 file is read, normalized and written as v2, and the v1
 * file is left on disk as the backup. Nothing writes v1 again.
 */
export const AI_CONVERSATION_SCHEMA = 2;

/** Schemas this store can still read. Oldest first; a migration writes the newest. */
export const AI_CONVERSATION_LEGACY_SCHEMAS: readonly number[] = [1];

/**
 * The filesystem the store needs.
 *
 * `rename` must atomically replace an existing destination. Every Node-like
 * implementation does; a handwritten one needs to use `fs.rename`, not
 * delete-then-rename, or the atomicity this store is built for is lost.
 */
export interface AiStoreFs {
  /** Create the directory and any parents. Succeeding when it already exists is required. */
  mkdir(dir: string): Promise<void>;
  /** Read a UTF-8 file, or null when it does not exist. Other errors propagate. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  /**
   * Replace `to` with `from`, atomically.
   *
   * Implementations MUST replace an existing destination. Some adapters
   * (Obsidian's vault adapter is one) refuse to overwrite and report
   * `Destination file already exists!`; `writeTextAtomic` tolerates that
   * by removing the destination and retrying, so a store that can never
   * rewrite its index is not a store that loses conversations.
   */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file; a missing file is not an error. */
  remove(path: string): Promise<void>;
  /** File names in a directory (not full paths); a missing directory yields []. */
  list(dir: string): Promise<string[]>;
}

export interface AiConversationRecord<M = unknown> {
  schema: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  /** The workspace this conversation belongs to; absent means 未分组. */
  workspaceId?: string;
  messages: M[];
  /** Adapter-defined extras (model used, token totals). Opaque here. */
  meta?: Record<string, unknown>;
}

/** What the list view needs, without reading a record body. */
export interface AiConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  workspaceId?: string;
  messageCount: number;
  /** Store-relative file name, for diagnostics. */
  file: string;
}

export interface AiConversationStoreOptions<M = unknown> {
  /** Directory inside the host's storage root. */
  dir?: string;
  /** Defaults to a time-and-random id; tests inject a deterministic one. */
  newId?: () => string;
  now?: () => number;
  maxTitleLength?: number;
  /** Reads a message's id for the message-level operations. Defaults to `message.id`. */
  messageId?: (message: M) => string | undefined;
  /** Fills schema-2 message fields while migrating; the host passes `ensureMessageMeta`. */
  migrateMessage?: (message: M, index: number, at: number) => M;
}

export interface AiConversationInitInfo {
  /** True when the index was rebuilt rather than loaded. */
  rebuilt: boolean;
  /** Ids (or file names) of records that could not be read, for diagnostics. */
  skipped: string[];
}

export type AiConversationReadProblem = "missing" | "corrupt" | "version-ahead";

export interface AiConversationReadResult<M> {
  record: AiConversationRecord<M> | null;
  problem?: AiConversationReadProblem;
}

export interface AiConversationImportResult {
  imported: number;
  skipped: number;
  failed: number;
  ids: string[];
}

export interface AiConversationStore<M = unknown> {
  readonly dir: string;
  /** Create the directory and load (or rebuild) the index. Idempotent. */
  init(): Promise<AiConversationInitInfo>;
  list(): Promise<AiConversationSummary[]>;
  read(id: string): Promise<AiConversationRecord<M> | null>;
  readDetailed(id: string): Promise<AiConversationReadResult<M>>;
  create(input?: { title?: string; messages?: M[]; pinned?: boolean; id?: string; workspaceId?: string }): Promise<AiConversationRecord<M>>;
  save(record: AiConversationRecord<M>): Promise<AiConversationRecord<M>>;
  rename(id: string, title: string): Promise<AiConversationRecord<M>>;
  /** Pin/unpin. Pinning changes the index order only; the file name never moves. */
  pin(id: string, pinned?: boolean): Promise<AiConversationRecord<M>>;
  /** Append one message and bump `updatedAt`. */
  appendMessage(id: string, message: M): Promise<AiConversationRecord<M>>;
  /**
   * Replace one message, identified by the `messageId` accessor.
   *
   * A transform rather than a patch object because the store is generic: the
   * chat layer is the part that knows a retraction is a status change, and the
   * store is the part that knows how to write the file atomically.
   */
  updateMessage(id: string, messageId: string, transform: (message: M, index: number) => M): Promise<AiConversationRecord<M>>;
  /** Drop every message after `messageId`; `inclusive: true` drops the anchor too. */
  truncateAfter(id: string, messageId: string, options?: { inclusive?: boolean }): Promise<AiConversationRecord<M>>;
  remove(id: string): Promise<boolean>;
  /** Drop the cached index and rebuild it from the record files. */
  rebuildIndex(): Promise<AiConversationInitInfo>;
  /**
   * Import conversation-shaped values from an older store.
   *
   * Accepts an array, `{ conversations: [...] }`, or an id-keyed object. Every
   * value is normalized and validated; a value that is not a record is counted
   * as failed rather than throwing, because a migration that stops at the first
   * bad entry has migrated nothing. Existing ids are kept unless `overwrite`.
   */
  importLegacy(value: unknown, options?: { overwrite?: boolean }): Promise<AiConversationImportResult>;
}

/** A store failure a caller can act on. */
export class AiConversationError extends Error {
  readonly code: "invalid-record" | "not-found";

  constructor(code: "invalid-record" | "not-found", message: string) {
    super(message);
    this.name = "AiConversationError";
    this.code = code;
  }
}

/** Create the store. Nothing touches the filesystem until `init()`. */
export function createConversationStore<M = unknown>(
  fs: AiStoreFs,
  options: AiConversationStoreOptions<M> = {},
): AiConversationStore<M> {
  const dir = normalizeDir(options.dir ?? "conversations");
  const indexFile = `${dir}/index.json`;
  const newId = options.newId ?? defaultNewId;
  const now = options.now ?? (() => Date.now());
  const maxTitleLength = options.maxTitleLength ?? 120;
  const messageIdOf = options.messageId ?? ((message: M): string | undefined => defaultMessageId(message));
  /** Legacy file names by record id; a scan happens only when a read misses. */
  let legacyNames: Map<string, string> | null = null;

  let entries: Map<string, AiConversationSummary> | null = null;
  let ready: Promise<AiConversationInitInfo> | null = null;
  /**
   * Index writes run one after another.
   *
   * Two saves that interleave at the filesystem level can otherwise finish in
   * the opposite order from the one they snapshotted the entries in, and the
   * index would end up describing a vault that no longer exists -- the exact
   * "missing conversation" report that an index is supposed to prevent.
   */
  let indexWrite: Promise<void> = Promise.resolve();

  const fileFor = (id: string, schema = AI_CONVERSATION_SCHEMA): string => `${dir}/v${schema}_${safeFileId(id)}.json`;

  /** Fill schema-2 message fields on the way out of a legacy record. */
  function migrateRecord(record: AiConversationRecord<unknown>): AiConversationRecord<M> {
    const migrate = options.migrateMessage;
    const messages = migrate
      ? record.messages.map((message, index) => migrate(message as M, index, now()))
      : (record.messages as M[]);
    return { ...(record as AiConversationRecord<M>), messages };
  }

  const ensure = (): Promise<AiConversationInitInfo> => {
    ready ??= load();
    return ready;
  };

  async function load(): Promise<AiConversationInitInfo> {
    await fs.mkdir(dir);
    const text = await fs.readText(indexFile);
    if (text !== null) {
      const parsed = parseIndex(text);
      if (parsed) {
        entries = new Map(parsed.map((entry) => [entry.id, entry]));
        // The index is a cache, and a cache that disagrees with the
        // directory must lose. This is what recovers from the earlier
        // adapter bug that left `entries: []` beside nine record files:
        // trusting the index kept the sidebar empty forever.
        if (await indexMatchesFiles(entries.size)) return { rebuilt: false, skipped: [] };
        return await rebuild();
      }
    }
    return await rebuild();
  }

  /**
   * Does the index describe the directory?
   *
   * Compared by *record-file key* (the name without its `vN_` prefix), so a
   * migrated v1+v2 pair for one id counts once. Fewer files than entries
   * means a record was deleted, more means one was written while the index
   * was unwritable; both rebuild.
   */
  async function indexMatchesFiles(known: number): Promise<boolean> {
    const keys = new Set<string>();
    for (const name of await fs.list(dir)) {
      const schema = schemaOfFileName(name);
      if (schema === null || schema > AI_CONVERSATION_SCHEMA) continue;
      keys.add(name.replace(/^v\d+_/, ""));
    }
    return known > 0 ? keys.size >= known : keys.size === 0;
  }

  async function rebuild(): Promise<AiConversationInitInfo> {
    const names = await fs.list(dir);
    const byId = new Map<string, { record: AiConversationRecord<unknown>; name: string; schema: number }>();
    const skipped: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const schema = schemaOfFileName(name);
      if (schema === null || schema > AI_CONVERSATION_SCHEMA) continue;
      const path = `${dir}/${name}`;
      const text = await fs.readText(path);
      if (text === null) continue;
      const record = parseRecordJson(text, now(), schema);
      if (!record) {
        skipped.push(name);
        continue;
      }
      const prior = byId.get(record.id);
      // v2 wins over the v1 file left behind by migration; two files with the
      // same id are a migrated pair, not two conversations.
      if (!prior || schema > prior.schema) byId.set(record.id, { record, name, schema });
    }
    entries = new Map([...byId.values()].map((entry) => [entry.record.id, summaryOf(entry.record, entry.name)]));
    await writeIndex();
    return { rebuilt: true, skipped };
  }

  /** The names one id could have under an older schema, scanned once per session. */
  async function scanLegacy(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const name of await fs.list(dir)) {
      if (!name.endsWith(".json")) continue;
      const schema = schemaOfFileName(name);
      if (schema === null || schema >= AI_CONVERSATION_SCHEMA) continue;
      const text = await fs.readText(`${dir}/${name}`);
      if (text === null) continue;
      const record = parseRecordJson(text, now(), schema);
      if (record) found.set(record.id, name);
    }
    return found;
  }

  async function findLegacy(id: string): Promise<string | null> {
    legacyNames ??= await scanLegacy();
    return legacyNames.get(id) ?? null;
  }

  async function writeIndex(): Promise<void> {
    // Snapshot synchronously: the payload must describe the entries as of the
    // call, not whatever they become while the previous write is still in flight.
    const list = sortSummaries([...(entries ?? new Map()).values()]);
    const payload = JSON.stringify({ schema: AI_CONVERSATION_SCHEMA, entries: list }, null, 2);
    const next = indexWrite.catch(() => undefined).then(() => writeTextAtomic(fs, indexFile, payload));
    indexWrite = next;
    await next;
  }


  async function writeRecordFile(record: AiConversationRecord<M>): Promise<void> {
    await fs.mkdir(dir);
    await writeTextAtomic(fs, fileFor(record.id), JSON.stringify(record, null, 2));
  }

  const store: AiConversationStore<M> = {
    dir,

    async init() {
      return await ensure();
    },

    async list() {
      await ensure();
      return sortSummaries([...(entries ?? new Map()).values()]);
    },

    async read(id) {
      return (await store.readDetailed(id)).record;
    },

    async readDetailed(id) {
      await ensure();
      const text = await fs.readText(fileFor(id));
      if (text !== null) {
        const record = parseRecordJson(text, now(), AI_CONVERSATION_SCHEMA);
        if (!record) {
          // Distinguish "this record is from a newer plugin" from "this file is
          // broken", because the first wants an upgrade message and the second
          // wants a restore-from-backup message.
          const version = schemaOf(text);
          return { record: null, problem: version !== null && version > AI_CONVERSATION_SCHEMA ? "version-ahead" : "corrupt" };
        }
        // A current record is returned verbatim: `migrateMessage` is for the
        // legacy shape, and running it on every read would keep rewriting
        // fields a newer caller had deliberately cleared.
        return { record: record as AiConversationRecord<M> };
      }
      // Schema 1 file: copy it forward, leave the original on disk as the
      // backup. The write goes through `save`, so the index is updated too.
      const legacy = await findLegacy(id);
      if (!legacy) return { record: null, problem: "missing" };
      const legacyText = await fs.readText(`${dir}/${legacy}`);
      if (legacyText === null) return { record: null, problem: "missing" };
      const record = parseRecordJson(legacyText, now(), AI_CONVERSATION_SCHEMA);
      if (!record) {
        const version = schemaOf(legacyText);
        return { record: null, problem: version !== null && version > AI_CONVERSATION_SCHEMA ? "version-ahead" : "corrupt" };
      }
      const migrated = migrateRecord(record);
      await store.save(migrated);
      return { record: migrated };
    },

    async create(input = {}) {
      await ensure();
      const stamp = now();
      const record: AiConversationRecord<M> = {
        schema: AI_CONVERSATION_SCHEMA,
        id: normalizeId(input.id) || newId(),
        title: normalizeTitle(input.title, maxTitleLength),
        createdAt: stamp,
        updatedAt: stamp,
        pinned: input.pinned === true,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        messages: Array.isArray(input.messages) ? input.messages : [],
      };
      return await store.save(record);
    },

    async save(record) {
      await ensure();
      const normalized = normalizeRecord(record, now(), maxTitleLength, AI_CONVERSATION_SCHEMA);
      if (!normalized) {
        throw new AiConversationError("invalid-record", "会话记录缺少 id 或 messages 不是数组，无法保存。");
      }
      await writeRecordFile(normalized as AiConversationRecord<M>);
      (entries ??= new Map()).set(normalized.id, summaryOf(normalized, fileNameOf(fileFor(normalized.id))));
      await writeIndex();
      return normalized as AiConversationRecord<M>;
    },

    async rename(id, title) {
      const detailed = await store.readDetailed(id);
      if (!detailed.record) {
        throw new AiConversationError("not-found", `找不到会话 ${id}，无法重命名。`);
      }
      return await store.save({ ...detailed.record, title: normalizeTitle(title, maxTitleLength), updatedAt: now() });
    },

    async pin(id, pinned = true) {
      const detailed = await store.readDetailed(id);
      if (!detailed.record) throw new AiConversationError("not-found", `找不到会话 ${id}，无法置顶。`);
      // `updatedAt` deliberately stays put: pinning is a view change, and
      // bumping it would move the conversation into "今天" and reorder the
      // unpinned list every time the user toggles the pin.
      return await store.save({ ...detailed.record, pinned });
    },

    async appendMessage(id, message) {
      const detailed = await store.readDetailed(id);
      if (!detailed.record) throw new AiConversationError("not-found", `找不到会话 ${id}，无法追加消息。`);
      return await store.save({ ...detailed.record, messages: [...detailed.record.messages, message], updatedAt: now() });
    },

    async updateMessage(id, messageId, transform) {
      const detailed = await store.readDetailed(id);
      if (!detailed.record) throw new AiConversationError("not-found", `找不到会话 ${id}，无法修改消息。`);
      let found = false;
      const messages = detailed.record.messages.map((message, index) => {
        if (found || messageIdOf(message) !== messageId) return message;
        found = true;
        return transform(message, index);
      });
      if (!found) throw new AiConversationError("not-found", `会话 ${id} 里找不到消息 ${messageId}。`);
      return await store.save({ ...detailed.record, messages, updatedAt: now() });
    },

    async truncateAfter(id, messageId, options) {
      const detailed = await store.readDetailed(id);
      if (!detailed.record) throw new AiConversationError("not-found", `找不到会话 ${id}，无法截断。`);
      const index = detailed.record.messages.findIndex((message) => messageIdOf(message) === messageId);
      if (index < 0) throw new AiConversationError("not-found", `会话 ${id} 里找不到消息 ${messageId}。`);
      const keep = options?.inclusive ? index : index + 1;
      return await store.save({ ...detailed.record, messages: detailed.record.messages.slice(0, keep), updatedAt: now() });
    },

    async remove(id) {
      await ensure();
      const known = (entries ?? new Map()).has(id);
      await fs.remove(fileFor(id));
      // The legacy file is not a backup once the user asked for a delete: a
      // later rebuild must not resurrect the conversation from it. The scan
      // covers a legacy file whose name a migration did not produce.
      for (const schema of AI_CONVERSATION_LEGACY_SCHEMAS) await fs.remove(fileFor(id, schema));
      const legacy = await findLegacy(id);
      if (legacy) await fs.remove(`${dir}/${legacy}`);
      legacyNames?.delete(id);
      if (entries?.delete(id)) await writeIndex();
      return known;
    },

    async rebuildIndex() {
      // `ready` is left alone: `load` calls this during the first `init`, and
      // invalidating the promise from inside its own resolution would deadlock
      // every later caller.
      return await rebuild();
    },

    async importLegacy(value, importOptions = {}) {
      await ensure();
      const candidates = legacyCandidates(value);
      const result: AiConversationImportResult = { imported: 0, skipped: 0, failed: 0, ids: [] };
      for (const candidate of candidates) {
        const parsed =
          typeof candidate === "string"
            ? (() => {
                try {
                  return JSON.parse(candidate);
                } catch {
                  return null;
                }
              })()
            : candidate;
        const candidateValue = salvageId(parsed, newId);
        const normalized = normalizeRecord(candidateValue, now(), maxTitleLength, AI_CONVERSATION_SCHEMA);
        if (!normalized) {
          result.failed += 1;
          continue;
        }
        if ((entries ?? new Map()).has(normalized.id) && !importOptions.overwrite) {
          result.skipped += 1;
          continue;
        }
        await writeRecordFile(normalized as AiConversationRecord<M>);
        (entries ??= new Map()).set(normalized.id, summaryOf(normalized, fileNameOf(fileFor(normalized.id))));
        result.imported += 1;
        result.ids.push(normalized.id);
      }
      if (result.imported) await writeIndex();
      return result;
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// File and record helpers
// ---------------------------------------------------------------------------

function normalizeDir(dir: string): string {
  return (dir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "conversations";
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A filesystem-safe rendering of an id, with a hash of the original appended.
 *
 * The hash is what keeps `a/b` and `a-b` from colliding after sanitization; ids
 * are opaque, and an opaque id must not become a different record because two of
 * its characters were both illegal in a file name.
 */
function safeFileId(id: string): string {
  const cleaned = normalizeId(id)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return `${cleaned || "record"}-${fnv1a(id)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTitle(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (text || "未命名会话").slice(0, maxLength);
}

function schemaOf(text: string): number | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const schema = (parsed as { schema?: unknown }).schema;
      if (typeof schema === "number" && Number.isInteger(schema)) return schema;
    }
  } catch {
    // Fall through: unparseable is not "version ahead".
  }
  return null;
}

function parseRecordJson(text: string, stamp: number, schema: number): AiConversationRecord<unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeRecord(parsed, stamp, 120, schema);
}

function normalizeRecord(
  raw: unknown,
  stamp: number,
  maxTitleLength: number,
  schema: number,
): AiConversationRecord<unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = normalizeId(record.id);
  if (!id) return null;
  const declared = typeof record.schema === "number" && Number.isInteger(record.schema) ? record.schema : schema;
  if (declared > schema) return null;
  const createdAt = positiveNumber(record.createdAt, stamp);
  const updatedAt = positiveNumber(record.updatedAt, createdAt);
  const input = record as { messages?: unknown; meta?: unknown };
  return {
    schema,
    id,
    title: normalizeTitle(record.title, maxTitleLength),
    createdAt,
    updatedAt,
    pinned: record.pinned === true,
    ...(typeof record.workspaceId === "string" && record.workspaceId.trim() ? { workspaceId: record.workspaceId.trim() } : {}),
    messages: Array.isArray(input.messages) ? (input.messages as unknown[]) : [],
    ...(input.meta && typeof input.meta === "object" && !Array.isArray(input.meta) ? { meta: input.meta as Record<string, unknown> } : {}),
  };
}

/** The default message-id accessor: `message.id` when it is a non-empty string. */
function defaultMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id ? id : undefined;
}

/** `v2_abc.json` -> 2. Null for a file that is not a record of a known shape. */
function schemaOfFileName(name: string): number | null {
  const match = /^v(\d+)_/.exec(name);
  if (!match) return null;
  const schema = Number(match[1]);
  return Number.isInteger(schema) && schema >= 0 ? schema : null;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function summaryOf(record: AiConversationRecord<unknown>, file: string): AiConversationSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pinned: record.pinned,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    messageCount: record.messages.length,
    file,
  };
}

function sortSummaries(list: AiConversationSummary[]): AiConversationSummary[] {
  // Pinned first, then most recently updated: the order the conversation list
  // shows, decided here rather than in each view.
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id.localeCompare(b.id);
  });
}

function parseIndex(text: string): AiConversationSummary[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const index = parsed as { schema?: unknown; entries?: unknown };
  if (typeof index.schema === "number" && index.schema > AI_CONVERSATION_SCHEMA) return null;
  if (!Array.isArray(index.entries)) return null;
  const out: AiConversationSummary[] = [];
  for (const entry of index.entries) {
    if (!entry || typeof entry !== "object") continue;
    const summary = entry as Record<string, unknown>;
    const id = normalizeId(summary.id);
    if (!id) continue;
    out.push({
      id,
      title: normalizeTitle(summary.title, 120),
      createdAt: positiveNumber(summary.createdAt, 0),
      updatedAt: positiveNumber(summary.updatedAt, 0),
      pinned: summary.pinned === true,
      ...(typeof summary.workspaceId === "string" && summary.workspaceId.trim() ? { workspaceId: summary.workspaceId.trim() } : {}),
      messageCount: typeof summary.messageCount === "number" && summary.messageCount >= 0 ? summary.messageCount : 0,
      file: typeof summary.file === "string" ? summary.file : "",
    });
  }
  return out;
}

export async function writeTextAtomic(fs: AiStoreFs, path: string, text: string): Promise<void> {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const temporary = `${path}.${suffix}.tmp`;
  await fs.writeText(temporary, text);
  try {
    await fs.rename(temporary, path);
    return;
  } catch {
    // Destination exists and this adapter refuses to overwrite it (Obsidian
    // does exactly that). Remove the destination and retry, falling back to
    // an in-place write if even that is refused: an unrewritable index is a
    // store that silently loses every conversation, which is far worse than
    // a non-atomic write.
  }
  await fs.remove(path).catch(() => undefined);
  try {
    await fs.rename(temporary, path);
    return;
  } catch {
    await fs.remove(temporary).catch(() => undefined);
    await fs.writeText(path, text);
  }
}

/**
 * Give an id to a legacy record that lacks one.
 *
 * A record that has a title or a messages array is recognizably a conversation
 * and gets a generated id: the old shape may key records by object key and leave
 * the body without an id, and refusing those would migrate nothing. An object
 * with neither is not a conversation at all -- it stays a `failed` count.
 */
function salvageId(value: unknown, newId: () => string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (normalizeId(record.id)) return value;
  const looksLikeConversation = Array.isArray(record.messages) || typeof record.title === "string";
  return looksLikeConversation ? { ...record, id: newId() } : value;
}

function defaultNewId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Every shape an older store might have handed over. */
function legacyCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.conversations)) return record.conversations;
    if (Array.isArray(record.records)) return record.records;
    return Object.values(record);
  }
  if (typeof value === "string") return [value];
  return [];
}