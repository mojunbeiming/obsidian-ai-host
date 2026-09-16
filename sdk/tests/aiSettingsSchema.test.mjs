/**
 * The settings schema: guards, migration chain, and preset merging.
 *
 * Three classes of test, and each catches a different shape of bug:
 *
 * * **normalization** -- a hand-edited file must produce a renderable object,
 *   never a throw and never a partial one;
 * * **migration** -- the flat fields the shipped plugins use must become the
 *   structured shape with the *same* trust rules `readAiSettings` applied, and
 *   no credential may survive the trip;
 * * **preset merge** -- the Smart Composer bug (`Object.assign` flattening a
 *   nested user value) must stay fixed, because that test is the only thing
 *   stopping a future "simplification" from reintroducing it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_SETTINGS_MIGRATIONS,
  AI_SETTINGS_VERSION,
  collectLegacyAiSecrets,
  deepMerge,
  defaultAiSettings,
  mergeDefaultPresets,
  migrateAiSettings,
  migrateAiSettingsDetailed,
  normalizeAiSettings,
  providerEntryFromPreset,
  resolveProviders,
  secretIdForProvider,
  settingsVersionOf,
} from "../.build/ai/aiSettingsSchema.js";
import { AI_PROVIDERS, providerById } from "../.build/aiProviders.js";

// ---------------------------------------------------------------------------
// Defaults and normalization
// ---------------------------------------------------------------------------

test("the chain is contiguous and ends at the current version", () => {
  let expected = 0;
  for (const migration of AI_SETTINGS_MIGRATIONS) {
    assert.equal(migration.from, expected, `迁移链在 ${migration.from} 断开`);
    assert.ok(migration.to > migration.from);
    assert.ok(migration.describe.trim().length > 0, "每一级迁移都要有可读描述");
    expected = migration.to;
  }
  assert.equal(expected, AI_SETTINGS_VERSION);
});

test("fresh defaults are safe by default: RAG and tools off, no keys", () => {
  const settings = defaultAiSettings();
  assert.equal(settings.version, AI_SETTINGS_VERSION);
  assert.equal(settings.rag.enabled, false);
  assert.equal(settings.tools.enabled, false);
  assert.equal(settings.tools.maxAutoIterations, 1);
  assert.deepEqual(settings.providers, []);
  assert.equal(JSON.stringify(settings).includes("apiKey"), false);
});

test("a non-object normalizes to defaults, and unknown fields are dropped", () => {
  for (const raw of [null, 42, "x", [], undefined]) {
    assert.deepEqual(normalizeAiSettings(raw), defaultAiSettings(), String(raw));
  }
  const settings = normalizeAiSettings({ version: 1, nonsense: true, chat: { nonsense: 1 } });
  assert.equal("nonsense" in settings, false);
  assert.equal("nonsense" in settings.chat, false);
});

test("every scalar field falls back instead of propagating a wrong type", () => {
  const settings = normalizeAiSettings({
    chat: {
      providerId: 42,
      model: null,
      temperature: "0.5",
      maxContextMessages: 0,
      includeCurrentFile: "yes",
      stream: false,
      timeoutMs: 100,
      maxImages: 99,
    },
  });
  assert.equal(settings.chat.providerId, "");
  assert.equal(settings.chat.model, "");
  assert.equal(settings.chat.temperature, 0.7, "字符串温度是坏数据，不是可以猜的数字");
  assert.equal(settings.chat.maxContextMessages, 1);
  assert.equal(settings.chat.includeCurrentFile, true);
  assert.equal(settings.chat.stream, false);
  assert.equal(settings.chat.timeoutMs, 5000);
  assert.equal(settings.chat.maxImages, 20);
});

test("RAG numbers are clamped into a usable range", () => {
  const settings = normalizeAiSettings({
    rag: {
      enabled: 1,
      chunkSize: 50,
      chunkOverlap: 5000,
      thresholdTokens: -5,
      minSimilarity: 2,
      limit: 1000,
      includeGlobs: ["**/*.md", 42, "", "**/*.md"],
    },
  });
  assert.equal(settings.rag.enabled, false);
  assert.equal(settings.rag.chunkSize, 100);
  assert.equal(settings.rag.chunkOverlap, 99, "overlap 必须小于 chunkSize，否则切块不前进");
  assert.equal(settings.rag.thresholdTokens, 0);
  assert.equal(settings.rag.minSimilarity, 1);
  assert.equal(settings.rag.limit, 100);
  assert.deepEqual(settings.rag.includeGlobs, ["**/*.md"]);
});

