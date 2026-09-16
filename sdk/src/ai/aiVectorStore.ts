/**
 * The pure-JS vector index: JSONL metadata, Float32 vectors, cosine search.
 *
 * ## Why shards instead of a database
 *
 * The reference implementation reaches for PGlite + pgvector and pays for it
 * with a WASM bundle downloaded from a CDN on first run. This project refuses
 * that: a note index must work offline, be deletable with the file manager, and
 * be readable with `cat`. A shard is a text file of metadata plus a binary file
 * of vectors; both can be thrown away and rebuilt.
 *
 * ## Layout
 *
 * ```
 * vector/
 *   manifest.json        { schema, shards: [{ name, count }] }
 *   shard-0000.jsonl     one metadata record per line
 *   shard-0000.vec       Float32 vectors, concatenated in line order
 * ```
 *
 * A record's vector sits at the sum of the dimensions before it, so the two
 * files stay in sync by position. Deletion rewrites the shard in place; a
 * tombstone scheme would need a compactor, and a compactor is the part nobody
 * runs.
 *
 * ## Search is a linear scan, on purpose
 *
 * An HNSW graph inside a plugin is state that has to be persisted, rebuilt after
 * a crash and debugged through a UI that cannot see it. For a personal vault the
 * exact scan is fast enough, and `stats()` plus the settings page tell the user
 * when the index has outgrown the comfortable range.
 *
 * All I/O goes through the injected `AiVectorFs`; this file is Obsidian-free.
 */

/** Vector files need binary I/O, which the conversation store's text interface does not cover. */
export interface AiVectorFs {
  mkdir(dir: string): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array | null>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Remove a directory and its contents; a missing directory is not an error. */
  rmdir(dir: string): Promise<void>;
  list(dir: string): Promise<string[]>;
}

export const AI_VECTOR_SCHEMA = 1;

export interface AiVectorRecord {
  id: string;
  path: string;
  mtime: number;
  hash: string;
  model: string;
  dimension: number;
  content: string;
  vector: Float32Array;
  metadata: { startLine: number; endLine: number };
}

export interface AiVectorHit {
  id: string;
  path: string;
  mtime: number;
  content: string;
  similarity: number;
  metadata: { startLine: number; endLine: number };
}

export interface AiVectorScope {
  files?: readonly string[];
  folders?: readonly string[];
}

export interface AiVectorQuery {
  vector: Float32Array;
  model: string;
  dimension: number;
  /** Cosine similarity floor; 0 keeps everything. */
  minSimilarity?: number;
  limit?: number;
  scope?: AiVectorScope;
}

export interface AiIndexStats {
  chunks: number;
  files: number;
  models: string[];
  dimensions: number[];
  /** Approximate: metadata text plus vector bytes. */
  bytes: number;
  shards: number;
}

export interface AiVectorPathInfo {
  path: string;
  mtime: number;
  hash: string;
}

export interface AiVectorStore {
  upsert(records: readonly AiVectorRecord[]): Promise<void>;
  /** Remove every chunk of the given paths; returns how many records were removed. */
  deleteByPath(paths: readonly string[]): Promise<number>;
  query(query: AiVectorQuery): Promise<AiVectorHit[]>;
  stats(): Promise<AiIndexStats>;
  clear(model?: string): Promise<void>;
  /** Distinct files currently indexed, with the newest mtime/hash seen. */
  listPaths(): Promise<AiVectorPathInfo[]>;
  isEmpty(): Promise<boolean>;
}

export interface AiVectorStoreOptions {
  dir?: string;
  /** Records per shard; smaller means more files and cheaper deletions. */
  shardSize?: number;
  /** Vector cache ceiling; beyond it the least recently used shard is dropped. */
  maxCachedVectorBytes?: number;
}

interface MetaRecord {
  id: string;
  path: string;
  mtime: number;
  hash: string;
  model: string;
  dimension: number;
  content: string;
  metadata: { startLine: number; endLine: number };
}

interface Shard {
  name: string;
  records: MetaRecord[];
  /** Decoded vectors in record order; null until first use. */
  vectors: Float32Array | null;
  vectorBytes: number;
  lastUsed: number;
}

interface Manifest {
  schema: number;
  shards: { name: string; count: number }[];
}

