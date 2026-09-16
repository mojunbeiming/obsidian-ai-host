import assert from "node:assert/strict";
import { test } from "node:test";

import {
  API_VERSION,
  REGISTRY_KEY,
  getApi,
  hasApi,
  publishApi,
  unpublishApi,
} from "../.build/api.js";

function fakeApp() {
  return {};
}

test("publish then get returns the same object", () => {
  const app = fakeApp();
  const api = { version: API_VERSION, openTodos: async () => {} };
  publishApi(app, "sfc-todo", api);
  assert.equal(getApi(app, "sfc-todo"), api);
  assert.equal(app[REGISTRY_KEY].apis["sfc-todo"], api);
});

test("an api that was never published reads as null, not as an error", () => {
  const app = fakeApp();
  assert.equal(getApi(app, "sfc-flashcards"), null);
  assert.equal(hasApi(app, "sfc-flashcards"), false);
});

test("a version below the requested minimum reads as unavailable", () => {
  const app = fakeApp();
  const older = API_VERSION - 1;
  publishApi(app, "sfc-flashcards", { version: older, openStudy: async () => {} });
  assert.ok(getApi(app, "sfc-flashcards", older));
  // A caller that needs the current contract must degrade, not call into an older object.
  assert.equal(getApi(app, "sfc-flashcards", API_VERSION), null);
  assert.equal(hasApi(app, "sfc-flashcards", API_VERSION), false);
});

test("republishing replaces the object, so a plugin reload cannot leave a stale one", () => {
  const app = fakeApp();
  const first = { version: API_VERSION, tag: "first" };
  const second = { version: API_VERSION, tag: "second" };
  publishApi(app, "sfc-heatmap", first);
  publishApi(app, "sfc-heatmap", second);
  assert.equal(getApi(app, "sfc-heatmap").tag, "second");
});

test("unpublish removes only the named api", () => {
  const app = fakeApp();
  publishApi(app, "sfc-todo", { version: API_VERSION });
  publishApi(app, "sfc-heatmap", { version: API_VERSION });
  unpublishApi(app, "sfc-todo");
  assert.equal(getApi(app, "sfc-todo"), null);
  assert.ok(getApi(app, "sfc-heatmap"));
});

test("unpublish on an unknown id or app is a no-op", () => {
  assert.doesNotThrow(() => unpublishApi({}, "nobody"));
  assert.doesNotThrow(() => unpublishApi(null, "nobody"));
});

test("two plugins sharing the registry see each other", () => {
  // This is the whole point: two independently bundled copies of this module
  // must agree on where the registry lives.
  const app = fakeApp();
  publishApi(app, "sfc-flashcards", { version: API_VERSION, openStudy: async () => {} });
  assert.ok(app[REGISTRY_KEY]);
  assert.equal(app[REGISTRY_KEY].version, API_VERSION);
  assert.ok(app[REGISTRY_KEY].publishedAt["sfc-flashcards"]);
});

test("an api with a non-numeric version is treated as incompatible", () => {
  const app = fakeApp();
  publishApi(app, "sfc-todo", { version: "one" });
  assert.equal(getApi(app, "sfc-todo"), null);
});

test("null and primitive hosts are tolerated", () => {
  assert.equal(getApi(null, "sfc-todo"), null);
  assert.equal(getApi(undefined, "sfc-todo"), null);
  assert.equal(getApi(42, "sfc-todo"), null);
  assert.doesNotThrow(() => publishApi(null, "sfc-todo", { version: API_VERSION }));
  assert.doesNotThrow(() => publishApi("nope", "sfc-todo", { version: API_VERSION }));
});

test("a pre-existing registry from another bundle is reused rather than replaced", () => {
  const app = fakeApp();
  const existing = { version: API_VERSION, apis: { "sfc-todo": { version: API_VERSION, tag: "old" } } };
  app[REGISTRY_KEY] = existing;
  publishApi(app, "sfc-heatmap", { version: API_VERSION });
  assert.equal(app[REGISTRY_KEY], existing);
  assert.equal(getApi(app, "sfc-todo").tag, "old");
});

test("disabling a plugin makes its api read as absent, not as stale", () => {
  // The path a consumer takes when the other plugin is switched off at runtime:
  // `getApi` must return null immediately, so the caller falls into the same
  // branch it uses when the plugin was never installed. A cached reference would
  // keep answering until it was called, and then fail somewhere less obvious.
  const app = fakeApp();
  publishApi(app, "sfc-flashcards", { version: API_VERSION, openStudy: async () => {} });
  assert.ok(getApi(app, "sfc-flashcards"));
  unpublishApi(app, "sfc-flashcards");
  assert.equal(getApi(app, "sfc-flashcards"), null);
  assert.equal(hasApi(app, "sfc-flashcards"), false);
});

test("a reload is unload-then-load, and the second publish wins", () => {
  // Obsidian calls onunload before the next onload, so a reload looks like this
  // from the registry's point of view. The ordering is why `unpublishApi` can
  // delete unconditionally.
  const app = fakeApp();
  const first = { version: API_VERSION, tag: "first" };
  const second = { version: API_VERSION, tag: "second" };
  publishApi(app, "sfc-heatmap", first);
  unpublishApi(app, "sfc-heatmap");
  publishApi(app, "sfc-heatmap", second);
  assert.equal(getApi(app, "sfc-heatmap").tag, "second");
});

test("the registry survives losing one api while another keeps working", () => {
  // The three plugins are independent: disabling the flashcards plugin must not
  // disturb the todo plugin's api, which is the whole reason each lookup is by id.
  const app = fakeApp();
  publishApi(app, "sfc-flashcards", { version: API_VERSION, tag: "cards" });
  publishApi(app, "sfc-todo", { version: API_VERSION, tag: "todos" });
  unpublishApi(app, "sfc-flashcards");
  assert.equal(getApi(app, "sfc-flashcards"), null);
  assert.equal(getApi(app, "sfc-todo").tag, "todos");
});