test("a provider row is normalized, and a plaintext key is never copied", () => {
  const settings = normalizeAiSettings({
    providers: [
      {
        id: "deepseek",
        baseUrl: "http://127.0.0.1:1",
        model: "m",
        apiKey: "sk-secret",
        extraHeaders: { "X-Multi": "a\r\nInjected: yes", "X-Num": 3 },
        capabilities: ["vision", "unknown", "VISION"],
      },
      { id: "" },
      null,
      "not a row",
    ],
  });
  assert.equal(settings.providers.length, 1);
  const row = settings.providers[0];
  assert.equal(row.id, "deepseek");
  assert.equal(row.protocol, "openai");
  assert.equal(row.label, providerById("deepseek").label);
  assert.equal(row.apiKeyRef, "sfc-ai-deepseek");
  assert.deepEqual(row.capabilities, ["vision"]);
  assert.equal(row.extraHeaders["X-Multi"], "a Injected: yes");
  assert.equal("X-Num" in row.extraHeaders, false);
  assert.equal(JSON.stringify(settings).includes("sk-secret"), false);
  assert.equal("apiKey" in row, false);
});

test("an unknown provider id becomes a user-added row, not a dropped one", () => {
  const settings = normalizeAiSettings({ providers: [{ id: "my-gateway", baseUrl: "http://127.0.0.1:9" }] });
  const row = settings.providers[0];
  assert.equal(row.label, "my-gateway");
  assert.equal(row.userAdded, true);
  assert.equal(row.protocol, "openai");
  assert.equal(row.apiKeyRef, "sfc-ai-my-gateway");
});

test("duplicate provider ids merge deeply instead of replacing each other", () => {
  const settings = normalizeAiSettings({
    providers: [
      { id: "mine", label: "第一个", baseUrl: "http://127.0.0.1:1" },
      { id: "mine", model: "second" },
    ],
  });
  assert.equal(settings.providers.length, 1);
  assert.equal(settings.providers[0].label, "第一个");
  assert.equal(settings.providers[0].model, "second");
  assert.equal(settings.providers[0].baseUrl, "http://127.0.0.1:1");
});

// ---------------------------------------------------------------------------
// Migration from the flat plugin keys
// ---------------------------------------------------------------------------

