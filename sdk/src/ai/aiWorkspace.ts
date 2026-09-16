/**
 * Workspaces and the four permission tiers.
 *
 * ## What a workspace is
 *
 * A folder-scoped sandbox with its own default model and RAG switch. The vault
 * has one index; a workspace narrows *which paths a tool may touch* and *what
 * the model sees by default*. It is the answer to "the agent can read my whole
 * vault" -- the boundary lives in one pure predicate that every tool, the `@`
 * picker and the retrieval scope call before they touch a path.
 *
 * ## Why permissions are a table, not booleans
 *
 * `manual / standard / trusted / full` are the four states a user can reason
 * about, and each is a *policy* rather than a set of flags:
 *
 * | 档位     | 读       | 写       | 删除/移动 |
 * |----------|----------|----------|-----------|
 * | manual   | 每次确认 | 每次确认 | 每次确认  |
 * | standard | 自动     | 确认     | 确认      |
 * | trusted  | 自动     | 自动     | 确认      |
 * | full     | 自动     | 自动     | 默认确认* |
 *
 * (*) `full` may auto-run a delete only when the user explicitly turns
 * `confirmDestructiveInFull` off; the default is still confirmation. A tier is
 * never a bypass of the sandbox, the backup or the audit -- those are separate
 * mechanisms that `decidePermission` cannot disable.
 *
 * ## Expiry and the global ceiling
 *
 * `full`/`trusted` are grants, not settings: `permissionExpiresAt` puts them
 * back to `standard` when it passes, and `globalMax` (a settings switch for
 * cautious users) caps every workspace below its own tier. Both are folded into
 * `effectivePermissionTier`, so a stale grant cannot be read from the record by
 * accident -- the raw field is never consulted on its own.
 *
 * Pure: values in, values out, no Obsidian, no clock of its own.
 */

import { isPathIncluded, matchGlob, normalizeVaultPath } from "./aiGlob";

/** The four tiers, least to most capable. Order is meaningful: `permissionRank`. */
export type AiPermissionTier = "manual" | "standard" | "trusted" | "full";

export const AI_PERMISSION_TIERS: readonly AiPermissionTier[] = ["manual", "standard", "trusted", "full"];

/** What a tool does, for the permission table. */
export type AiToolEffect = "read" | "write" | "destructive";

/** `allow` runs it, `confirm` asks, `deny` refuses without asking. */
export type AiPermissionDecision = "allow" | "confirm" | "deny";

export interface AiPermissionPolicy {
  /** Settings switch: no workspace may exceed this tier. */
  globalMax?: AiPermissionTier;
  /** `full` still confirms destructive tools unless this is explicitly false. */
  confirmDestructiveInFull?: boolean;
}

/**
 * A workspace, as stored in the host settings.
 *
 * `folders` is a whitelist of vault path prefixes. Empty means the whole vault,
 * which is allowed but never the default the UI offers: an empty scope is
 * indistinguishable from "I did not finish configuring this".
 */
export interface AiWorkspace {
  id: string;
  name: string;
  /** Vault-relative folders the workspace may touch. Empty = whole vault. */
  folders: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  /** Empty follows the host's default chat provider. */
  providerId?: string;
  model?: string;
  permission: AiPermissionTier;
  /** When set, a stale grant drops to `standard` instead of staying open. */
  permissionExpiresAt?: number;
  rag: "inherit" | "off" | "on";
  createdAt: number;
  updatedAt: number;
}

/** A workspace's permission after expiry and the global ceiling are applied. */
export interface AiPermissionResolution {
  tier: AiPermissionTier;
  /** The raw tier before clamping/expiry, for the UI to explain what happened. */
  declared: AiPermissionTier;
  expired: boolean;
  capped: boolean;
}

export function isPermissionTier(value: unknown): value is AiPermissionTier {
  return typeof value === "string" && (AI_PERMISSION_TIERS as readonly string[]).includes(value);
}

export function permissionRank(tier: AiPermissionTier): number {
  return AI_PERMISSION_TIERS.indexOf(tier);
}

/** The lower of two tiers. Used for the global ceiling. */
export function clampPermissionTier(tier: AiPermissionTier, max: AiPermissionTier | undefined): AiPermissionTier {
  if (!max) return tier;
  return permissionRank(tier) <= permissionRank(max) ? tier : max;
}

const PERMISSION_LABELS: Record<AiPermissionTier, string> = {
  manual: "手动",
  standard: "标准",
  trusted: "受信",
  full: "完全权限",
};

export function permissionLabel(tier: AiPermissionTier): string {
  return PERMISSION_LABELS[tier] ?? tier;
}