export function createAiVectorStore(fs: AiVectorFs, options: AiVectorStoreOptions = {}): AiVectorStore {
  const dir = normalizeDir(options.dir ?? "vector");
  const manifestPath = `${dir}/manifest.json`;
  const shardSize = Math.max(1, Math.floor(options.shardSize ?? 500));
  const maxCachedVectorBytes = options.maxCachedVectorBytes ?? 64 * 1024 * 1024;
  const shards = new Map<string, Shard>();
  let cachedVectorBytes = 0;
  let clock = 0;
  let loaded = false;

  const shardName = (index: number): string => `shard-${String(index).padStart(4, "0")}`;
  const metaPath = (name: string): string => `${dir}/${name}.jsonl`;
  const vectorPath = (name: string): string => `${dir}/${name}.vec`;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    await fs.mkdir(dir);
    const names = new Set<string>();
    const manifest = parseManifest(await fs.readText(manifestPath));
    if (manifest) for (const shard of manifest.shards) names.add(shard.name);
    else {
      // A missing or corrupt manifest is recoverable: every shard file that
      // exists is real, and reading it beats reporting an empty index.
      for (const name of await fs.list(dir)) {
        const match = /^(shard-\d{4})\.jsonl$/.exec(name);
        if (match) names.add(match[1]);
      }
    }
    for (const name of [...names].sort()) {
      const text = await fs.readText(metaPath(name));
      if (text === null) continue;
      const records = parseRecords(text);
      if (!records.length) continue;
      shards.set(name, { name, records, vectors: null, vectorBytes: 0, lastUsed: 0 });
    }
    loaded = true;
  }

  function nextShardName(): string {
    let index = shards.size;
    while (shards.has(shardName(index))) index += 1;
    return shardName(index);
  }

  /** The shard that can take one more record without exceeding the shard size. */
  function activeShardName(): string {
    const names = [...shards.keys()].sort();
    const last = names[names.length - 1];
    if (last && (shards.get(last)?.records.length ?? 0) < shardSize) return last;
    return nextShardName();
  }

  /** Decode a shard's vectors, caching the result. */
  async function shardVectors(shard: Shard): Promise<Float32Array> {
    if (shard.vectors) {
      shard.lastUsed = ++clock;
      return shard.vectors;
    }
    const total = shard.records.reduce((sum, record) => sum + record.dimension, 0);
    const vector = new Float32Array(total);
    const bytes = await fs.readBinary(vectorPath(shard.name));
    if (bytes && bytes.byteLength >= total * 4) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      for (let index = 0; index < total; index += 1) {
        vector[index] = view.getFloat32(offset, true);
        offset += 4;
      }
    }
    // A shard whose vector file was lost stays browsable: its chunks simply do
    // not match anything, instead of failing the whole index.
    shard.vectors = vector;
    shard.vectorBytes = vector.byteLength;
    shard.lastUsed = ++clock;
    cachedVectorBytes += vector.byteLength;
    evictIfNeeded();
    return vector;
  }

  function evictIfNeeded(): void {
    if (cachedVectorBytes <= maxCachedVectorBytes) return;
    for (const shard of [...shards.values()].filter((entry) => entry.vectors).sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (cachedVectorBytes <= maxCachedVectorBytes) break;
      const bytes = shard.vectors?.byteLength ?? 0;
      shard.vectors = null;
      shard.vectorBytes = 0;
      cachedVectorBytes -= bytes;
    }
  }

  /** Replace a shard's contents and write both files. */
  async function replaceShard(name: string, records: MetaRecord[], vectors: Float32Array): Promise<void> {
    const prior = shards.get(name);
    if (prior?.vectors) cachedVectorBytes -= prior.vectors.byteLength;
    if (!records.length) {
      shards.delete(name);
      await fs.remove(metaPath(name));
      await fs.remove(vectorPath(name));
      await persistManifest();
      return;
    }
    const shard: Shard = { name, records, vectors, vectorBytes: vectors.byteLength, lastUsed: ++clock };
    shards.set(name, shard);
    cachedVectorBytes += vectors.byteLength;
    await writeAtomicText(fs, metaPath(name), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await writeAtomicBinary(fs, vectorPath(name), new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength));
    evictIfNeeded();
    await persistManifest();
  }

  async function persistManifest(): Promise<void> {
    const manifest: Manifest = {
      schema: AI_VECTOR_SCHEMA,
      shards: [...shards.values()].map((shard) => ({ name: shard.name, count: shard.records.length })),
    };
    await writeAtomicText(fs, manifestPath, JSON.stringify(manifest, null, 2));
  }

  /** Indices of records to drop, plus the kept records/vectors. */
  function partition(shard: Shard, vectors: Float32Array, keep: (record: MetaRecord) => boolean): { records: MetaRecord[]; vectors: Float32Array } {
    const records: MetaRecord[] = [];
    const chunks: Float32Array[] = [];
    let cursor = 0;
    for (const record of shard.records) {
      const start = cursor;
      cursor += record.dimension;
      if (keep(record)) {
        records.push(record);
        chunks.push(vectors.subarray(start, cursor));
      }
    }
    return { records, vectors: concat(chunks) };
  }

  const store: AiVectorStore = {
    async upsert(records) {
      if (!records.length) return;
      await ensureLoaded();
      const incoming = new Map<string, AiVectorRecord>();
      for (const record of records) {
        if (!record.id || !record.path || !record.model || record.dimension <= 0) continue;
        if (!(record.vector instanceof Float32Array) || record.vector.length !== record.dimension) {
          throw new Error(`向量维度与记录不一致：${record.path}`);
        }
        incoming.set(record.id, record); // a duplicate id in one batch: last wins
      }
      if (!incoming.size) return;
      const replaced = new Set(incoming.keys());

      // Remove the previous version of every incoming id first. A shard that
      // held a replaced record must be rewritten, and its vectors must be
      // sliced before the new records are appended to some (possibly other)
      // shard.
      for (const shard of [...shards.values()]) {
        if (!shard.records.some((record) => replaced.has(record.id))) continue;
        const vectors = await shardVectors(shard);
        const split = partition(shard, vectors, (record) => !replaced.has(record.id));
        await replaceShard(shard.name, split.records, split.vectors);
      }

      // Append in batches so a shard over the size limit rolls over exactly once.
      let pending: AiVectorRecord[] = [];
      for (const record of incoming.values()) {
        pending.push(record);
        const name = activeShardName();
        const count = shards.get(name)?.records.length ?? 0;
        if (count + pending.length >= shardSize) {
          await appendToShard(name, pending);
          pending = [];
        }
      }
      if (pending.length) await appendToShard(activeShardName(), pending);
      await persistManifest();
    },

    async deleteByPath(paths) {
      await ensureLoaded();
      const wanted = new Set(paths);
      if (!wanted.size) return 0;
      let removed = 0;
      for (const shard of [...shards.values()]) {
        if (!shard.records.some((record) => wanted.has(record.path))) continue;
        const vectors = await shardVectors(shard);
        const kept = partition(shard, vectors, (record) => !wanted.has(record.path));
        removed += shard.records.length - kept.records.length;
        await replaceShard(shard.name, kept.records, kept.vectors);
      }
      await persistManifest();
      return removed;
    },

    async query(query) {
      await ensureLoaded();
      if (!(query.vector instanceof Float32Array) || !query.vector.length) return [];
      const limit = Math.max(1, Math.min(query.limit ?? 10, 200));
      const minSimilarity = query.minSimilarity ?? 0;
      const queryNorm = norm(query.vector);
      if (!queryNorm) return [];
      const hits: AiVectorHit[] = [];
      for (const shard of [...shards.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const vectors = await shardVectors(shard);
        let cursor = 0;
        for (const record of shard.records) {
          const start = cursor;
          cursor += record.dimension;
          if (record.model !== query.model || record.dimension !== query.dimension) continue;
          if (!inScope(record.path, query.scope)) continue;
          const candidate = vectors.subarray(start, cursor);
          const denominator = queryNorm * norm(candidate);
          if (!denominator) continue;
          const similarity = dot(query.vector, candidate) / denominator;
          if (similarity < minSimilarity) continue;
          hits.push({
            id: record.id,
            path: record.path,
            mtime: record.mtime,
            content: record.content,
            similarity,
            metadata: { ...record.metadata },
          });
        }
      }
      hits.sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path));
      return hits.slice(0, limit);
    },

    async stats() {
      await ensureLoaded();
      const models = new Set<string>();
      const dimensions = new Set<number>();
      const files = new Set<string>();
      let chunks = 0;
      let bytes = 0;
      for (const shard of shards.values()) {
        for (const record of shard.records) {
          chunks += 1;
          models.add(record.model);
          dimensions.add(record.dimension);
          files.add(record.path);
          bytes += record.content.length + record.dimension * 4;
        }
      }
      return {
        chunks,
        files: files.size,
        models: [...models],
        dimensions: [...dimensions].sort((a, b) => a - b),
        bytes,
        shards: shards.size,
      };
    },

    async clear(model) {
      await ensureLoaded();
      if (!model) {
        await fs.rmdir(dir);
        shards.clear();
        cachedVectorBytes = 0;
        loaded = false;
        return;
      }
      for (const shard of [...shards.values()]) {
        if (!shard.records.some((record) => record.model === model)) continue;
        const vectors = await shardVectors(shard);
        const kept = partition(shard, vectors, (record) => record.model !== model);
        await replaceShard(shard.name, kept.records, kept.vectors);
      }
      await persistManifest();
    },

    async listPaths() {
      await ensureLoaded();
      const byPath = new Map<string, AiVectorPathInfo>();
      for (const shard of shards.values()) {
        for (const record of shard.records) {
          const prior = byPath.get(record.path);
          if (!prior || record.mtime > prior.mtime) byPath.set(record.path, { path: record.path, mtime: record.mtime, hash: record.hash });
        }
      }
      return [...byPath.values()];
    },

    async isEmpty() {
      await ensureLoaded();
      return shards.size === 0;
    },
  };

  /** Append records (with their vectors) to one shard and persist it. */
  async function appendToShard(name: string, records: readonly AiVectorRecord[]): Promise<void> {
    if (!records.length) return;
    const prior = shards.get(name);
    const priorVectors = prior ? await shardVectors(prior) : new Float32Array(0);
    const recordsNext = [...(prior?.records ?? []), ...records.map(toMeta)];
    const chunks = [priorVectors, ...records.map((record) => record.vector)];
    const vectors = concat(chunks);
    const shard: Shard = { name, records: recordsNext, vectors, vectorBytes: vectors.byteLength, lastUsed: ++clock };
    if (prior?.vectors) cachedVectorBytes -= prior.vectors.byteLength;
    else if (prior) cachedVectorBytes -= 0;
    shards.set(name, shard);
    cachedVectorBytes += vectors.byteLength;
    await writeAtomicText(fs, metaPath(name), recordsNext.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await writeAtomicBinary(fs, vectorPath(name), new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength));
    evictIfNeeded();
  }

  return store;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMeta(record: AiVectorRecord): MetaRecord {
  return {
    id: record.id,
    path: record.path,
    mtime: record.mtime,
    hash: record.hash,
    model: record.model,
    dimension: record.dimension,
    content: record.content,
    metadata: { ...record.metadata },
  };
}

