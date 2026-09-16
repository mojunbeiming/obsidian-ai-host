/**
 * The host's AI settings: one version, one normalizer, one migration chain.
 *
 * ## Why this exists beside `ai.ts`
 *
 * `readAiSettings` in `ai.ts` turns a plugin's flat `aiXxx` keys into one
 * `AiConfig` -- one provider, one endpoint, one credential. That was the whole
 * feature while each plugin owned its own AI pane. The host needs more: several
 * provider rows (a chat model and a cheaper apply model can be different
 * services), per-feature sections that can grow without a new global, and a
 * stored shape that can survive the next release. Adding those fields to
 * `AiConfig` would make every existing consumer pay for every future feature.
 *
 * ## The rules, and where they come from
 *
 * Smart Composer's settings are a discriminated union with a per-field default
 * and sixteen sequential migrations, each with its own test. Three parts of that
 * are worth copying exactly:
 *
 * 1. **Version 1 starts the chain here.** There is no historical baggage to
 *    preserve, so a missing `version` means "the flat legacy shape" rather than
 *    "run sixteen migrations".
 * 2. **Migrations are sequential and independent.** One file-level array, each
 *    entry moving one version to the next. A future 1 -> 2 adds one array row
 *    and one test; it never edits the rows before it.
 * 3. **Normalization is field-by-field.** A `data.json` is a text file the user
 *    can edit, and a hand-edited `temperature: "0.7"` must not turn the whole
 *    settings page blank. Every leaf gets a guard and a default, and only a
 *    value that cannot be read at all falls the whole object back to defaults.
 *
 * ## What is deliberately *not* copied
 *
 * Zod. The runtime dependency buys type inference, not safety -- the guards
 * below are the safety -- and this SDK ships into a plugin bundle where every
 * kilobyte is loaded at startup. `AiSettings` is a TypeScript type; the
 * `Field` helpers and `isRecord` are the runtime check.
 *
 * ## Keys never live here
 *
 * `apiKeyRef` is a secret-storage id, never the credential. The one migration
 * that *sees* a legacy plaintext key drops it (`migrateLegacyFlatSettings`) and
 * the caller moves it to the keychain using `collectLegacyAiSecrets` before that
 * -- see the comment on that function for why the two are separate.
 */

import {
  AI_PROVIDERS,
  authHeaderFor,
  type AiProviderCapability,
  type AiProviderPreset,
  type AiProtocol,
} from "../aiProviders";
import { isPermissionTier, normalizeWorkspaces, type AiPermissionTier, type AiWorkspace } from "./aiWorkspace";

// ---------------------------------------------------------------------------
// Version and shape
// ---------------------------------------------------------------------------

/** The current settings schema. Bump by adding a migration, never by editing one. */
export const AI_SETTINGS_VERSION = 1;

/** Which optional capabilities the settings UI is allowed to offer. */
export const AI_CAPABILITIES: readonly AiProviderCapability[] = [
  "stream",
  "tools",
  "vision",
  "reasoning",
  "embeddings",
  "json",
];

/** One provider row the user can point the host at. */
export interface AiProviderEntry {
  /** Stable id: a preset id, or a user-chosen id for an added provider. */
  id: string;
  label: string;
  protocol: AiProtocol;
  /** Empty means "use the preset's address". */
  baseUrl: string;
  /** The default model for this provider, bare (no `provider/` prefix). */
  model: string;
  /** Extra models offered in pickers, beyond `model`. */
  models: string[];
  /** Resolved header name; empty means the provider sends no credential. */
  authHeader: string;
  /** Prefixed to the key, e.g. `Bearer `. */
  authPrefix: string;
  /**
   * The secret-storage id that holds this provider's credential.
   *
   * An id, never a value: `data.json` is synced, backed up and screenshotted,
   * and a key in it is a key published. The id is derivable
   * (`secretIdForProvider`) so a user who moves their vault still finds it.
   */
  apiKeyRef: string;
  /** Headers every request must carry, e.g. a vendor API version. */
  extraHeaders: Record<string, string>;
  local: boolean;
  enabled: boolean;
  /** User-added row rather than a preset, so a preset update must not remove it. */
  userAdded: boolean;
  capabilities: AiProviderCapability[];
}

