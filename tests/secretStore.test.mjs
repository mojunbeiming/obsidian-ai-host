/**
 * The secret store: keychain first, legacy read-only, and the no-keychain case.
 *
 * The no-keychain case is the one worth reading: older Obsidian has no
 * `secretStorage`, and the store must refuse to write rather than fall back to
 * `data.json`. A test that allowed the fallback would bless exactly the leak the
 * plan removes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AiSecretStore } from "../.build/secretStore.js";

function fakeHost(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  return {
    values,
    calls,
    host: {
      getSecret: (id) => values.get(id) ?? null,
      setSecret: (id, value) => {
        calls.push([id, value]);
        values.set(id, value);
      },
      listSecrets: () => [...values.keys()],
    },
  };
}

test("read prefers the keychain, then the legacy field, then nothing", () => {
  const { host } = fakeHost({ "sfc-ai-deepseek": "keychain-value" });
  const store = new AiSecretStore(host, { read: () => "legacy-value", clear: () => undefined });
  assert.deepEqual(store.read("sfc-ai-deepseek"), { value: "keychain-value", origin: "keychain" });

  const legacyOnly = new AiSecretStore(host, { read: (id) => (id === "sfc-ai-openai" ? " legacy " : ""), clear: () => undefined });
  assert.deepEqual(legacyOnly.read("sfc-ai-openai"), { value: "legacy", origin: "legacy" });
  assert.deepEqual(legacyOnly.read("sfc-ai-ollama"), { value: "", origin: "none" });
});

test("an empty keychain value falls through to the legacy field", () => {
  const { host } = fakeHost({ "sfc-ai-deepseek": "" });
  const store = new AiSecretStore(host, { read: () => "legacy", clear: () => undefined });
  assert.equal(store.read("sfc-ai-deepseek").origin, "legacy");
});

test("writing stores the value and clears the legacy copy at the same time", () => {
  const cleared = [];
  const { host, values } = fakeHost();
  const store = new AiSecretStore(host, { read: () => "old", clear: (id) => cleared.push(id) });
  assert.deepEqual(store.write("sfc-ai-deepseek", "  new-key  "), { ok: true });
  assert.equal(values.get("sfc-ai-deepseek"), "new-key");
  assert.deepEqual(cleared, ["sfc-ai-deepseek"], "写入新值时必须清掉旧明文");
});

test("writing an empty value clears both locations", () => {
  const cleared = [];
  const { host, values } = fakeHost({ "sfc-ai-deepseek": "old" });
  const store = new AiSecretStore(host, { read: () => null, clear: (id) => cleared.push(id) });
  assert.equal(store.write("sfc-ai-deepseek", "").ok, true);
  assert.equal(values.get("sfc-ai-deepseek"), "");
  assert.deepEqual(cleared, ["sfc-ai-deepseek"]);
});

test("without a keychain, writing refuses instead of storing plaintext", () => {
  const cleared = [];
  const store = new AiSecretStore(null, { read: () => null, clear: (id) => cleared.push(id) });
  assert.equal(store.available, false);
  assert.deepEqual(store.write("sfc-ai-deepseek", "secret"), { ok: false, reason: "unavailable" });
  assert.deepEqual(cleared, ["sfc-ai-deepseek"], "拒绝写入时仍要清掉旧明文");
});

test("migration writes only the ids the keychain does not already have", () => {
  const { host, values } = fakeHost({ "sfc-ai-openai": "already-there" });
  const store = new AiSecretStore(host);
  const result = store.migrate([
    { providerId: "deepseek", apiKey: "flat-key" },
    { providerId: "openai", apiKey: "stale-key" },
  ]);
  assert.equal(result.migrated, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.ids, ["sfc-ai-deepseek"]);
  assert.equal(values.get("sfc-ai-deepseek"), "flat-key");
  assert.equal(values.get("sfc-ai-openai"), "already-there", "已有的钥匙串值不能被旧明文覆盖");
});

test("without a keychain, migration reports unavailable and changes nothing", () => {
  const store = new AiSecretStore(null);
  const result = store.migrate([{ providerId: "deepseek", apiKey: "flat-key" }]);
  assert.equal(result.unavailable, true);
  assert.equal(result.migrated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(store.available, false);
});

test("a keychain that throws is treated as empty rather than as a crash", () => {
  const broken = {
    getSecret: () => {
      throw new Error("keychain locked");
    },
    setSecret: () => {
      throw new Error("keychain locked");
    },
  };
  const store = new AiSecretStore(broken, { read: () => "legacy", clear: () => undefined });
  assert.deepEqual(store.read("sfc-ai-deepseek"), { value: "legacy", origin: "legacy" });
  assert.equal(store.write("sfc-ai-deepseek", "x").ok, false);
});