test("the flat keys migrate to the structured shape, and the key does not come along", () => {
  const raw = {
    aiProvider: "deepseek",
    aiStoredFor: "deepseek",
    aiBaseUrl: "http://127.0.0.1:1234/v1",
    aiProtocol: "openai",
    aiModel: "local-model",
    aiApiKey: "sk-secret",
    aiAuthHeader: "authorization",
    aiAuthPrefix: "Bearer ",
    aiTimeoutMs: 30000,
    aiSupportsImages: true,
    aiMaxImages: 3,
  };
  const { settings, report } = migrateAiSettingsDetailed(raw);
  assert.equal(report.fromVersion, 0);
  assert.equal(report.applied.length, 1);
  assert.equal(report.fellBack, false);
  assert.equal(settings.chat.providerId, "deepseek");
  assert.equal(settings.chat.model, "local-model");
  assert.equal(settings.chat.timeoutMs, 30000);
  assert.equal(settings.chat.maxImages, 3);
  assert.equal(settings.providers.length, 1);
  const row = settings.providers[0];
  assert.equal(row.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(row.model, "local-model");
  assert.equal(row.authHeader, "authorization");
  assert.equal(row.authPrefix, "Bearer ");
  assert.deepEqual(row.capabilities, ["vision"]);
  assert.equal(JSON.stringify(settings).includes("sk-secret"), false);
});

test("a stale address saved under another provider is discarded, exactly as readAiSettings did", () => {
  const settings = migrateAiSettings({
    aiProvider: "deepseek",
    aiStoredFor: "openai",
    aiBaseUrl: "https://api.openai.com/v1",
    aiModel: "gpt-4o-mini",
  });
  assert.equal(settings.chat.providerId, "deepseek");
  assert.equal(settings.chat.model, "", "地址和模型属于另一个服务，不能带过来");
  assert.deepEqual(settings.providers, []);
});

test("custom keeps its overrides without a storedFor marker, because there is no preset to fall back to", () => {
  const settings = migrateAiSettings({ aiProvider: "custom", aiBaseUrl: "http://127.0.0.1:7777/v1", aiModel: "m" });
  assert.equal(settings.providers.length, 1);
  assert.equal(settings.providers[0].id, "custom");
  assert.equal(settings.providers[0].baseUrl, "http://127.0.0.1:7777/v1");
  assert.equal(settings.providers[0].model, "m");
});

test("migration is idempotent: migrating an already-migrated object changes nothing", () => {
  const once = migrateAiSettings({ aiProvider: "ollama", aiStoredFor: "ollama", aiModel: "qwen2.5-vl" });
  const twice = migrateAiSettings(once);
  assert.deepEqual(twice, once);
});

test("a settings file from a newer release is read field by field, with a warning", () => {
  const { settings, report } = migrateAiSettingsDetailed({ version: 99, chat: { temperature: 0.5 } });
  assert.equal(report.fromVersion, 99);
  assert.deepEqual(report.warnings, ["version_ahead"]);
  assert.equal(report.fellBack, false);
  assert.equal(settings.chat.temperature, 0.5);
});

test("a migration that throws falls back to defaults rather than half-migrated data", () => {
  const original = [...AI_SETTINGS_MIGRATIONS];
  try {
    AI_SETTINGS_MIGRATIONS.push({
      from: 1,
      to: 2,
      describe: "test-only failure",
      migrate() {
        throw new Error("boom");
      },
    });
    const { settings, report } = migrateAiSettingsDetailed({ version: 1, chat: { temperature: 0.4 } });
    assert.equal(report.fellBack, true);
    assert.ok(report.warnings[0].startsWith("migration_failed:"));
    assert.deepEqual(settings, defaultAiSettings());
  } finally {
    AI_SETTINGS_MIGRATIONS.length = 0;
    AI_SETTINGS_MIGRATIONS.push(...original);
  }
});

test("a missing version reads as the legacy shape; a non-object reports itself", () => {
  assert.equal(settingsVersionOf({}), 0);
  assert.equal(settingsVersionOf({ version: -1 }), 0);
  assert.equal(settingsVersionOf({ version: 2.5 }), 0);
  assert.equal(settingsVersionOf({ version: 3 }), 3);
  const bad = migrateAiSettingsDetailed("not settings");
  assert.deepEqual(bad.report.warnings, ["not_an_object"]);
  assert.equal(bad.report.fellBack, true);
});

// ---------------------------------------------------------------------------
// Legacy credentials
// ---------------------------------------------------------------------------

test("legacy plaintext keys are found by provider and de-duplicated", () => {
  assert.deepEqual(collectLegacyAiSecrets({ aiProvider: "deepseek", aiApiKey: " sk-d " }), [
    { providerId: "deepseek", apiKey: "sk-d" },
  ]);
  assert.deepEqual(collectLegacyAiSecrets({ providers: [{ id: "openai", apiKey: " sk-o " }] }), [
    { providerId: "openai", apiKey: "sk-o" },
  ]);
  assert.deepEqual(
    collectLegacyAiSecrets({
      aiProvider: "deepseek",
      aiApiKey: "sk-flat",
      providers: [
        { id: "deepseek", apiKey: "sk-row" },
        { id: "openai", apiKey: "sk-o" },
      ],
    }),
    [
      { providerId: "deepseek", apiKey: "sk-flat" },
      { providerId: "openai", apiKey: "sk-o" },
    ],
  );
  assert.deepEqual(collectLegacyAiSecrets({}), []);
});

// ---------------------------------------------------------------------------
// Preset merging
// ---------------------------------------------------------------------------

test("mergeDefaultPresets keeps user nested values, fills new defaults, and appends custom rows", () => {
  const defaults = [
    { id: "a", label: "A", nested: { x: 1, y: 2 }, list: [1] },
    { id: "b", label: "B" },
  ];
  const existing = [
    { id: "a", nested: { y: 30 }, list: [2, 3] },
    { id: "mine", label: "Mine" },
  ];
  const merged = mergeDefaultPresets(existing, defaults);
  assert.deepEqual(merged.map((row) => row.id), ["a", "b", "mine"]);
  assert.equal(merged[0].label, "A", "preset 补充了用户没填的字段");
  assert.deepEqual(merged[0].nested, { x: 1, y: 30 }, "嵌套对象的用户值不能被默认值覆盖");
  assert.deepEqual(merged[0].list, [2, 3], "数组整体替换，不做位置合并");
  assert.deepEqual(merged[2], { id: "mine", label: "Mine" });
});

test("deepMerge treats null and undefined as 'not set' in the patch", () => {
  assert.deepEqual(deepMerge({ a: 1, b: { c: 2 } }, { a: undefined, b: { c: null } }), { a: 1, b: { c: 2 } });
  assert.deepEqual(deepMerge({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
});

test("resolveProviders offers every preset plus the user's own rows", () => {
  const settings = normalizeAiSettings({ providers: [{ id: "deepseek", baseUrl: "http://127.0.0.1:5555", model: "mine" }] });
  const rows = resolveProviders(settings);
  assert.deepEqual(
    rows.map((row) => row.id),
    [...AI_PROVIDERS.map((preset) => preset.id)],
  );
  const deepseek = rows.find((row) => row.id === "deepseek");
  assert.equal(deepseek.baseUrl, "http://127.0.0.1:5555");
  assert.equal(deepseek.model, "mine");
  assert.equal(deepseek.label, providerById("deepseek").label, "未覆盖的字段仍来自预设");
});

test("providerEntryFromPreset states vision once, and the two spellings agree", () => {
  for (const preset of AI_PROVIDERS) {
    const row = providerEntryFromPreset(preset);
    assert.equal(row.capabilities.includes("vision"), preset.supportsImages, preset.id);
    assert.ok(row.capabilities.includes("stream"), `${preset.id} 必须支持流式，否则聊天没有增量`);
    assert.ok(!("apiKey" in row), `${preset.id} 的条目里不能有明文 key`);
  }
});

test("secret ids are stable, lowercase and filesystem-safe", () => {
  assert.equal(secretIdForProvider("deepseek"), "sfc-ai-deepseek");
  assert.equal(secretIdForProvider(" My Provider! "), "sfc-ai-my-provider");
  assert.equal(secretIdForProvider(""), "sfc-ai-provider");
  assert.equal(secretIdForProvider("x".repeat(200)).length, "sfc-ai-".length + 60);
});

test("the logging section has safe defaults and clamps", () => {
  const fresh = defaultAiSettings().logging;
  assert.equal(fresh.level, "normal");
  assert.equal(fresh.recordFullPayload, false, "默认不记录完整正文");
  const clamped = normalizeAiSettings({
    logging: { level: "nope", keepRuns: 99999, keepDays: 0, maxBytesMB: -3, recordFullPayload: "yes", statusBar: false },
  }).logging;
  assert.equal(clamped.level, "normal");
  assert.equal(clamped.keepRuns, 1000);
  assert.equal(clamped.keepDays, 1);
  assert.equal(clamped.maxBytesMB, 1);
  assert.equal(clamped.recordFullPayload, false);
  assert.equal(clamped.statusBar, false);
});

// ---------------------------------------------------------------------------
// v2 sections: workspaces, permission, agent, sendOnEnter
// ---------------------------------------------------------------------------

test("fresh defaults keep the new sections off and safe", () => {
  const settings = defaultAiSettings();
  assert.deepEqual(settings.workspaces, []);
  assert.equal(settings.defaultWorkspaceId, "");
  assert.equal(settings.permission.globalMax, "full");
  assert.equal(settings.permission.confirmDestructiveInFull, true);
  assert.equal(settings.agent.enabled, false);
  assert.equal(settings.chat.sendOnEnter, true);
});

test("workspaces normalize through the shared workspace normalizer", () => {
  const settings = normalizeAiSettings({
    workspaces: [
      { id: "ws-1", name: "日光工坊", folders: ["Notes/Solar"], permission: "full", permissionExpiresAt: 999, rag: "off" },
      { id: "ws-2" },
      "nope",
    ],
    defaultWorkspaceId: "ws-1",
  });
  assert.equal(settings.workspaces.length, 2);
  assert.equal(settings.workspaces.find((workspace) => workspace.id === "ws-1").permission, "full");
  assert.equal(settings.workspaces.find((workspace) => workspace.id === "ws-1").permissionExpiresAt, 999);
  assert.equal(settings.workspaces.find((workspace) => workspace.id === "ws-2").permission, "standard");
  assert.equal(settings.defaultWorkspaceId, "ws-1");
});

test("workspaces survive the legacy migration instead of being dropped", () => {
  const settings = migrateAiSettings({
    aiProvider: "deepseek",
    workspaces: [{ id: "keep", name: "保留", folders: ["Notes"] }],
    permission: { globalMax: "standard" },
  });
  assert.equal(settings.workspaces.length, 1);
  assert.equal(settings.workspaces[0].id, "keep");
  assert.equal(settings.permission.globalMax, "standard");
});

test("permission and agent fields are clamped, and a bad file cannot raise the ceiling", () => {
  const settings = normalizeAiSettings({
    permission: { globalMax: "root", fullExpiryMinutes: 1, confirmDestructiveInFull: false },
    agent: { enabled: true, maxSteps: 9999, maxTokens: 1, maxWallMinutes: 0, maxCostUsd: -5 },
    chat: { sendOnEnter: false },
  });
  assert.equal(settings.permission.globalMax, "full");
  assert.equal(settings.permission.fullExpiryMinutes, 5);
  assert.equal(settings.permission.confirmDestructiveInFull, false);
  assert.equal(settings.agent.enabled, true);
  assert.equal(settings.agent.maxSteps, 100);
  assert.equal(settings.agent.maxTokens, 1000);
  assert.equal(settings.agent.maxWallMinutes, 1);
  assert.equal(settings.agent.maxCostUsd, 0);
  assert.equal(settings.chat.sendOnEnter, false);
});