/** The chat section: what a conversation sends and how. */
export interface AiChatSettings {
  /** Empty means "the default preset in the table". */
  providerId: string;
  /** Empty means "the provider's default model". */
  model: string;
  /** Appended to the built-in system prompt. */
  systemPrompt: string;
  temperature: number;
  /** How many history turns are kept; the Smart Composer number is 20. */
  maxContextMessages: number;
  /** Whether the current note is attached by default. */
  includeCurrentFile: boolean;
  stream: boolean;
  timeoutMs: number;
  maxImages: number;
  /** Vault folder the `/` template picker reads; empty disables templates. */
  templatesFolder: string;
  /** Enter sends, Shift+Enter inserts a newline. Off swaps the two. */
  sendOnEnter: boolean;
  /** Workbench sidebar width in px, dragged by the user and persisted. */
  sidebarWidth: number;
  /** Whether the workbench sidebar starts collapsed. */
  sidebarCollapsed: boolean;
}

/** The apply section: whole-file rewrites use their own (cheaper) slot. */
export interface AiApplySettings {
  providerId: string;
  model: string;
}

/** The RAG section: off by default, local by default. */
export interface AiRagSettings {
  enabled: boolean;
  embeddingProviderId: string;
  embeddingModel: string;
  /** Characters per chunk, not tokens: token counting is what the reference implementation avoided too. */
  chunkSize: number;
  chunkOverlap: number;
  /** Above this many prompt tokens, a chat switches to retrieval. */
  thresholdTokens: number;
  minSimilarity: number;
  limit: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  /** How long after a vault edit the background indexer waits. */
  debounceMs: number;
  /** Chunks embedded per batch. */
  batchSize: number;
}

/** The tools section: off until some read-only tool is explicitly enabled. */
export interface AiToolsSettings {
  enabled: boolean;
  /** 1 means "the model may ask for one tool call, then the user decides". */
  maxAutoIterations: number;
  /** Tool names auto-allowed for this vault. Destructive tools never belong here. */
  autoAllowed: string[];
}

export type AiLogLevel = "off" | "error" | "normal" | "verbose";

/** How much of a run is kept, and for how long. Local files only; nothing is uploaded. */
export interface AiLoggingSettings {
  level: AiLogLevel;
  /** Runs kept per plugin before the oldest are pruned. */
  keepRuns: number;
  /** Days a run stays on disk regardless of the count. */
  keepDays: number;
  /** Total size ceiling for the run directory. */
  maxBytesMB: number;
  /** Off by default: full prompts and replies may contain note text. */
  recordFullPayload: boolean;
  /** Show running/failed in the status bar. */
  statusBar: boolean;
}

/**
 * The permission section: one global ceiling plus the two `full`-tier rules.
 *
 * `globalMax` exists for the cautious case -- a user who wants the agent but
 * does not want any workspace to ever reach `full`. It is enforced in
 * `resolvePermission`, not in the picker, so a hand-edited settings file cannot
 * raise it back.
 */
export interface AiPermissionSettings {
  /** No workspace may exceed this tier. `full` means "no ceiling". */
  globalMax: AiPermissionTier;
  /** How long a `full`/`trusted` grant lasts before dropping back to `standard`. */
  fullExpiryMinutes: number;
  /** `full` still confirms destructive tools unless the user turns this off. */
  confirmDestructiveInFull: boolean;
}

/** The agent section: the four ceilings and the mode switch. */
export interface AiAgentSettings {
  /** The composer's Agent chip defaults to this; off until the user asks for it. */
  enabled: boolean;
  maxSteps: number;
  maxTokens: number;
  maxWallMinutes: number;
  /** 0 means "no cost ceiling"; a priced model stops at the number when set. */
  maxCostUsd: number;
  /** Keep executing after an approval instead of pausing for a fresh message. */
  continueAfterApproval: boolean;
}

/** Privacy acknowledgements, recorded so the prompt is not shown again every launch. */
export interface AiPrivacySettings {
  /** The user has seen that remote embeddings send note text to a service. */
  remoteEmbeddingAcknowledged: boolean;
}

/** The whole stored object. */
export interface AiSettings {
  version: number;
  providers: AiProviderEntry[];
  chat: AiChatSettings;
  apply: AiApplySettings;
  rag: AiRagSettings;
  tools: AiToolsSettings;
  privacy: AiPrivacySettings;
  logging: AiLoggingSettings;
  /** Folder-scoped workspaces. Empty means the whole vault as one scope. */
  workspaces: AiWorkspace[];
  /** The workspace a new conversation belongs to; empty means "未分组". */
  defaultWorkspaceId: string;
  permission: AiPermissionSettings;
  agent: AiAgentSettings;
}

