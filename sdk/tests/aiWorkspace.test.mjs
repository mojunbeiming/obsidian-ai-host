/**
 * Workspaces and the permission table.
 *
 * The two properties that matter: the sandbox refuses anything outside its
 * folder scope (including paths spelled to escape it), and a permission tier
 * can only ever be lowered by expiry or the global ceiling -- never raised by a
 * stale stored value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_PERMISSION_TIERS,
  checkWorkspacePath,
  clampPermissionTier,
  decidePermission,
  describeWorkspace,
  formatPermissionRemaining,
  isGrantedTier,
  normalizeWorkspace,
  normalizeWorkspaces,
  permissionDescription,
  permissionLabel,
  permissionRank,
  permissionRemainingMs,
  resolvePermission,
  workspaceAllowsPath,
  workspaceForPath,
  workspaceScopeLabel,
} from "../.build/ai/aiWorkspace.js";

function workspace(overrides = {}) {
  return {
    id: "ws-1",
    name: "日光工坊",
    folders: ["Notes/Solar"],
    includeGlobs: ["**/*.md"],
    excludeGlobs: [],
    permission: "standard",
    rag: "inherit",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

test("permission ranks order the tiers from manual to full", () => {
  assert.deepEqual(
    [...AI_PERMISSION_TIERS].sort((a, b) => permissionRank(a) - permissionRank(b)),
    ["manual", "standard", "trusted", "full"],
  );
  assert.equal(permissionLabel("full"), "完全权限");
  assert.match(permissionDescription("trusted"), /删除/);
});

test("clamp only lowers a tier", () => {
  assert.equal(clampPermissionTier("full", "standard"), "standard");
  assert.equal(clampPermissionTier("standard", "full"), "standard");
  assert.equal(clampPermissionTier("trusted", undefined), "trusted");
});

test("the permission table is the four documented rows", () => {
  assert.equal(decidePermission("manual", "read"), "confirm");
  assert.equal(decidePermission("standard", "read"), "allow");
  assert.equal(decidePermission("standard", "write"), "confirm");
  assert.equal(decidePermission("trusted", "write"), "allow");
  assert.equal(decidePermission("trusted", "destructive"), "confirm");
  assert.equal(decidePermission("full", "write"), "allow");
  assert.equal(decidePermission("full", "destructive"), "confirm");
  assert.equal(decidePermission("full", "destructive", { confirmDestructiveInFull: false }), "allow");
});

test("the global ceiling lowers every decision, destructive included", () => {
  assert.equal(decidePermission("full", "write", { globalMax: "standard" }), "confirm");
  assert.equal(decidePermission("full", "destructive", { globalMax: "standard", confirmDestructiveInFull: false }), "confirm");
  assert.equal(decidePermission("trusted", "read", { globalMax: "manual" }), "confirm");
});

test("a grant expires back to standard but manual is left alone", () => {
  const expired = resolvePermission({ permission: "full", permissionExpiresAt: 1000 }, { now: 2000 });
  assert.equal(expired.tier, "standard");
  assert.equal(expired.declared, "full");
  assert.equal(expired.expired, true);

  const live = resolvePermission({ permission: "full", permissionExpiresAt: 3000 }, { now: 2000 });
  assert.equal(live.tier, "full");
  assert.equal(live.expired, false);

  const manual = resolvePermission({ permission: "manual", permissionExpiresAt: 1000 }, { now: 2000 });
  assert.equal(manual.tier, "manual");
  assert.equal(manual.expired, false);

  const capped = resolvePermission({ permission: "full" }, { policy: { globalMax: "standard" } });
  assert.equal(capped.tier, "standard");
  assert.equal(capped.capped, true);
});

test("remaining time is only reported for a live grant", () => {
  assert.equal(permissionRemainingMs({ permission: "full", permissionExpiresAt: 5000 }, 2000), 3000);
  assert.equal(permissionRemainingMs({ permission: "standard", permissionExpiresAt: 5000 }, 2000), 0);
  assert.equal(permissionRemainingMs({ permission: "full" }, 2000), 0);
  assert.equal(formatPermissionRemaining(59_400), "00:59");
  assert.equal(formatPermissionRemaining(3_723_000), "1:02:03");
  assert.equal(isGrantedTier("trusted"), true);
  assert.equal(isGrantedTier("standard"), false);
});