/** One-line explanation of a tier, shown next to the picker. */
export function permissionDescription(tier: AiPermissionTier): string {
  switch (tier) {
    case "manual":
      return "每次读写都先询问。";
    case "standard":
      return "读取自动执行；写入与删除需要确认。";
    case "trusted":
      return "读写自动执行；删除与移动仍然确认。";
    case "full":
      return "写入不再逐个确认；删除与移动默认仍确认，越界路径一律拒绝。";
  }
}

/**
 * The permission table. `policy` can only lower the outcome, never raise it:
 * a `full` tier with `globalMax: "standard"` decides as `standard`.
 */
export function decidePermission(
  tier: AiPermissionTier,
  effect: AiToolEffect,
  policy: AiPermissionPolicy = {},
): AiPermissionDecision {
  const capped = clampPermissionTier(tier, policy.globalMax);
  if (capped === "manual") return "confirm";
  switch (effect) {
    case "read":
      return "allow";
    case "write":
      return capped === "standard" ? "confirm" : "allow";
    case "destructive":
      if (capped === "full" && policy.confirmDestructiveInFull === false) return "allow";
      return "confirm";
  }
}

/**
 * Resolve a stored grant at a moment in time.
 *
 * Expiry only ever lowers `full`/`trusted` to `standard`; a `manual` grant is
 * already lower and is left alone. The declared value is returned beside the
 * effective one so the banner can say "已过期，降为标准" instead of silently
 * changing what the buttons do.
 */
export function resolvePermission(
  input: { permission: AiPermissionTier; permissionExpiresAt?: number | undefined },
  options: { now?: number; policy?: AiPermissionPolicy } = {},
): AiPermissionResolution {
  const declared = input.permission;
  const now = options.now ?? Date.now();
  const expired =
    typeof input.permissionExpiresAt === "number" &&
    Number.isFinite(input.permissionExpiresAt) &&
    input.permissionExpiresAt > 0 &&
    now >= input.permissionExpiresAt &&
    permissionRank(declared) > permissionRank("standard");
  const afterExpiry: AiPermissionTier = expired ? "standard" : declared;
  const tier = clampPermissionTier(afterExpiry, options.policy?.globalMax);
  return { tier, declared, expired, capped: tier !== afterExpiry };
}

/** Milliseconds left on a grant; 0 when there is no expiry or it already passed. */
export function permissionRemainingMs(
  input: { permission: AiPermissionTier; permissionExpiresAt?: number | undefined },
  now = Date.now(),
): number {
  if (permissionRank(input.permission) <= permissionRank("standard")) return 0;
  if (typeof input.permissionExpiresAt !== "number" || !Number.isFinite(input.permissionExpiresAt)) return 0;
  return Math.max(0, input.permissionExpiresAt - now);
}

/** `59:30` / `1:02:03`, for the red banner's countdown. */
export function formatPermissionRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Whether a grant has an expiry at all. `standard`/`manual` never do. */
export function isGrantedTier(tier: AiPermissionTier): boolean {
  return permissionRank(tier) > permissionRank("standard");
}

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

export interface AiPathVerdict {
  allowed: boolean;
  /** Stable code, not prose: `outside_scope`, `excluded`, `escaping_path`. */
  reason?: "outside_scope" | "excluded" | "not_included" | "empty_path" | "escaping_path";
}

/**
 * May this workspace touch this path?
 *
 * The rules, all of them mechanical:
 *
 * 1. the path must be a vault-relative path: absolute paths, drive letters and
 *    any `..` segment are rejected before matching, so `notes/../.obsidian/x`
 *    cannot walk out of a folder scope by spelling;
 * 2. `folders` empty means the whole vault; otherwise the path must equal a
 *    folder or start with `<folder>/`, compared after normalization so
 *    `Notes` and `notes/` are not two different scopes;
 * 3. globs narrow the result: an include list, when present, must match, and an
 *    exclude always wins.
 */