/** A fresh, fully defaulted object. Fresh arrays each call: callers mutate settings. */
export function defaultAiSettings(): AiSettings {
  return {
    version: AI_SETTINGS_VERSION,
    providers: [],
    chat: {
      providerId: "",
      model: "",
      systemPrompt: "",
      temperature: 0.7,
      maxContextMessages: 20,
      includeCurrentFile: true,
      stream: true,
      timeoutMs: 120_000,
      maxImages: 6,
      templatesFolder: "Templates",
      sendOnEnter: true,
      sidebarWidth: 260,
      sidebarCollapsed: false,
    },
    apply: { providerId: "", model: "" },
    rag: {
      enabled: false,
      embeddingProviderId: "",
      embeddingModel: "",
      chunkSize: 1000,
      chunkOverlap: 100,
      thresholdTokens: 6000,
      minSimilarity: 0,
      limit: 10,
      includeGlobs: ["**/*.md"],
      excludeGlobs: [".obsidian/**", "**/*.excalidraw.md", "**/*.canvas"],
      debounceMs: 8000,
      batchSize: 50,
    },
    tools: { enabled: false, maxAutoIterations: 1, autoAllowed: [] },
    privacy: { remoteEmbeddingAcknowledged: false },
    logging: { level: "normal", keepRuns: 100, keepDays: 14, maxBytesMB: 20, recordFullPayload: false, statusBar: true },
    workspaces: [],
    defaultWorkspaceId: "",
    permission: { globalMax: "full", fullExpiryMinutes: 60, confirmDestructiveInFull: true },
    agent: { enabled: false, maxSteps: 12, maxTokens: 100_000, maxWallMinutes: 10, maxCostUsd: 0, continueAfterApproval: true },
  };
}

// ---------------------------------------------------------------------------
// Small typed readers
// ---------------------------------------------------------------------------

/** A plain JSON object, which is the only shape a settings file may be. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

interface NumberBounds {
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * A finite number inside its bounds, or the default.
 *
 * Deliberately strict about strings: `"0.7"` is what a hand-edited JSON file
 * produces, and coercing it would mean the difference between "the user changed
 * this" and "the parser guessed" is invisible. A wrong temperature is a
 * diagnosis; a silently coerced one is a mystery.
 */
function readNumber(value: unknown, fallback: number, bounds: NumberBounds = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  let result = bounds.integer ? Math.round(value) : value;
  if (bounds.min !== undefined) result = Math.max(bounds.min, result);
  if (bounds.max !== undefined) result = Math.min(bounds.max, result);
  return result;
}

/** An array of non-empty trimmed strings, with duplicates removed and a length cap. */
function readStringArray(value: unknown, options: { max?: number; lowercase?: boolean } = {}): string[] {
  if (!Array.isArray(value)) return [];
  const max = options.max ?? 100;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = options.lowercase ? item.trim().toLowerCase() : item.trim();
    if (!text || text.length > 512) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** A header map with control characters removed: a newline in a value is header injection. */
function readHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue;
    const name = key.trim().slice(0, 200);
    const text = raw.replace(/[\r\n]+/g, " ").trim().slice(0, 4096);
    if (!name || !text) continue;
    out[name] = text;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider rows and the default-preset merge
// ---------------------------------------------------------------------------

/**
 * Deep-merge `patch` over `base`, returning a fresh value.
 *
 * Written because Smart Composer's `Object.assign(existing, default)` was noted
 * in its own source as a bug: it replaces a user's nested `reasoning` object
 * with the preset's defaults, so the user's setting is silently lost. Here a
 * plain object is merged key by key; an array and every scalar are replaced
 * (merging arrays positionally is how two lists become one nonsense list); and
 * `undefined`/`null` in the patch means "not set", so a half-written record
 * cannot erase a default.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return cloneValue(base);
  if (!isRecord(base) || !isRecord(patch)) return cloneValue(patch) as T;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) out[key] = cloneValue(value);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    out[key] = isRecord(value) && isRecord(out[key]) ? deepMerge(out[key], value) : cloneValue(value);
  }
  return out as T;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item);
    return out as T;
  }
  return value;
}

/**
 * Merge the preset table into the stored rows, the way Smart Composer updates
 * its built-in providers and models.
 *
 * The rules, in order:
 *
 * * every default comes first, in table order, so a new release that adds a
 *   provider offers it without the user doing anything;
 * * a stored row with the same id overrides the default **deeply**, so the
 *   user's `baseUrl` and nested option survive a release that adds a new
 *   default field;
 * * stored rows with no matching default are appended, because a provider the
 *   user added is not the table's to delete.
 */
export function mergeDefaultPresets<T extends { id: string }>(
  existing: readonly T[] | undefined,
  defaults: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const entry of defaults) byId.set(entry.id, cloneValue(entry));
  for (const entry of existing ?? []) {
    if (!isRecord(entry) || typeof (entry as { id?: unknown }).id !== "string") continue;
    const id = (entry as { id: string }).id;
    const prior = byId.get(id);
    byId.set(id, prior ? deepMerge(prior, entry) : cloneValue(entry));
  }
  return [...byId.values()];
}

