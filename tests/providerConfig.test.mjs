/**
 * Provider resolution: settings plus a key lookup become one runtime config.
 *
 * The failures asserted here are the ones a settings page cannot show: a
 * selected provider whose key was never entered, a custom row with no address,
 * a protocol the host cannot speak. Each must arrive as a sentence naming the
 * fix, not as a request that fails later.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultAiSettings,
  describeRuntime,
  hostOf,
  isSupportedProtocol,
  normalizeAiSettings,
  runtimeConfigFor,
  selectProviderRow,
} from "../.build/providerConfig.js";

const noSecret = () => null;
const someSecret = () => "sk-test";

test("an unconfigured settings object resolves to the default provider and asks for a key", () => {
  const settings = defaultAiSettings();
  assert.equal(selectProviderRow(settings, "chat").id, "deepseek");
  const result = runtimeConfigFor(settings, "chat", noSecret);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-key");
  assert.ok(result.message.includes("钥匙串"), "缺 Key 的说明要告诉用户它存在哪里");
});

test("a key makes the default provider usable without any other field", () => {
  const result = runtimeConfigFor(defaultAiSettings(), "chat", someSecret);
  assert.equal(result.ok, true);
  assert.equal(result.config.providerId, "deepseek");
  assert.equal(result.config.baseUrl, "https://api.deepseek.com");
  assert.equal(result.config.model, "deepseek-flash");
  assert.equal(result.config.authHeader, "authorization");
  assert.equal(result.config.apiKey, "sk-test");
  assert.equal(result.config.stream, true);
});

test("a local provider with no credential is usable with no key at all", () => {
  const settings = normalizeAiSettings({ chat: { providerId: "ollama" } });
  const result = runtimeConfigFor(settings, "chat", noSecret);
  assert.equal(result.ok, true);
  assert.equal(result.config.baseUrl, "http://127.0.0.1:11434");
  assert.equal(result.config.authHeader, "");
});

test("a user-added provider is usable once it has an address and a model", () => {
  const settings = normalizeAiSettings({
    chat: { providerId: "my-gw", model: "local-model" },
    providers: [{ id: "my-gw", baseUrl: "http://127.0.0.1:9999/v1", authHeader: "", authPrefix: "" }],
  });
  const result = runtimeConfigFor(settings, "chat", noSecret);
  assert.equal(result.ok, true);
  assert.equal(result.config.baseUrl, "http://127.0.0.1:9999/v1");
  assert.equal(result.config.model, "local-model");
});

test("a user-added provider with an auth header requires a key", () => {
  const settings = normalizeAiSettings({
    chat: { providerId: "my-gw", model: "m" },
    providers: [{ id: "my-gw", baseUrl: "http://127.0.0.1:9999", authHeader: "x-api-key" }],
  });
  assert.equal(runtimeConfigFor(settings, "chat", noSecret).reason, "missing-key");
  assert.equal(runtimeConfigFor(settings, "chat", someSecret).ok, true);
});

test("the three implemented protocols resolve; the unimplemented dsh is refused", () => {
  // Anthropic and Gemini have adapters now, so the "unsupported" example has to
  // be a protocol that genuinely has none -- dsh, whose native RPC is not one of
  // the three wire shapes.
  for (const providerId of ["deepseek", "openai", "anthropic", "gemini"]) {
    const result = runtimeConfigFor(normalizeAiSettings({ chat: { providerId } }), "chat", someSecret);
    assert.equal(result.ok, true, providerId);
  }
  const dsh = runtimeConfigFor(normalizeAiSettings({ chat: { providerId: "dsh" } }), "chat", someSecret);
  assert.equal(dsh.ok, false);
  assert.equal(dsh.reason, "unsupported-protocol");
  assert.equal(isSupportedProtocol("openai"), true);
  assert.equal(isSupportedProtocol("dsh"), false);
});

test("an empty custom address and an empty model each name the field to fix", () => {
  const noAddress = normalizeAiSettings({ chat: { providerId: "custom" }, providers: [{ id: "custom" }] });
  assert.equal(runtimeConfigFor(noAddress, "chat", someSecret).reason, "missing-base-url");
  const noModel = normalizeAiSettings({
    chat: { providerId: "custom" },
    providers: [{ id: "custom", baseUrl: "http://127.0.0.1:1" }],
  });
  assert.equal(runtimeConfigFor(noModel, "chat", someSecret).reason, "missing-model");
});

test("apply and embedding fall back to the chat provider, not to the table default", () => {
  const settings = normalizeAiSettings({ chat: { providerId: "ollama" } });
  assert.equal(selectProviderRow(settings, "apply").id, "ollama");
  assert.equal(selectProviderRow(settings, "embedding").id, "ollama");
  const explicit = normalizeAiSettings({ chat: { providerId: "ollama" }, apply: { providerId: "deepseek" } });
  assert.equal(selectProviderRow(explicit, "apply").id, "deepseek");
});

test("the description shows the host, never the full URL or the key", () => {
  const result = runtimeConfigFor(defaultAiSettings(), "chat", someSecret);
  const text = describeRuntime(result.config);
  assert.ok(text.includes("api.deepseek.com"));
  assert.equal(text.includes("sk-test"), false);
  assert.equal(hostOf("https://api.deepseek.com/v1?token=secret"), "api.deepseek.com");
  assert.equal(hostOf("not a url"), "(地址无效)");
});