export function checkWorkspacePath(
  workspace: Pick<AiWorkspace, "folders" | "includeGlobs" | "excludeGlobs">,
  path: string,
  kind: "file" | "directory" = "file",
): AiPathVerdict {
  const raw = typeof path === "string" ? path.trim() : "";
  if (!raw) return { allowed: false, reason: "empty_path" };
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw)) {
    return { allowed: false, reason: "escaping_path" };
  }
  const normalized = normalizeVaultPath(raw);
  if (!normalized) return { allowed: false, reason: "empty_path" };
  if (normalized.split("/").some((segment) => segment === "..")) return { allowed: false, reason: "escaping_path" };

  const folders = (workspace.folders ?? []).map((folder) => normalizeVaultPath(folder)).filter(Boolean);
  if (folders.length && !folders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`))) {
    return { allowed: false, reason: "outside_scope" };
  }
  // A directory is inside or outside by folder scope alone. Globs describe
  // files (`**/*.md`), and applying them to a folder name would refuse
  // `vault.list({folder: "Notes/Solar"})` -- the one call that lists exactly
  // what the scope was created to expose.
  if (kind === "directory") return { allowed: true };
  if (!isPathIncluded(normalized, { include: workspace.includeGlobs ?? [], exclude: workspace.excludeGlobs ?? [] })) {
    const include = workspace.includeGlobs ?? [];
    const excluded = (workspace.excludeGlobs ?? []).some((pattern) => matchGlob(pattern, normalized));
    if (excluded) return { allowed: false, reason: "excluded" };
    if (include.length && !include.some((pattern) => matchGlob(pattern, normalized))) {
      return { allowed: false, reason: "not_included" };
    }
    return { allowed: false, reason: "excluded" };
  }
  return { allowed: true };
}

/** Boolean form, for the call sites that only need a yes/no. */
export function workspaceAllowsPath(
  workspace: Pick<AiWorkspace, "folders" | "includeGlobs" | "excludeGlobs">,
  path: string,
  kind: "file" | "directory" = "file",
): boolean {
  return checkWorkspacePath(workspace, path, kind).allowed;
}

/**
 * The workspace whose scope contains `path`, preferring the deepest folder.
 *
 * Used by the `@` picker and by the agent's default scope when the user has not
 * chosen one: a note under `Notes/AI/` belongs to `Notes/AI` before it belongs
 * to `Notes`.
 */
export function workspaceForPath(
  workspaces: readonly AiWorkspace[],
  path: string,
): AiWorkspace | null {
  const normalized = normalizeVaultPath(path);
  let best: AiWorkspace | null = null;
  let bestDepth = -1;
  for (const workspace of workspaces) {
    if (!workspaceAllowsPath(workspace, normalized)) continue;
    const folders = (workspace.folders ?? []).map((folder) => normalizeVaultPath(folder)).filter(Boolean);
    const depth = folders.reduce((max, folder) => (normalized.startsWith(folder) ? Math.max(max, folder.split("/").length) : max), 0);
    if (depth > bestDepth) {
      best = workspace;
      bestDepth = depth;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const RAG_MODES = new Set(["inherit", "off", "on"]);

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function readStringList(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text || text.length > 512 || out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

let workspaceCounter = 0;

export function newWorkspaceId(at = Date.now()): string {
  workspaceCounter += 1;
  return `ws-${at.toString(36)}-${workspaceCounter.toString(36)}`;
}

/** One stored workspace, or null when it has no usable id. Settings files are hand-editable. */
export function normalizeWorkspace(raw: unknown): AiWorkspace | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = readString(record.id);
  if (!id) return null;
  const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
  const permission = isPermissionTier(record.permission) ? record.permission : "standard";
  const expires =
    typeof record.permissionExpiresAt === "number" && Number.isFinite(record.permissionExpiresAt) && record.permissionExpiresAt > 0
      ? record.permissionExpiresAt
      : undefined;
  const model = readString(record.model);
  const providerId = readString(record.providerId);
  const ragRaw = readString(record.rag);
  return {
    id,
    name: readString(record.name).slice(0, 80) || "未命名工作区",
    folders: readStringList(record.folders),
    includeGlobs: readStringList(record.includeGlobs, 50),
    excludeGlobs: readStringList(record.excludeGlobs, 50),
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    permission,
    // An expiry is meaningless on `standard`/`manual`: keeping it would make a
    // later upgrade back to `full` inherit a stale deadline.
    ...(expires && isGrantedTier(permission) ? { permissionExpiresAt: expires } : {}),
    rag: RAG_MODES.has(ragRaw) ? (ragRaw as AiWorkspace["rag"]) : "inherit",
    createdAt,
    updatedAt:
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) && record.updatedAt > 0
        ? record.updatedAt
        : createdAt,
  };
}

/** Every usable workspace, de-duplicated by id, newest first only when updated times tie. */
export function normalizeWorkspaces(raw: unknown): AiWorkspace[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, AiWorkspace>();
  for (const item of raw) {
    const workspace = normalizeWorkspace(item);
    if (workspace) byId.set(workspace.id, workspace);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** A short label for a sidebar section header or a settings row. */
export function describeWorkspace(workspace: AiWorkspace): string {
  const scope = workspace.folders.length ? workspace.folders.join("、") : "整个库";
  return `${workspace.name}  ${scope}  ${permissionLabel(workspace.permission)}`;
}

/** The folders shown in the sidebar row's second line. */
export function workspaceScopeLabel(workspace: AiWorkspace): string {
  if (!workspace.folders.length) return "整个库";
  if (workspace.folders.length === 1) return workspace.folders[0];
  return `${workspace.folders[0]} 等 ${workspace.folders.length} 个`;
}