/**
 * A secret-storage id for a provider.
 *
 * Obsidian's `secretStorage` accepts lowercase alphanumerics and dashes only, so
 * a provider id from the table (or a user's custom id with a space in it) is
 * sanitized rather than passed through. Stable by construction: the same
 * provider always maps to the same secret id, which is what lets a migration
 * write an id without reading the keychain.
 */
export function secretIdForProvider(providerId: string): string {
  const cleaned = providerId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `sfc-ai-${cleaned || "provider"}`;
}

/** One preset as a stored row, with its auth resolved from the table. */
export function providerEntryFromPreset(preset: AiProviderPreset): AiProviderEntry {
  const auth = authHeaderFor(preset);
  return {
    id: preset.id,
    label: preset.label,
    protocol: preset.kind,
    baseUrl: preset.baseUrl,
    model: preset.model,
    models: [],
    authHeader: auth.header,
    authPrefix: auth.prefix,
    apiKeyRef: secretIdForProvider(preset.id),
    extraHeaders: preset.extraHeaders ? { ...preset.extraHeaders } : {},
    local: preset.local,
    enabled: true,
    userAdded: false,
    capabilities: [...preset.capabilities],
  };
}

/** Every built-in row, as stored rows. */
export function presetProviderEntries(): AiProviderEntry[] {
  return AI_PROVIDERS.map((preset) => providerEntryFromPreset(preset));
}

/** Stored rows merged over the built-in rows: what the UI and the transport use. */
export function resolveProviders(settings: AiSettings): AiProviderEntry[] {
  return mergeDefaultPresets(settings.providers, presetProviderEntries());
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function readProtocol(value: unknown, fallback: AiProtocol): AiProtocol {
  return value === "openai" || value === "anthropic" || value === "gemini" || value === "dsh" ? value : fallback;
}

function readCapabilities(value: unknown): AiProviderCapability[] {
  const allowed = new Set<string>(AI_CAPABILITIES);
  if (!Array.isArray(value)) return [];
  const out: AiProviderCapability[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const capability = item.trim().toLowerCase();
    if (!allowed.has(capability) || out.includes(capability as AiProviderCapability)) continue;
    out.push(capability as AiProviderCapability);
  }
  return out;
}

/**
 * One provider row, or `null` when there is no usable id.
 *
 * `apiKey` (a plaintext field some early build may have written) is discarded
 * here rather than copied to a ref: the settings object must never be able to
 * contain a credential, or the next person to export diagnostics leaks it.
 * `collectLegacyAiSecrets` is the only reader of that field, and it is called
 * before this normalizer sees the object.
 */
function normalizeProviderEntry(raw: unknown): AiProviderEntry | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw.id);
  if (!id) return null;
  const preset = AI_PROVIDERS.find((entry) => entry.id === id) ?? null;
  const protocol = readProtocol(raw.protocol, preset?.kind ?? "openai");
  const resolved = preset ? authHeaderFor(preset, { header: readString(raw.authHeader), prefix: readString(raw.authPrefix) }) : null;
  const extraHeaders = readHeaders(raw.extraHeaders);
  return {
    id,
    label: readString(raw.label) || preset?.label || id,
    protocol,
    baseUrl: readString(raw.baseUrl),
    model: readString(raw.model),
    models: readStringArray(raw.models),
    authHeader: readString(raw.authHeader) || resolved?.header || "",
    authPrefix: typeof raw.authPrefix === "string" ? raw.authPrefix : resolved?.prefix ?? "",
    apiKeyRef: readString(raw.apiKeyRef) || secretIdForProvider(id),
    extraHeaders: preset?.extraHeaders ? { ...preset.extraHeaders, ...extraHeaders } : extraHeaders,
    local: readBoolean(raw.local, preset?.local ?? false),
    enabled: readBoolean(raw.enabled, true),
    userAdded: readBoolean(raw.userAdded, !preset),
    capabilities: readCapabilities(raw.capabilities).length
      ? readCapabilities(raw.capabilities)
      : preset
        ? [...preset.capabilities]
        : [],
  };
}

