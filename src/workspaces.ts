/**
 * Workspace settings: creation, patching, folder choices, and the sidebar's
 * conversation grouping.
 *
 * The SDK owns the sandbox and the permission table; this file owns the parts
 * that need the vault (which folders exist) and the stored object (what the
 * settings page edits). Grouping is pure and testable because it is the piece
 * most likely to grow rules later -- today it is one function with one
 * documented order.
 */

import { newWorkspaceId, type AiPermissionTier, type AiWorkspace } from "../sdk/src/ai/aiWorkspace";
import type { AiConversationSummary } from "../sdk/src/ai/aiConversationStore";

export interface WorkspaceDraft {
  name: string;
  folders: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  providerId?: string;
  model?: string;
  permission?: AiPermissionTier;
  /** Set on create for a granted tier; the caller turns it into an expiry. */
  expiresAt?: number;
  rag?: AiWorkspace["rag"];
}

/** A new workspace. Defaults mirror the plan: standard tier, RAG inherited. */
export function buildWorkspace(draft: WorkspaceDraft, at = Date.now()): AiWorkspace {
  return {
    id: newWorkspaceId(at),
    name: draft.name.trim().slice(0, 80) || "未命名工作区",
    folders: dedupePaths(draft.folders),
    includeGlobs: draft.includeGlobs ?? ["**/*.md"],
    excludeGlobs: draft.excludeGlobs ?? [],
    ...(draft.providerId ? { providerId: draft.providerId } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    permission: draft.permission ?? "standard",
    ...(draft.expiresAt && (draft.permission === "full" || draft.permission === "trusted")
      ? { permissionExpiresAt: draft.expiresAt }
      : {}),
    rag: draft.rag ?? "inherit",
    createdAt: at,
    updatedAt: at,
  };
}

/** Apply a patch and bump `updatedAt`; never mutates the stored object. */
export function patchWorkspace(workspace: AiWorkspace, patch: Partial<AiWorkspace>, at = Date.now()): AiWorkspace {
  const next: AiWorkspace = { ...workspace, ...patch, updatedAt: at };
  // Dropping out of a grant must drop its deadline too, or a later re-grant
  // would silently inherit a stale countdown.
  if (patch.permission !== undefined && patch.permission !== "full" && patch.permission !== "trusted") {
    delete next.permissionExpiresAt;
  }
  if (patch.folders) next.folders = dedupePaths(patch.folders);
  return next;
}

function dedupePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const clean = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
    if (!clean || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}


export type ConversationSectionKind = "workspace" | "ungrouped" | "pinned" | "today" | "earlier";

export interface ConversationSection {
  id: string;
  title: string;
  kind: ConversationSectionKind;
  items: AiConversationSummary[];
}

/**
 * The sidebar's sections, in the plan's order: one per workspace, then
 * 未分组, then pinned, then 今天, then 更早.
 *
 * A conversation appears in exactly one section. Workspace membership wins over
 * the pin, because "where does this conversation belong" is the question the
 * sidebar answers first; a pinned conversation with no workspace shows under
 * , which is where a user looks for it.
 */
export function groupConversations(
  summaries: readonly AiConversationSummary[],
  workspaces: readonly AiWorkspace[],
  options: { now?: number; dayMs?: number } = {},
): ConversationSection[] {
  const now = options.now ?? Date.now();
  const dayMs = options.dayMs ?? 24 * 60 * 60 * 1000;
  const sections: ConversationSection[] = [];
  const used = new Set<string>();

  for (const workspace of workspaces) {
    const items = summaries.filter((summary) => summary.workspaceId === workspace.id);
    if (!items.length) continue;
    for (const item of items) used.add(item.id);
    sections.push({ id: `ws-${workspace.id}`, title: workspace.name, kind: "workspace", items });
  }

  const remaining = summaries.filter(
    (summary) => !used.has(summary.id) && (!summary.workspaceId || !workspaces.some((workspace) => workspace.id === summary.workspaceId)),
  );
  const pinned = remaining.filter((summary) => summary.pinned);
  for (const item of pinned) used.add(item.id);
  if (pinned.length) sections.push({ id: "pinned", title: " 置顶", kind: "pinned", items: pinned });

  const recent = remaining.filter((summary) => !used.has(summary.id) && now - (summary.updatedAt || summary.createdAt || 0) < dayMs);
  for (const item of recent) used.add(item.id);
  if (recent.length) sections.push({ id: "today", title: "今天", kind: "today", items: recent });

  const earlier = remaining.filter((summary) => !used.has(summary.id));
  if (earlier.length) sections.push({ id: "earlier", title: "更早", kind: "earlier", items: earlier });

  return sections;
}

/** `刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 3 天前 / 2026-08-01`. */
export function relativeTime(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "刚刚";
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
  if (delta < 2 * day) return "昨天";
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