function concat(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function parseManifest(text: string | null): Manifest | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as { schema?: unknown; shards?: unknown };
    if (record.schema !== AI_VECTOR_SCHEMA || !Array.isArray(record.shards)) return null;
    return {
      schema: AI_VECTOR_SCHEMA,
      shards: record.shards
        .filter((item): item is { name: string; count: number } => Boolean(item) && typeof item === "object" && typeof (item as { name?: unknown }).name === "string")
        .map((item) => ({ name: item.name, count: typeof item.count === "number" ? item.count : 0 })),
    };
  } catch {
    return null;
  }
}

function parseRecords(text: string): MetaRecord[] {
  const records: MetaRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<MetaRecord>;
      if (!parsed || typeof parsed.id !== "string" || typeof parsed.path !== "string") continue;
      if (typeof parsed.dimension !== "number" || parsed.dimension <= 0) continue;
      records.push({
        id: parsed.id,
        path: parsed.path,
        mtime: typeof parsed.mtime === "number" ? parsed.mtime : 0,
        hash: typeof parsed.hash === "string" ? parsed.hash : "",
        model: typeof parsed.model === "string" ? parsed.model : "",
        dimension: parsed.dimension,
        content: typeof parsed.content === "string" ? parsed.content : "",
        metadata: { startLine: parsed.metadata?.startLine ?? 0, endLine: parsed.metadata?.endLine ?? 0 },
      });
    } catch {
      // A truncated line from a crash mid-write must not discard the shard.
    }
  }
  return records;
}

function inScope(path: string, scope: AiVectorScope | undefined): boolean {
  if (!scope) return true;
  if (scope.files?.some((file) => file === path)) return true;
  if (scope.folders?.some((folder) => path.startsWith(folder.endsWith("/") ? folder : `${folder}/`))) return true;
  return false;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}

function norm(vector: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) sum += vector[index] * vector[index];
  return Math.sqrt(sum);
}

function normalizeDir(dir: string): string {
  return (dir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "vector";
}

async function writeAtomicText(fs: AiVectorFs, path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await fs.writeText(temporary, text);
  await fs.rename(temporary, path);
}

async function writeAtomicBinary(fs: AiVectorFs, path: string, data: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp`;
  await fs.writeBinary(temporary, data);
  await fs.rename(temporary, path);
}