function normalizeProviders(raw: unknown): AiProviderEntry[] {
  if (!Array.isArray(raw)) return [];
  // Merge the raw rows first, then normalize once. Normalizing before the merge
  // would fill an absent label with the id, and that synthesized value would
  // then win over the label on the row it is supposed to be merged into -- so a
  // duplicate row would silently rename the provider.
  const merged: { id: string; raw: Record<string, unknown> }[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = readString(item.id);
    if (!id) continue;
    const prior = merged.find((entry) => entry.id === id);
    if (prior) prior.raw = deepMerge(prior.raw, item);
    else merged.push({ id, raw: { ...item } });
  }
  const out: AiProviderEntry[] = [];
  for (const entry of merged) {
    const normalized = normalizeProviderEntry(entry.raw);
    if (normalized) out.push(normalized);
  }
  return out;
}
function normalizeChat(raw: unknown): AiChatSettings {
  const d = defaultAiSettings().chat;
  if (!isRecord(raw)) return d;
  return {
    providerId: readString(raw.providerId),
    model: readString(raw.model),
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : d.systemPrompt,
    temperature: readNumber(raw.temperature, d.temperature, { min: 0, max: 2 }),
    maxContextMessages: readNumber(raw.maxContextMessages, d.maxContextMessages, { min: 1, max: 200, integer: true }),
    includeCurrentFile: readBoolean(raw.includeCurrentFile, d.includeCurrentFile),
    stream: readBoolean(raw.stream, d.stream),
    timeoutMs: readNumber(raw.timeoutMs, d.timeoutMs, { min: 5000, max: 600_000, integer: true }),
    maxImages: readNumber(raw.maxImages, d.maxImages, { min: 0, max: 20, integer: true }),
    templatesFolder: readString(raw.templatesFolder).replace(/^\/+|\/+$/g, "") || d.templatesFolder,
    sendOnEnter: readBoolean(raw.sendOnEnter, d.sendOnEnter),
    sidebarWidth: readNumber(raw.sidebarWidth, d.sidebarWidth, { min: 180, max: 480, integer: true }),
    sidebarCollapsed: readBoolean(raw.sidebarCollapsed, d.sidebarCollapsed),
  };
}

function normalizeApply(raw: unknown): AiApplySettings {
  const d = defaultAiSettings().apply;
  if (!isRecord(raw)) return d;
  return { providerId: readString(raw.providerId), model: readString(raw.model) };
}

function normalizeRag(raw: unknown): AiRagSettings {
  const d = defaultAiSettings().rag;
  if (!isRecord(raw)) return d;
  const chunkSize = readNumber(raw.chunkSize, d.chunkSize, { min: 100, max: 8000, integer: true });
  // Overlap must be strictly below the chunk size or a chunker can fail to
  // advance; clamping to the default rather than to `chunkSize - 1` keeps a
  // nonsense pair (chunkSize: 100, overlap: 7900) from becoming valid-looking.
  const chunkOverlap = readNumber(raw.chunkOverlap, d.chunkOverlap, { min: 0, max: chunkSize - 1, integer: true });
  return {
    enabled: readBoolean(raw.enabled, d.enabled),
    embeddingProviderId: readString(raw.embeddingProviderId),
    embeddingModel: readString(raw.embeddingModel),
    chunkSize,
    chunkOverlap,
    thresholdTokens: readNumber(raw.thresholdTokens, d.thresholdTokens, { min: 0, max: 1_000_000, integer: true }),
    minSimilarity: readNumber(raw.minSimilarity, d.minSimilarity, { min: 0, max: 1 }),
    limit: readNumber(raw.limit, d.limit, { min: 1, max: 100, integer: true }),
    includeGlobs: readStringArray(raw.includeGlobs, { max: 100 }),
    excludeGlobs: readStringArray(raw.excludeGlobs, { max: 100 }),
    debounceMs: readNumber(raw.debounceMs, d.debounceMs, { min: 0, max: 120_000, integer: true }),
    batchSize: readNumber(raw.batchSize, d.batchSize, { min: 1, max: 500, integer: true }),
  };
}

function normalizeTools(raw: unknown): AiToolsSettings {
  const d = defaultAiSettings().tools;
  if (!isRecord(raw)) return d;
  return {
    // Tools stay off unless the stored object says otherwise. A missing field on
    // an upgrade must never enable something with side effects.
    enabled: readBoolean(raw.enabled, false),
    maxAutoIterations: readNumber(raw.maxAutoIterations, d.maxAutoIterations, { min: 1, max: 10, integer: true }),
    autoAllowed: readStringArray(raw.autoAllowed, { max: 50 }),
  };
}