test("the sandbox accepts inside the folder and refuses outside it", () => {
  assert.equal(workspaceAllowsPath(workspace(), "Notes/Solar/a.md"), true);
  assert.equal(workspaceAllowsPath(workspace(), "Notes/Solar", "directory"), true);
  assert.equal(workspaceAllowsPath(workspace(), "Notes/Other/a.md"), false);
  assert.equal(checkWorkspacePath(workspace(), "Notes/Solar", "directory").allowed, true);
  assert.equal(checkWorkspacePath(workspace(), "Notes/Other/a.md").reason, "outside_scope");
});

test("an empty folder list means the whole vault", () => {
  const all = workspace({ folders: [], includeGlobs: [], excludeGlobs: [] });
  assert.equal(workspaceAllowsPath(all, "any/where.md"), true);
  assert.equal(workspaceAllowsPath(all, ".obsidian/plugins/x/data.json"), true);
});

test("paths spelled to escape the scope are refused before matching", () => {
  const verdict = checkWorkspacePath(workspace(), "Notes/Solar/../Other/a.md");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "escaping_path");
  assert.equal(checkWorkspacePath(workspace(), "C:/vault/Notes/Solar/a.md").reason, "escaping_path");
  assert.equal(checkWorkspacePath(workspace(), "/etc/passwd").reason, "escaping_path");
  assert.equal(checkWorkspacePath(workspace(), "  ").reason, "empty_path");
});

test("globs narrow the folder scope, and exclude wins", () => {
  const scoped = workspace({ includeGlobs: ["**/*.md"], excludeGlobs: ["**/private/**"] });
  assert.equal(workspaceAllowsPath(scoped, "Notes/Solar/a.md"), true);
  assert.equal(workspaceAllowsPath(scoped, "Notes/Solar/image.png"), false);
  assert.equal(checkWorkspacePath(scoped, "Notes/Solar/private/secret.md").reason, "excluded");
});

test("workspaceForPath prefers the deepest matching scope", () => {
  const outer = workspace({ id: "outer", name: "Notes", folders: ["Notes"], includeGlobs: [], excludeGlobs: [] });
  const inner = workspace({ id: "inner", name: "Solar", folders: ["Notes/Solar"], includeGlobs: [], excludeGlobs: [] });
  assert.equal(workspaceForPath([outer, inner], "Notes/Solar/a.md")?.id, "inner");
  assert.equal(workspaceForPath([outer, inner], "Notes/Other/a.md")?.id, "outer");
  assert.equal(workspaceForPath([outer], "Elsewhere/a.md"), null);
});

test("normalization drops unusable records and repairs hand-edited fields", () => {
  assert.equal(normalizeWorkspace(null), null);
  assert.equal(normalizeWorkspace({ name: "没有 id" }), null);
  const repaired = normalizeWorkspace({
    id: "ws-x",
    name: "   ",
    folders: ["Notes//Solar/", "Notes//Solar/", 3],
    includeGlobs: "not-an-array",
    permission: "root",
    rag: "maybe",
  });
  assert.equal(repaired.name, "未命名工作区");
  assert.deepEqual(repaired.folders, ["Notes//Solar/"]);
  assert.equal(repaired.permission, "standard");
  assert.equal(repaired.rag, "inherit");

  const list = normalizeWorkspaces([
    { id: "b", name: "乙" },
    { id: "a", name: "甲" },
    { id: "a", name: "甲（重复）" },
    "nope",
  ]);
  assert.deepEqual(list.map((entry) => entry.id).sort(), ["a", "b"]);

  const expired = normalizeWorkspace({ id: "w", permission: "standard", permissionExpiresAt: 123 });
  assert.equal(expired.permissionExpiresAt, undefined);
});

test("describe labels stay short enough for a sidebar row", () => {
  assert.match(describeWorkspace(workspace()), /日光工坊/);
  assert.match(describeWorkspace(workspace()), /标准/);
  assert.equal(workspaceScopeLabel(workspace({ folders: [] })), "整个库");
  assert.equal(workspaceScopeLabel(workspace()), "Notes/Solar");
  assert.equal(workspaceScopeLabel(workspace({ folders: ["a", "b", "c"] })), "a 等 3 个");
});