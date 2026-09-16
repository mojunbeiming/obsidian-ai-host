/**
 * The glob rules the settings page promises.
 *
 * The two properties that matter are asserted as properties, not as examples:
 * `*` never crosses a slash, and exclude always beats include. Everything else
 * pins a single pattern so a matcher rewrite cannot quietly change what
 * `**\/*.md` means.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INDEX_EXCLUDES,
  globToRegExp,
  isPathIncluded,
  matchGlob,
  normalizeVaultPath,
} from "../.build/ai/aiGlob.js";

test("vault paths are normalized to forward slashes with no leading or trailing noise", () => {
  assert.equal(normalizeVaultPath("notes\\a.md"), "notes/a.md");
  assert.equal(normalizeVaultPath("./notes//a.md"), "notes/a.md");
  assert.equal(normalizeVaultPath("notes/a.md/"), "notes/a.md");
  assert.equal(normalizeVaultPath(""), "");
});

test("`*` does not cross a slash, and `**` does", () => {
  assert.ok(matchGlob("*.md", "a.md"));
  assert.ok(!matchGlob("*.md", "notes/a.md"));
  assert.ok(matchGlob("notes/*.md", "notes/a.md"));
  assert.ok(!matchGlob("notes/*.md", "notes/deep/a.md"));
  assert.ok(matchGlob("notes/**", "notes/deep/a.md"));
  assert.ok(matchGlob("**/*.md", "a.md"), "`**/` must also match the vault root");
  assert.ok(matchGlob("**/*.md", "notes/deep/a.md"));
});

test("`?` matches one character other than a slash", () => {
  assert.ok(matchGlob("note?.md", "note1.md"));
  assert.ok(!matchGlob("note?.md", "note12.md"));
  assert.ok(!matchGlob("note?.md", "note/.md"));
});

test("regexp metacharacters in a pattern are literal", () => {
  assert.ok(matchGlob("a+b(1).md", "a+b(1).md"));
  const source = globToRegExp("a+b(1).md").source;
  assert.ok(!source.includes("a+"), "the plus must be escaped, not treated as a quantifier");
});

test("a pattern is anchored: no accidental prefix match", () => {
  assert.ok(!matchGlob("notes/**", "notes2/a.md"));
  assert.ok(!matchGlob("**/*.md", "a.markdown"));
});

test("an empty include list means everything, and exclude always wins", () => {
  assert.ok(isPathIncluded("notes/a.md", { exclude: [".obsidian/**"] }));
  assert.ok(isPathIncluded("notes/a.md", { include: ["**/*.md"], exclude: [".obsidian/**"] }));
  assert.ok(!isPathIncluded(".obsidian/app.json", { include: ["**/*.md"], exclude: [".obsidian/**"] }));
  assert.ok(!isPathIncluded("notes/a.png", { include: ["**/*.md"] }));
});

test("the default excludes name configuration, trash and OS litter", () => {
  for (const path of [".obsidian/plugins/x/data.json", ".trash/old.md", "notes/.DS_Store"]) {
    assert.ok(!isPathIncluded(path, { exclude: DEFAULT_INDEX_EXCLUDES }), path);
  }
  assert.ok(isPathIncluded("notes/a.md", { exclude: DEFAULT_INDEX_EXCLUDES }));
});