function normalizePrivacy(raw: unknown): AiPrivacySettings {
  const d = defaultAiSettings().privacy;
  if (!isRecord(raw)) return d;
  return { remoteEmbeddingAcknowledged: readBoolean(raw.remoteEmbeddingAcknowledged, false) };
}

function normalizeLogging(raw: unknown): AiLoggingSettings {
  const d = defaultAiSettings().logging;
  if (!isRecord(raw)) return d;
  const level: AiLogLevel = raw.level === "off" || raw.level === "error" || raw.level === "verbose" ? raw.level : "normal";
  return {
    level,
    keepRuns: readNumber(raw.keepRuns, d.keepRuns, { min: 10, max: 1000, integer: true }),
    keepDays: readNumber(raw.keepDays, d.keepDays, { min: 1, max: 365, integer: true }),
    maxBytesMB: readNumber(raw.maxBytesMB, d.maxBytesMB, { min: 1, max: 500, integer: true }),
    recordFullPayload: readBoolean(raw.recordFullPayload, false),
    statusBar: readBoolean(raw.statusBar, true),
  };
}

function normalizePermission(raw: unknown): AiPermissionSettings {
  const d = defaultAiSettings().permission;
  if (!isRecord(raw)) return d;
  return {
    // A missing ceiling must never *raise* a workspace's permission: the
    // default is "no ceiling", which is the stored setting, not a grant.
    globalMax: isPermissionTier(raw.globalMax) ? raw.globalMax : d.globalMax,
    fullExpiryMinutes: readNumber(raw.fullExpiryMinutes, d.fullExpiryMinutes, { min: 5, max: 480, integer: true }),
    confirmDestructiveInFull: readBoolean(raw.confirmDestructiveInFull, d.confirmDestructiveInFull),
  };
}

function normalizeAgent(raw: unknown): AiAgentSettings {
  const d = defaultAiSettings().agent;
  if (!isRecord(raw)) return d;
  return {
    enabled: readBoolean(raw.enabled, d.enabled),
    maxSteps: readNumber(raw.maxSteps, d.maxSteps, { min: 1, max: 100, integer: true }),
    maxTokens: readNumber(raw.maxTokens, d.maxTokens, { min: 1000, max: 2_000_000, integer: true }),
    maxWallMinutes: readNumber(raw.maxWallMinutes, d.maxWallMinutes, { min: 1, max: 240, integer: true }),
    maxCostUsd: readNumber(raw.maxCostUsd, d.maxCostUsd, { min: 0, max: 1000 }),
    continueAfterApproval: readBoolean(raw.continueAfterApproval, d.continueAfterApproval),
  };
}

/**
 * Every field of a stored object, with a default behind each one.
 *
 * Never throws and never returns a partial object: the settings page can render
 * the result without a single further guard. Callers that need to know *why* a
 * value was discarded should use `migrateAiSettingsDetailed`, whose report
 * names the versions and warnings rather than each field.
 */
