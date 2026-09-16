/**
 * Diagnostics: useful to read, impossible to leak from.
 *
 * The leak tests are shape-based because that is all a report writer can be
 * sure of: the error body a provider returns is not under our control, so the
 * redactor has to work on what a key looks like, not on a known value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDiagnosticsReport, redactSecrets } from "../.build/diagnostics.js";
import { defaultAiSettings } from "../.build/providerConfig.js";

test("the redactor covers key prefixes, bearer headers and query tokens", () => {
  assert.equal(redactSecrets("failed with sk-abcdef123456"), "failed with sk-***");
  assert.equal(redactSecrets("Authorization: Bearer abc.def-123"), "Authorization: Bearer ***");
  assert.equal(redactSecrets("GET /x?token=abcdef123&y=1"), "GET /x?token=***&y=1");
  assert.equal(redactSecrets("api_key=abcdef&z=1"), "api_key=***&z=1");
  assert.equal(redactSecrets("no secrets here"), "no secrets here");
});

test("the report names versions and hosts, and contains no key or full URL", () => {
  const settings = defaultAiSettings();
  settings.chat.providerId = "custom";
  settings.chat.model = "my-model";
  const report = buildDiagnosticsReport({
    hostVersion: "0.1.0",
    appVersion: "1.11.4",
    settings,
    providers: [
      {
        id: "custom",
        label: "自定义",
        protocol: "openai",
        host: "127.0.0.1:9999",
        model: "my-model",
        local: true,
        secretOrigin: "keychain",
      },
    ],
    conversations: 3,
    indexRebuilt: true,
    warnings: ["请求失败：token=abcdef123456"],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(report.includes("0.1.0"));
  assert.ok(report.includes("1.11.4"));
  assert.ok(report.includes("127.0.0.1:9999"));
  assert.ok(report.includes("钥匙串"));
  assert.ok(report.includes("会话数：3"));
  assert.equal(report.includes("abcdef123456"), false, "警告里的 token 必须脱敏");
  assert.equal(report.includes("https://"), false, "报告不打印完整端点，因为地址可能带令牌");
});