export function normalizeAiSettings(raw: unknown): AiSettings {
  if (!isRecord(raw)) return defaultAiSettings();
  return {
    version: AI_SETTINGS_VERSION,
    providers: normalizeProviders(raw.providers),
    chat: normalizeChat(raw.chat),
    apply: normalizeApply(raw.apply),
    rag: normalizeRag(raw.rag),
    tools: normalizeTools(raw.tools),
    privacy: normalizePrivacy(raw.privacy),
    logging: normalizeLogging(raw.logging),
    workspaces: normalizeWorkspaces(raw.workspaces),
    defaultWorkspaceId: readString(raw.defaultWorkspaceId),
    permission: normalizePermission(raw.permission),
    agent: normalizeAgent(raw.agent),
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** One step in the chain. `migrate` receives and returns a raw object. */
export interface AiSettingsMigration {
  from: number;
  to: number;
  /** Shown in the migration report, so a failed upgrade says which step failed. */
  describe: string;
  migrate(raw: Record<string, unknown>): Record<string, unknown>;
}

/**
 * The flat keys earlier plugin releases stored, and what they mean.
 *
 * Kept as data so the migration and `collectLegacyAiSecrets` cannot disagree
 * about the spelling of a key: a rename here is a compile error there.
 */
const LEGACY_KEYS = {
  provider: "aiProvider",
  storedFor: "aiStoredFor",
  baseUrl: "aiBaseUrl",
  protocol: "aiProtocol",
  model: "aiModel",
  apiKey: "aiApiKey",
  authHeader: "aiAuthHeader",
  authPrefix: "aiAuthPrefix",
  timeoutMs: "aiTimeoutMs",
  supportsImages: "aiSupportsImages",
  maxImages: "aiMaxImages",
} as const;

/**
 * 0 -> 1: the flat plugin keys become the structured host settings.
 *
 * The `storedFor` rule is copied from `readAiSettings` on purpose. A stored
 * address and model belong to the provider that was selected when they were
 * saved; if a different provider is selected now they are leftovers from
 * another service, and honouring them is how "DeepSeek 官方 API" ends up
 * pointed at `127.0.0.1:3080`. Absence of the marker is treated as "different
 * provider", because the unmarked values predate the field and cannot be
 * trusted to belong to the current selection.
 *
 * The plaintext key is dropped here, not moved: this function is pure and must
 * stay callable from a test. `collectLegacyAiSecrets` reads it from the original
 * object before migration, and the host writes it to `secretStorage`.
 */
export function migrateLegacyFlatSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const legacy = (key: keyof typeof LEGACY_KEYS): unknown => raw[LEGACY_KEYS[key]];
  const providerId = readString(legacy("provider")) || "deepseek";
  const storedFor = readString(legacy("storedFor"));
  // `custom` keeps its overrides even without a marker, because every part of a
  // custom endpoint is user-entered and there is no preset to fall back to.
  const trusted = providerId === "custom" || storedFor === providerId;
  const keep = <T>(value: T, fallback: T): T => (trusted ? value : fallback);

  const baseUrl = keep(readString(legacy("baseUrl")), "");
  const model = keep(readString(legacy("model")), "");
  const protocol = keep(readString(legacy("protocol")), "");
  const authHeader = keep(readString(legacy("authHeader")), "");
  const authPrefix = keep(typeof legacy("authPrefix") === "string" ? String(legacy("authPrefix")) : "", "");
  const supportsImages = legacy("supportsImages") === true;
  const timeoutMs = readNumber(legacy("timeoutMs"), 120_000, { min: 5000, max: 600_000, integer: true });
  const maxImages = readNumber(legacy("maxImages"), 6, { min: 1, max: 20, integer: true });

  const hasOverride = Boolean(baseUrl || model || protocol || authHeader || authPrefix || supportsImages);
  const provider: Record<string, unknown> = { id: providerId, apiKeyRef: secretIdForProvider(providerId) };
  if (baseUrl) provider.baseUrl = baseUrl;
  if (model) provider.model = model;
  if (protocol === "openai" || protocol === "anthropic" || protocol === "gemini" || protocol === "dsh") provider.protocol = protocol;
  if (authHeader || authPrefix) {
    provider.authHeader = authHeader;
    provider.authPrefix = authPrefix;
  }
  if (supportsImages) provider.capabilities = ["vision"];

  const priorProviders = Array.isArray(raw.providers) ? raw.providers : [];
  const priorChat = isRecord(raw.chat) ? raw.chat : {};
  const out: Record<string, unknown> = {
    ...raw,
    version: 1,
    providers: hasOverride ? [...priorProviders, provider] : priorProviders,
    chat: {
      ...priorChat,
      providerId: readString(priorChat.providerId) || providerId,
      // An existing structured model wins; the flat key is the fallback.
      model: readString(priorChat.model) || model,
      timeoutMs: readNumber(priorChat.timeoutMs, timeoutMs, { min: 5000, max: 600_000, integer: true }),
      maxImages: readNumber(priorChat.maxImages, maxImages, { min: 1, max: 20, integer: true }),
    },
  };
  // The credential is not copied into the settings shape at any depth.
  delete out[LEGACY_KEYS.apiKey];
  return out;
}

/**
 * The whole chain, oldest first.
 *
 * A future release appends `{from: 1, to: 2, ...}` here. It never edits this
 * row: a user upgrading from 0 must run both, and a migration that was rewritten
 * to run from 1 silently skips everyone who has not upgraded yet.
 */
export const AI_SETTINGS_MIGRATIONS: readonly AiSettingsMigration[] = [
  {
    from: 0,
    to: 1,
    describe: "把插件 data.json 的扁平 AI 键（aiProvider/aiBaseUrl/）导入宿主设置",
    migrate: migrateLegacyFlatSettings,
  },
];

/** What the migration did, for diagnostics and tests. */
export interface AiSettingsMigrationReport {
  fromVersion: number;
  toVersion: number;
  /** One line per migration that actually ran. */
  applied: string[];
  /** Stable codes, not prose: `version_ahead`, `no_migration_path`, `migration_failed:<message>`. */
  warnings: string[];
  /** True when nothing could be recovered and defaults were returned. */
  fellBack: boolean;
}

/** Both halves, for callers that report as well as use. */
export interface AiSettingsMigrationOutcome {
  settings: AiSettings;
  report: AiSettingsMigrationReport;
}

/**
 * The version a raw object claims.
 *
 * Anything that is not a finite non-negative integer -- including a missing
 * field -- reads as 0, the legacy shape. That is deliberately the permissive
 * direction for a *file*: an unversioned object is much more likely to be an
 * old one than to be corrupt in exactly the `version` field.
 */
export function settingsVersionOf(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  const version = raw.version;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
}

/**
 * Run the chain, then normalize.
 *
 * A migration that throws means the shape is no longer the one it was written
 * for, and continuing would build a settings object out of a half-migrated
 * record. The fallback is the whole default object plus a warning: the user gets
 * a working settings page and can re-enter the handful of fields, which is
 * strictly better than a page that throws on every render.
 */
export function migrateAiSettingsDetailed(raw: unknown): AiSettingsMigrationOutcome {
  const fromVersion = settingsVersionOf(raw);
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    if (raw !== undefined && raw !== null) warnings.push("not_an_object");
    return {
      settings: defaultAiSettings(),
      report: { fromVersion, toVersion: AI_SETTINGS_VERSION, applied: [], warnings, fellBack: raw !== undefined && raw !== null },
    };
  }
  if (fromVersion > AI_SETTINGS_VERSION) {
    // A file written by a newer release. Read what is known rather than
    // discarding the user's rows; an unknown future field is dropped by the
    // normalizer, and the warning tells diagnostics why.
    warnings.push("version_ahead");
    return {
      settings: normalizeAiSettings(raw),
      report: { fromVersion, toVersion: AI_SETTINGS_VERSION, applied: [], warnings, fellBack: false },
    };
  }

  let current: Record<string, unknown> = raw;
  let version = fromVersion;
  const applied: string[] = [];
  try {
    for (const migration of AI_SETTINGS_MIGRATIONS) {
      if (version >= migration.to) continue;
      if (version !== migration.from) continue;
      current = migration.migrate(current);
      applied.push(migration.describe);
      version = migration.to;
    }
  } catch (error) {
    warnings.push(`migration_failed:${error instanceof Error ? error.message : String(error)}`);
    return {
      settings: defaultAiSettings(),
      report: { fromVersion, toVersion: AI_SETTINGS_VERSION, applied, warnings, fellBack: true },
    };
  }
  if (version < AI_SETTINGS_VERSION) warnings.push("no_migration_path");
  return {
    settings: normalizeAiSettings(current),
    report: { fromVersion, toVersion: AI_SETTINGS_VERSION, applied, warnings, fellBack: false },
  };
}

/** The settings, with no report: the common call. */
export function migrateAiSettings(raw: unknown): AiSettings {
  return migrateAiSettingsDetailed(raw).settings;
}

// ---------------------------------------------------------------------------
// Legacy credentials
// ---------------------------------------------------------------------------

/** One credential found in an old settings file, and the provider it belonged to. */
export interface AiLegacySecret {
  providerId: string;
  apiKey: string;
}

/**
 * Find plaintext keys in a legacy settings object.
 *
 * Separate from the migration because the directions differ: settings are pure
 * data that any test may build, while a key has to be *removed* from the file
 * and *written* to the keychain, and the write is host API. The host calls this
 * on the same raw object it hands to `migrateAiSettings`, moves what comes back
 * to `secretStorage`, then saves the migrated object -- which no longer contains
 * the key at all.
 *
 * Both shapes are searched: the flat `aiApiKey` the shipped plugins use, and a
 * per-provider `apiKey` that an intermediate build may have written before
 * `apiKeyRef` existed.
 */
export function collectLegacyAiSecrets(raw: unknown): AiLegacySecret[] {
  if (!isRecord(raw)) return [];
  const out: AiLegacySecret[] = [];
  const add = (providerId: string, value: unknown): void => {
    const apiKey = typeof value === "string" ? value.trim() : "";
    if (!apiKey) return;
    const id = providerId.trim() || "deepseek";
    if (out.some((entry) => entry.providerId === id)) return;
    out.push({ providerId: id, apiKey });
  };
  add(readString(raw[LEGACY_KEYS.provider]) || "deepseek", raw[LEGACY_KEYS.apiKey]);
  if (Array.isArray(raw.providers)) {
    for (const entry of raw.providers) {
      if (!isRecord(entry)) continue;
      add(readString(entry.id), entry.apiKey);
    }
  }
  return out;
}