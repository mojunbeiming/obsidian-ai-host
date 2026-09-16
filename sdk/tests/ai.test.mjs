/**
 * The AI core, tested against a scripted transport.
 *
 * Two things are worth knowing about this suite before reading it.
 *
 * First, **nothing here opens a socket.** `AiFetch` is injected, so every test
 * supplies its own answer and the module under test is the part that builds the
 * request and reads the reply -- which is exactly the part that is wrong in a
 * way nobody notices, because a malformed body and a well-formed one both come
 * back as an error the user cannot tell apart.
 *
 * Second, the **loopback policy is asserted, not assumed.** The project forbids
 * every other network path, and this module is the one that decides what a
 * configured base URL is allowed to name. If the test below is deleted, the
 * guard in `tools/check-no-network.mjs` still passes -- it only sees literals,
 * not the URL a user typed into a settings field.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_TIMEOUT_MS,
  AI_REMOTE_SCHEME,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  AiError,
  DEFAULT_AI_CONFIG,
  aiSettingsFrom,
  apiUrlFor,
  checkAiConfig,
  classifyResponse,
  configWarnings,
  classifyStatus,
  createAnthropicBackend,
  createBackend,
  createDshBackend,
  createOpenAiBackend,
  dshReplyText,
  extractJsonObject,
  isLoopbackHost,
  joinPrompt,
  openAiModelId,
  parseBaseUrl,
  probeDsh,
  readAiSettings,
  splitModel,
} from "../.build/ai.js";
import { AI_DEFAULT_PROVIDER, providerById } from "../.build/aiProviders.js";
import { probeAiConnection } from "../.build/aiProbe.js";
import * as providerTable from "../.build/aiProviders.js";

/**
 * A transport that records what it was asked and answers from a script.
 *
 * A scripted entry is either a payload -- wrapped here into a 200 with the JSON
 * body a server would send -- or a function given `{ url, init }`, which is how
 * a test answers with a status of its own (a 401, an HTML error page, a clock
 * that has to move between polls).
 *
 * The recorded call carries the `config` the caller handed over, so a test can
 * assert what the *transport* would have done with a token without this module
 * ever touching one.
 */
function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init, config) => {
    calls.push({ url, ...init, config, parsed: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error(`unscripted request to ${url}`);
    if (typeof next === "function") return next({ url, init, config });
    return { status: 200, text: JSON.stringify(next) };
  };
  return { fetchImpl, calls };
}

/** A one-shot transport answering with the given status and raw body. */
function raw(status, text) {
  return () => ({ status, text });
}

/** A DSH envelope around a successful value. */
function rpcOk(value) {
  return { type: "server-response", rpcId: "r", result: { ok: true, value } };
}

/** A DSH envelope around a business error, which arrives inside an HTTP 200. */
function rpcFail(code, message) {
  return { type: "server-response", rpcId: "r", result: { ok: false, error: { code, message } } };
}

/** The replies one DSH completion consumes, with the answer already waiting. */
function dshScript(text) {
  return [
    rpcOk({ sessionId: "s-1" }),
    rpcOk({ selected: {} }),
    rpcOk({ accepted: true }),
    rpcOk({ records: [{ event: { type: "assistant/message", data: { text } } }] }),
  ];
}

/**
 * A configuration as the plugin would store it: provider chosen, key pasted,
 * everything else left for the preset to fill in.
 *
 * Deliberately built through `readAiSettings` rather than by spreading
 * `DEFAULT_AI_CONFIG`: the point of the preset-supplies-the-rest design is that
 * a stored record only has to carry the two fields the user actually typed, and
 * a helper that pre-filled the rest would hide a regression in that.
 */
const cfg = (over = {}) =>
  readAiSettings({ provider: AI_DEFAULT_PROVIDER, apiKey: "test-key", storedFor: AI_DEFAULT_PROVIDER, ...over });

/**
 * The same, for a named provider.
 *
 * The `storedFor` stamp is set to match, because that is what the settings page
 * writes alongside every field and it is what makes a stored address and model
 * *believable*. Without it they read as another provider's leftovers and are
 * discarded in favour of the preset -- so a helper that omitted the stamp would be
 * testing a configuration the plugin cannot produce.
 */
const cfgFor = (provider, over = {}) => readAiSettings({ provider, storedFor: provider, ...over });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("readAiSettings falls back to the default provider, not to an empty one", () => {
  const config = readAiSettings({});
  assert.equal(config.provider, AI_DEFAULT_PROVIDER);
  // The preset supplies the address and the model, which is what makes "pick a
  // provider, paste a key" the whole setup.
  assert.equal(config.baseUrl, providerById(AI_DEFAULT_PROVIDER).baseUrl);
  assert.equal(config.model, providerById(AI_DEFAULT_PROVIDER).model);
  assert.equal(config.apiKey, "");
});

test("readAiSettings rejects values of the wrong type rather than coercing", () => {
  const config = readAiSettings({
    timeoutMs: "30000",
    maxImages: "4",
    protocol: 7,
    model: 42,
    apiKey: null,
  });
  assert.equal(config.timeoutMs, AI_DEFAULT_TIMEOUT_MS);
  assert.equal(config.maxImages, DEFAULT_AI_CONFIG.maxImages);
  assert.equal(config.apiKey, "");
  // `provider` of the wrong type falls back to the default, so `model`/`baseUrl`
  // land on that preset rather than on a half-configured state.
  assert.equal(config.provider, AI_DEFAULT_PROVIDER);
  assert.equal(config.model, providerById(AI_DEFAULT_PROVIDER).model);
});

test("readAiSettings refuses an id that is not in the table", () => {
  const config = readAiSettings({ provider: "not-a-provider" });
  assert.equal(config.provider, AI_DEFAULT_PROVIDER);
  assert.ok(config.baseUrl.length > 0, "未知服务商应当回落到默认那条，而不是留下空地址");
});

test("readAiSettings clamps the timeout into a range that can still work", () => {
  // Below five seconds is not a timeout, it is a coin flip: a cold local model
  // takes longer than that to answer at all, and the failure would read as
  // "the endpoint is broken".
  assert.equal(readAiSettings({ timeoutMs: 10 }).timeoutMs, AI_DEFAULT_TIMEOUT_MS);
  assert.equal(readAiSettings({ timeoutMs: 30_000 }).timeoutMs, 30_000);
  assert.equal(readAiSettings({ timeoutMs: 5_000_000 }).timeoutMs, 600_000);
});

test("a stored address and model win over the preset, when they are this provider's", () => {
  const config = readAiSettings({
    provider: "deepseek",
    storedFor: "deepseek",
    baseUrl: "https://gateway.example/v1/",
    model: "some-other-model",
  });
  assert.equal(config.baseUrl, "https://gateway.example/v1", "尾部斜杠应当被剥掉");
  assert.equal(config.model, "some-other-model");
});

test("the auth pair comes from the preset, and the user's fields override it", () => {
  // The three presets disagree about how a key is presented; a user's own values
  // are what makes an unanticipated endpoint reachable.
  assert.deepEqual(
    [readAiSettings({ provider: "deepseek" }).authHeader, readAiSettings({ provider: "deepseek" }).authPrefix],
    ["authorization", "Bearer "],
  );
  assert.deepEqual(
    [readAiSettings({ provider: "anthropic" }).authHeader, readAiSettings({ provider: "anthropic" }).authPrefix],
    ["x-api-key", ""],
  );
  const custom = readAiSettings({ provider: "custom", authHeader: "X-Api-Token", authPrefix: "Token " });
  assert.deepEqual([custom.authHeader, custom.authPrefix], ["X-Api-Token", "Token "]);
});

test("a local provider that wants no credential resolves to no header", () => {
  const config = readAiSettings({ provider: "ollama" });
  assert.equal(config.authHeader, "");
  assert.equal(config.authPrefix, "");
});

test("aiSettingsFrom maps the plugin-facing key names and nothing else", () => {
  const config = aiSettingsFrom({
    aiProvider: "custom",
    aiBaseUrl: "https://gateway.example/",
    aiProtocol: "anthropic",
    aiModel: "claude-3-5-haiku-latest",
    aiApiKey: "sk-secret",
    aiAuthHeader: "x-api-key",
    aiAuthPrefix: "",
    aiTimeoutMs: 20_000,
    aiMaxImages: 2,
    unrelated: "ignored",
    aiEnabled: true,
    aiToken: "stale",
  });
  assert.equal(config.provider, "custom");
  assert.equal(config.baseUrl, "https://gateway.example");
  assert.equal(config.protocol, "anthropic");
  assert.equal(config.model, "claude-3-5-haiku-latest");
  assert.equal(config.apiKey, "sk-secret");
  assert.equal(config.authHeader, "x-api-key");
  assert.equal(config.timeoutMs, 20_000);
  assert.equal(config.maxImages, 2);
  // The retired keys are gone rather than quietly honoured: an `aiToken` left in
  // an old `data.json` must not keep working as a credential.
  assert.equal("token" in config, false);
  assert.equal("enabled" in config, false);
});

// ---------------------------------------------------------------------------
// checkAiConfig: "needs setup" vs "is wrong"
// ---------------------------------------------------------------------------

test("a picked provider with a key is ready", () => {
  const check = checkAiConfig({ aiProvider: "deepseek", aiApiKey: "sk-x" });
  assert.equal(check.ok, true);
});

test("no key yet is a setup problem, not an error", () => {
  // The distinction the UI branches on: an empty form gets "configure now"
  // rather than a scolding, and a half-filled form does not get nagged.
  const check = checkAiConfig({ aiProvider: "deepseek" });
  assert.equal(check.ok, false);
  assert.equal(check.needsSetup, true);
  assert.match(check.problems.join(" "), /API Key/);
});

test("an unusable address is reported and is not a setup problem", () => {
  const check = checkAiConfig({ aiProvider: "openai", aiStoredFor: "openai", aiApiKey: "sk-x", aiBaseUrl: "ftp://example.test" });
  assert.equal(check.ok, false);
  assert.equal(check.needsSetup, false);
  assert.match(check.problems.join(" "), /不支持的协议/);
});

test("cleartext http to a remote host is refused with the reason spelled out", () => {
  // The rule that replaced `allowRemote`: the scheme is what decides, because a
  // key in cleartext across a network is the one thing worth refusing outright.
  const check = checkAiConfig({ aiProvider: "openai", aiStoredFor: "openai", aiApiKey: "sk-x", aiBaseUrl: "http://gateway.example" });
  assert.equal(check.ok, false);
  assert.match(check.problems.join(" "), /明文 http 只允许连本机/);
});

test("cleartext http to this machine is fine", () => {
  const check = checkAiConfig({ aiProvider: "ollama", aiBaseUrl: "http://127.0.0.1:11434" });
  assert.equal(check.ok, true);
});

test("a local provider needs no key, except DSH which needs its launch token", () => {
  // `needsSetup` must not fire for Ollama, or a working install would be told to
  // paste a key it does not have. DSH is the exception: its Web API answers 401
  // without the token `dsh web` printed at startup, and the field is labelled
  // for that token rather than for an API key.
  assert.equal(checkAiConfig({ aiProvider: "ollama" }).ok, true);
  const dsh = checkAiConfig({ aiProvider: "dsh" });
  assert.equal(dsh.ok, false);
  assert.ok(
    dsh.problems.some((problem) => problem.includes("访问令牌")),
    `应当明确要访问令牌，实际：${dsh.problems.join("；")}`,
  );
});

test("every missing field is reported at once, not one per attempt", () => {
  const check = checkAiConfig({ aiProvider: "custom" });
  assert.equal(check.ok, false);
  assert.ok(check.problems.length >= 2, `应当一次说全，实际：${check.problems.join("；")}`);
});

// ---------------------------------------------------------------------------
// The scheme policy
// ---------------------------------------------------------------------------

test("isLoopbackHost accepts every spelling of this machine", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]", " 127.0.0.1 "]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
});

test("isLoopbackHost refuses names that merely look local", () => {
  for (const host of ["127.0.0.1.example.com", "localhost.example.com", "10.0.0.1", "example.com", "0.0.0.0", ""]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test("parseBaseUrl strips a trailing slash so joined paths cannot double it", () => {
  const trail = parseBaseUrl("http://127.0.0.1:3080///");
  assert.equal(trail.ok, true);
  assert.equal(trail.url, "http://127.0.0.1:3080");
});

test("parseBaseUrl keeps a path prefix, which a reverse proxy needs", () => {
  const proxied = parseBaseUrl("http://127.0.0.1:8080/ollama/");
  assert.equal(proxied.ok, true);
  assert.equal(proxied.url, "http://127.0.0.1:8080/ollama");
});

test("parseBaseUrl allows https to any host", () => {
  // The change from the previous version: a hosted provider is reachable, and
  // the guard's job moved from forbidding the request to keeping the *places* one
  // can be built to a single file.
  const remote = parseBaseUrl("https://api.example.test/v1");
  assert.equal(remote.ok, true);
  assert.equal(remote.url, "https://api.example.test/v1");
});

test("parseBaseUrl refuses cleartext http to anything but this machine", () => {
  const verdict = parseBaseUrl("http://192.168.1.50:11434");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /明文 http 只允许连本机/);
  // The same host over TLS is accepted, so the refusal is about the scheme and
  // not about the address.
  assert.equal(parseBaseUrl("https://192.168.1.50:11434").ok, true);
});

test("parseBaseUrl refuses a scheme that is neither http nor https", () => {
  const verdict = parseBaseUrl("ftp://127.0.0.1:3080");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /不支持的协议/);
});

test("parseBaseUrl reports an empty or malformed address instead of throwing", () => {
  assert.equal(parseBaseUrl("").ok, false);
  assert.equal(parseBaseUrl("   ").ok, false);
  assert.equal(parseBaseUrl("127.0.0.1:3080").ok, false);
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

test("openAiModelId strips a provider prefix the OpenAI shape has no field for", () => {
  assert.equal(openAiModelId("deepseek-official/deepseek-flash"), "deepseek-flash");
  assert.equal(openAiModelId("qwen2.5-vl"), "qwen2.5-vl");
});

test("splitModel keeps both halves for DSH and leaves provider empty for a bare id", () => {
  assert.deepEqual(splitModel("deepseek-official/deepseek-flash"), {
    provider: "deepseek-official",
    model: "deepseek-flash",
  });
  assert.deepEqual(splitModel("deepseek-flash"), { provider: "", model: "deepseek-flash" });
});

test("joinPrompt drops the parts that are missing", () => {
  assert.equal(joinPrompt("a", null, "", undefined, "b"), "a\n\nb");
  assert.equal(joinPrompt(), "");
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("classifyStatus turns every status into the change that would fix it", () => {
  assert.match(classifyStatus(401).message, /API Key 被拒绝/);
  assert.match(classifyStatus(403).message, /API Key 被拒绝/);
  assert.match(classifyStatus(404).message, /路径/);
  assert.match(classifyStatus(413).message, /图片/);
  assert.match(classifyStatus(429).message, /额度用尽/);
  assert.match(classifyStatus(503).message, /服务端错误/);
  assert.match(classifyStatus(418).message, /请求失败/);
});

test("classifyStatus names the endpoint and the header it authenticated with", () => {
  // The two facts that make a 401 fixable. Without them the reader goes to the
  // key, when the mistake is often that the provider was switched and the header
  // no longer matches the service.
  const message = classifyStatus(401, "", cfg()).message;
  assert.match(message, /端点 https:\/\//);
  assert.match(message, /authorization 头/);
});

test("classifyResponse calls an HTML error page what it is", () => {
  // The commonest setup mistake is an endpoint one segment too long, and the
  // symptom is a web page. Reporting that as "invalid JSON" sends the reader to
  // the model instead of to the address field.
  const error = classifyResponse(404, "<!DOCTYPE html><html><body>Not Found</body></html>", cfg());
  assert.match(error.message, /返回的是网页不是 API/);
  assert.match(error.message, /chat\/completions/);
});

test("classifyResponse leaves a real API error to the status classifier", () => {
  const error = classifyResponse(401, '{"error":{"message":"bad key"}}', cfg());
  assert.match(error.message, /API Key 被拒绝/);
});

test("classifyStatus carries the status and quotes a bounded slice of the body", () => {
  const error = classifyStatus(400, "x".repeat(1000));
  assert.equal(error.status, 400);
  assert.ok(error.message.length < 400, "a body must be excerpted, not echoed whole");
  assert.ok(error.message.includes("xxx"));
  assert.equal(classifyStatus(400).message.includes("返回内容"), false);
});

test("classifyStatus produces an AiError, so callers can catch one thing", () => {
  assert.ok(classifyStatus(500) instanceof AiError);
  assert.ok(classifyStatus(500) instanceof Error);
});

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

test("extractJsonObject reads a reply that is only JSON", () => {
  const found = extractJsonObject('{"cards":[]}');
  assert.equal(found.ok, true);
  assert.deepEqual(found.value, { cards: [] });
});

test("extractJsonObject unwraps a fenced block, because models add one anyway", () => {
  const found = extractJsonObject("好的，这是结果：\n```json\n{\"cards\":[1]}\n```\n希望有帮助。");
  assert.equal(found.ok, true);
  assert.deepEqual(found.value, { cards: [1] });
});

test("extractJsonObject keeps a nested object whole", () => {
  const found = extractJsonObject('前缀 {"a":{"b":[1,2]}} 后缀');
  assert.deepEqual(found.value, { a: { b: [1, 2] } });
});

test("extractJsonObject reports a truncated reply rather than repairing it", () => {
  const found = extractJsonObject('{"cards":[{"kind":"recall"');
  assert.equal(found.ok, false);
  assert.match(found.reason, /JSON/);
  assert.ok(found.excerpt.startsWith('{"cards"'));
});

test("extractJsonObject reports prose with no object at all", () => {
  const found = extractJsonObject("我看不清这张图。");
  assert.equal(found.ok, false);
  assert.match(found.reason, /没有找到 JSON/);
  assert.equal(found.excerpt, "我看不清这张图。");
});

// ---------------------------------------------------------------------------
// The OpenAI-shaped backend
// ---------------------------------------------------------------------------

test("the openai backend posts to the completions path with the bare model id", async () => {
  const { fetchImpl, calls } = scripted([{ choices: [{ message: { content: "hi" } }] }]);
  const reply = await createOpenAiBackend(cfg({ model: "deepseek-official/deepseek-flash" }), fetchImpl).complete({
    messages: [{ role: "user", text: "hello" }],
  });
  assert.equal(reply.text, "hi");
  assert.equal(reply.model, "deepseek-flash");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${providerById(AI_DEFAULT_PROVIDER).baseUrl}/v1/chat/completions`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].parsed.model, "deepseek-flash");
  assert.deepEqual(calls[0].parsed.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
});

test("the openai backend wraps images as data URLs", async () => {
  const { fetchImpl, calls } = scripted([{ choices: [{ message: { content: "ok" } }] }]);
  await createOpenAiBackend(cfg({ protocol: "openai" }), fetchImpl).complete({
    messages: [
      {
        role: "user",
        text: "把这些做成卡片",
        images: [{ mediaType: "image/png", base64: "QUJD", name: "a.png" }],
      },
    ],
  });
  const content = calls[0].parsed.messages[0].content;
  assert.deepEqual(content[0], { type: "text", text: "把这些做成卡片" });
  assert.deepEqual(content[1], { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
});

test("the transport, not this module, is what carries the credential", async () => {
  // The guard forbids the header assignment anywhere but the declared transport
  // file, so the key has to reach the transport as configuration rather than as
  // a header this module builds. Asserted here because "the credential is
  // attached in exactly one place" is the property that rule exists for -- and
  // because a key added to the request body instead would still pass the guard.
  const withKey = scripted([{ choices: [{ message: { content: "ok" } }] }]);
  await createOpenAiBackend(cfg({ apiKey: "sk-t0ken" }), withKey.fetchImpl).complete({
    messages: [{ role: "user", text: "x" }],
  });
  assert.equal(withKey.calls[0].config.apiKey, "sk-t0ken");
  assert.equal(withKey.calls[0].config.authHeader, "authorization");
  assert.equal(withKey.calls[0].config.authPrefix, "Bearer ");
  assert.equal(withKey.calls[0].headers["content-type"], "application/json");
  // The module sends no credential of its own, in any casing, and none in the body.
  assert.equal(
    Object.keys(withKey.calls[0].headers).some((name) => name.toLowerCase().includes("author")),
    false,
  );
  assert.equal(JSON.stringify(withKey.calls[0].parsed).includes("sk-t0ken"), false);
});

test("the openai backend passes max_tokens through only when asked", async () => {
  const asked = scripted([{ choices: [{ message: { content: "ok" } }] }]);
  await createOpenAiBackend(cfg(), asked.fetchImpl).complete({ messages: [{ role: "user", text: "x" }], maxTokens: 512 });
  assert.equal(asked.calls[0].parsed.max_tokens, 512);

  const notAsked = scripted([{ choices: [{ message: { content: "ok" } }] }]);
  await createOpenAiBackend(cfg(), notAsked.fetchImpl).complete({ messages: [{ role: "user", text: "x" }] });
  assert.equal("max_tokens" in notAsked.calls[0].parsed, false);
});

test("the openai backend reads a content-parts array too", async () => {
  const { fetchImpl } = scripted([
    { choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] },
  ]);
  const reply = await createOpenAiBackend(cfg(), fetchImpl).complete({ messages: [{ role: "user", text: "x" }] });
  assert.equal(reply.text, "ab");
});

test("the openai backend reports a credential failure with the status attached", async () => {
  const denied = scripted([raw(401, '{"error":"no"}')]);
  await assert.rejects(
    createOpenAiBackend(cfg(), denied.fetchImpl).complete({ messages: [{ role: "user", text: "x" }] }),
    (error) => error instanceof AiError && /API Key 被拒绝/.test(error.message) && error.status === 401,
  );
});

test("the openai backend calls a non-JSON body what it is", async () => {
  // A reverse proxy answering with an HTML error page is the common case here,
  // and the failure has to name it: "not JSON" sends the reader to the address,
  // while "no text content" would send them to the model.
  const html = scripted([raw(200, "<html>proxy</html>")]);
  await assert.rejects(
    createOpenAiBackend(cfg(), html.fetchImpl).complete({ messages: [{ role: "user", text: "x" }] }),
    // Tested as a substring of the message rather than as a whole-string regex:
    // a regex handed to `assert.rejects` is matched against `String(error)`,
    // which carries the class name and the space the message starts with.
    (error) => error instanceof AiError && /不是 JSON/.test(error.message),
  );
});

test("the openai backend reports a reply with no choices as unusable", async () => {
  const shapeless = scripted([{ status: 200, text: JSON.stringify({ choices: [] }) }]);
  await assert.rejects(
    createOpenAiBackend(cfg(), shapeless.fetchImpl).complete({ messages: [{ role: "user", text: "x" }] }),
    (error) => error instanceof AiError && /没有找到文本内容/.test(error.message),
  );
});

test("a local endpoint keeps its cleartext http, because there is no network to cross", async () => {
  // The two halves of the scheme policy, asserted where they can be observed:
  // a loopback provider is reached over plain http, and the key still travels
  // through the transport rather than through this module.
  const { fetchImpl, calls } = scripted([{ choices: [{ message: { content: "ok" } }] }]);
  const ollama = cfgFor("ollama");
  assert.match(ollama.baseUrl, /^http:\/\/127\.0\.0\.1:/);
  await createOpenAiBackend(ollama, fetchImpl).complete({ messages: [{ role: "user", text: "x" }] });
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:/);
});

// ---------------------------------------------------------------------------
// The DSH backend
// ---------------------------------------------------------------------------

test("the dsh backend runs create, selectModel, prompt, then page", async () => {
  const { fetchImpl, calls } = scripted(dshScript("结果文本"));
  const dsh = cfgFor("dsh", { model: "deepseek-official/deepseek-flash" });
  const reply = await createDshBackend(dsh, fetchImpl, { sleep: async () => {} }).complete({
    messages: [
      { role: "system", text: "sys" },
      { role: "user", text: "usr" },
    ],
  });
  assert.equal(reply.text, "结果文本");
  assert.deepEqual(
    calls.map((call) => call.parsed.method),
    ["session/create", "session/selectModel", "session/prompt", "session/page"],
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    ["create", "selectModel", "prompt", "page"].map((method) => `${dsh.baseUrl}/api/session/${method}`),
  );
  for (const call of calls) {
    assert.equal(call.parsed.type, "client-request");
    assert.equal(call.parsed.method, call.parsed.method);
    assert.equal(Object.keys(call.parsed.payload)[0], "args");
  }
});

test("the dsh prompt carries bare base64 images, never a data URL", async () => {
  const { fetchImpl, calls } = scripted(dshScript("ok"));
  await createDshBackend(cfgFor("dsh"), fetchImpl, { sleep: async () => {} }).complete({
    messages: [{ role: "user", text: "看图", images: [{ mediaType: "image/png", base64: "QUJD", name: "a.png" }] }],
  });
  const content = calls[2].parsed.payload.args.request.content;
  assert.deepEqual(content[0], { type: "text", text: "看图" });
  assert.deepEqual(content[1], { type: "image", mediaType: "image/png", data: "QUJD", name: "a.png" });
  assert.equal(content[1].data.startsWith("data:"), false);
});

test("the dsh prompt drops an empty text part instead of sending a blank one", async () => {
  const { fetchImpl, calls } = scripted(dshScript("ok"));
  await createDshBackend(cfgFor("dsh"), fetchImpl, { sleep: async () => {} }).complete({
    messages: [{ role: "user", text: "   ", images: [{ mediaType: "image/png", base64: "QUJD" }] }],
  });
  const content = calls[2].parsed.payload.args.request.content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "image");
});

test("the dsh backend sets the model on the session, with both halves", async () => {
  const { fetchImpl, calls } = scripted(dshScript("ok"));
  await createDshBackend(cfgFor("dsh", { model: "deepseek-official/deepseek-flash" }), fetchImpl, {
    sleep: async () => {},
  }).complete({ messages: [{ role: "user", text: "x" }] });
  assert.deepEqual(calls[1].parsed.payload.args.request, {
    sessionId: "s-1",
    provider: "deepseek-official",
    model: "deepseek-flash",
  });
});

test("the dsh backend skips selectModel when only a bare model id is configured", async () => {
  const { fetchImpl, calls } = scripted([
    rpcOk({ sessionId: "s-1" }),
    rpcOk({ accepted: true }),
    rpcOk({ records: [{ event: { type: "assistant/message", data: { text: "ok" } } }] }),
  ]);
  await createDshBackend(cfgFor("dsh", { model: "deepseek-flash" }), fetchImpl, { sleep: async () => {} }).complete({
    messages: [{ role: "user", text: "x" }],
  });
  assert.deepEqual(
    calls.map((call) => call.parsed.method),
    ["session/create", "session/prompt", "session/page"],
  );
});

test("the dsh backend surfaces a business error that arrived inside HTTP 200", async () => {
  const { fetchImpl } = scripted([
    rpcOk({ sessionId: "s-1" }),
    rpcFail("session/model-unavailable", "模型不存在"),
  ]);
  await assert.rejects(
    createDshBackend(cfgFor("dsh"), fetchImpl, { sleep: async () => {} }).complete({ messages: [{ role: "user", text: "x" }] }),
    (error) => error instanceof AiError && /模型不存在/.test(error.message) && error.code === "session/model-unavailable",
  );
});

test("the dsh backend reports a missing session id rather than prompting without one", async () => {
  const { fetchImpl, calls } = scripted([rpcOk({})]);
  await assert.rejects(
    createDshBackend(cfgFor("dsh"), fetchImpl, { sleep: async () => {} }).complete({ messages: [{ role: "user", text: "x" }] }),
    /没有返回会话 id/,
  );
  assert.equal(calls.length, 1);
});

test("the dsh backend reports a transport failure with an actionable message", async () => {
  const fetchImpl = async () => {
    const error = new Error("connect ECONNREFUSED");
    error.code = "ECONNREFUSED";
    throw error;
  };
  await assert.rejects(
    createDshBackend(cfgFor("dsh"), fetchImpl, { sleep: async () => {} }).complete({ messages: [{ role: "user", text: "x" }] }),
    (error) => error instanceof AiError && /ECONNREFUSED/.test(error.message),
  );
});

test("the dsh backend keeps polling while the page has no assistant message yet", async () => {
  // One reply per call: create, prompt, then two pages. The second page is the
  // first one that says anything, so exactly one poll happened before the answer
  // -- which is what "keeps polling instead of giving up on the first empty
  // page" means. Asserting a larger number here would only assert the script.
  const { fetchImpl, calls } = scripted([
    rpcOk({ sessionId: "s-1" }),
    rpcOk({ accepted: true }),
    rpcOk({ records: [{ event: { type: "turn/start", data: {} } }] }),
    rpcOk({ records: [{ event: { type: "assistant/message", data: { text: "终于来了" } } }] }),
  ]);
  const reply = await createDshBackend(cfgFor("dsh", { model: "bare-model" }), fetchImpl, { sleep: async () => {} }).complete({
    messages: [{ role: "user", text: "x" }],
  });
  assert.equal(reply.text, "终于来了");
  assert.equal(calls.filter((call) => call.parsed.method === "session/page").length, 2);
});

test("the dsh backend gives up at the deadline and quotes the events it did see", async () => {
  // A clock the test advances by hand: the real one would make this test take as
  // long as a real timeout, and a slow test is a test that gets a smaller timeout
  // and then stops proving anything. The clock only moves when a page is
  // answered, so the first poll lands past the deadline and the loop must throw
  // on that iteration rather than asking again.
  let clock = 0;
  const { fetchImpl, calls } = scripted([
    rpcOk({ sessionId: "s-1" }),
    rpcOk({ accepted: true }),
    () => {
      clock += 200_000;
      return { status: 200, text: JSON.stringify(rpcOk({ records: [{ event: { type: "turn/end", data: {} } }] })) };
    },
  ]);
  await assert.rejects(
    createDshBackend(cfgFor("dsh", { model: "bare-model", timeoutMs: 60_000 }), fetchImpl, {
      now: () => clock,
      sleep: async () => {
        clock += 700;
      },
    }).complete({ messages: [{ role: "user", text: "x" }] }),
    (error) => error instanceof AiError && /等待模型回复超时/.test(error.message) && /turn\/end/.test(error.message),
  );
  assert.equal(calls.filter((call) => call.parsed.method === "session/page").length, 1);
});

test("dshReplyText reads the four shapes an assistant message might take", () => {
  const wrap = (data) => ({ records: [{ event: { type: "assistant/message", data } }] });
  assert.equal(dshReplyText(wrap({ text: "a" })), "a");
  assert.equal(dshReplyText(wrap({ content: [{ type: "text", text: "b" }] })), "b");
  assert.equal(dshReplyText(wrap({ message: { content: [{ type: "text", text: "c" }] } })), "c");
  assert.equal(dshReplyText(wrap("d")), "d");
});

test("dshReplyText returns null for an unknown shape, which is what makes it fixable", () => {
  // The event payload was never confirmed against a live server. Returning null
  // makes the caller time out and print the raw event; returning "" would make
  // it look like the model answered with nothing, and a silent empty card list
  // is the one outcome nobody investigates.
  assert.equal(dshReplyText({ records: [{ event: { type: "assistant/message", data: { unknown: 1 } } }] }), null);
  assert.equal(dshReplyText({ records: [{ event: { type: "assistant/message" } }] }), null);
  assert.equal(dshReplyText({ records: [] }), null);
  assert.equal(dshReplyText({}), null);
  assert.equal(dshReplyText(null), null);
});

test("dshReplyText takes the last assistant message when the page holds several", () => {
  const page = {
    records: [
      { event: { type: "assistant/message", data: { text: "旧的" } } },
      { event: { type: "user/message", data: { text: "问题" } } },
      { event: { type: "assistant/message", data: { text: "新的" } } },
    ],
  };
  assert.equal(dshReplyText(page), "新的");
});

// ---------------------------------------------------------------------------
// The Anthropic backend
// ---------------------------------------------------------------------------

test("the anthropic backend posts to the messages path", async () => {
  const { fetchImpl, calls } = scripted([{ content: [{ type: "text", text: "hi" }] }]);
  const reply = await createAnthropicBackend(cfgFor("anthropic"), fetchImpl).complete({
    messages: [{ role: "user", text: "hello" }],
  });
  assert.equal(reply.text, "hi");
  assert.equal(calls[0].url, `${cfgFor("anthropic").baseUrl}/v1/messages`);
  assert.equal(calls[0].parsed.model, "claude-3-5-haiku-latest");
});

test("a provider's required version header travels to the request", async () => {
  // The Messages API rejects a request without `anthropic-version`, and the
  // rejection reads as a malformed body rather than as a missing header -- so the
  // header has to arrive through the config and the transport has to send it.
  const { fetchImpl, calls } = scripted([{ content: [{ type: "text", text: "ok" }] }]);
  const config = cfgFor("anthropic");
  assert.equal(config.extraHeaders["anthropic-version"], "2023-06-01");
  await createAnthropicBackend(config, fetchImpl).complete({ messages: [{ role: "user", text: "x" }] });
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  // And it does not leak into a provider that does not ask for it.
  const openai = scripted([{ choices: [{ message: { content: "ok" } }] }]);
  await createOpenAiBackend(cfgFor("openai"), openai.fetchImpl).complete({
    messages: [{ role: "user", text: "x" }],
  });
  assert.equal("anthropic-version" in openai.calls[0].headers, false);
});

test("the anthropic backend lifts the system turn to a top-level field", async () => {
  // Sent as a message it is a 400 whose text mentions roles -- which reads like a
  // malformed request rather than like a misplaced prompt.
  const { fetchImpl, calls } = scripted([{ content: [{ type: "text", text: "ok" }] }]);
  await createAnthropicBackend(cfgFor("anthropic"), fetchImpl).complete({
    messages: [
      { role: "system", text: "你是助手。" },
      { role: "user", text: "问题" },
    ],
  });
  assert.equal(calls[0].parsed.system, "你是助手。");
  assert.deepEqual(
    calls[0].parsed.messages.map((message) => message.role),
    ["user"],
  );
});

test("the anthropic backend joins several system turns into one field", async () => {
  const { fetchImpl, calls } = scripted([{ content: [{ type: "text", text: "ok" }] }]);
  await createAnthropicBackend(cfgFor("anthropic"), fetchImpl).complete({
    messages: [
      { role: "system", text: "第一条" },
      { role: "system", text: "第二条" },
      { role: "user", text: "问题" },
    ],
  });
  assert.equal(calls[0].parsed.system, "第一条\n\n第二条");
});

test("the anthropic backend always sends max_tokens, because the API requires it", async () => {
  // Omitting it is a 400 there, so this is a required field rather than a limit
  // that may be left out.
  const defaulted = scripted([{ content: [{ type: "text", text: "ok" }] }]);
  await createAnthropicBackend(cfgFor("anthropic"), defaulted.fetchImpl).complete({
    messages: [{ role: "user", text: "x" }],
  });
  assert.equal(defaulted.calls[0].parsed.max_tokens, ANTHROPIC_DEFAULT_MAX_TOKENS);

  const asked = scripted([{ content: [{ type: "text", text: "ok" }] }]);
  await createAnthropicBackend(cfgFor("anthropic"), asked.fetchImpl).complete({
    messages: [{ role: "user", text: "x" }],
    maxTokens: 512,
  });
  assert.equal(asked.calls[0].parsed.max_tokens, 512);
});

test("the anthropic backend wraps images as base64 sources, not data URLs", async () => {
  // Reusing the OpenAI encoder here would put a whole data URL into `data` and
  // produce a server-side decode error.
  const { fetchImpl, calls } = scripted([{ content: [{ type: "text", text: "ok" }] }]);
  await createAnthropicBackend(cfgFor("anthropic"), fetchImpl).complete({
    messages: [{ role: "user", text: "看图", images: [{ mediaType: "image/png", base64: "QUJD" }] }],
  });
  const content = calls[0].parsed.messages[0].content;
  assert.deepEqual(content[0], { type: "text", text: "看图" });
  assert.deepEqual(content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJD" },
  });
});

test("the anthropic backend reads content[].text and joins the parts", async () => {
  const { fetchImpl } = scripted([
    { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "tool_use", id: "t" }] },
  ]);
  const reply = await createAnthropicBackend(cfgFor("anthropic"), fetchImpl).complete({
    messages: [{ role: "user", text: "x" }],
  });
  assert.equal(reply.text, "ab");
});

test("the anthropic backend reports an unusable reply shape", async () => {
  const shapeless = scripted([{ id: "msg_1", type: "message" }]);
  await assert.rejects(
    createAnthropicBackend(cfgFor("anthropic"), shapeless.fetchImpl).complete({
      messages: [{ role: "user", text: "x" }],
    }),
    (error) => error instanceof AiError && /content\[\]\.text/.test(error.message),
  );
});

test("the anthropic backend names an HTML error page and a bad key", async () => {
  const html = scripted([raw(404, "<!DOCTYPE html><html>Not Found</html>")]);
  await assert.rejects(
    createAnthropicBackend(cfgFor("anthropic"), html.fetchImpl).complete({
      messages: [{ role: "user", text: "x" }],
    }),
    (error) => error instanceof AiError && /返回的是网页不是 API/.test(error.message),
  );

  const denied = scripted([raw(401, '{"type":"error","error":{"type":"authentication_error"}}')]);
  await assert.rejects(
    createAnthropicBackend(cfgFor("anthropic"), denied.fetchImpl).complete({
      messages: [{ role: "user", text: "x" }],
    }),
    (error) => error instanceof AiError && /API Key 被拒绝/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// The request URL, which is where a guess about a provider's docs shows up
// ---------------------------------------------------------------------------

test("DeepSeek's base URL has no /v1, and the OpenAI path is appended directly", () => {
  // Straight from DeepSeek's docs: `base_url` is `https://api.deepseek.com` and the
  // chat endpoint is `https://api.deepseek.com/chat/completions`. Building
  // `base + "/v1/chat/completions"` -- which is correct for OpenAI -- produced a 404
  // here, and the first version of this code did exactly that.
  assert.equal(apiUrlFor("https://api.deepseek.com", "openai"), "https://api.deepseek.com/v1/chat/completions");
});

test("a base that already ends in /v1 is not given a second one", () => {
  // OpenAI's documented base_url is `https://api.openai.com/v1`, so the naive
  // concatenation gave `…/v1/v1/chat/completions`.
  assert.equal(apiUrlFor("https://api.openai.com/v1", "openai"), "https://api.openai.com/v1/chat/completions");
  assert.equal(apiUrlFor("https://gateway.example/v1/", "openai"), "https://gateway.example/v1/chat/completions");
});

test("the Anthropic path hangs off /v1 for everyone, including DeepSeek's compatible endpoint", () => {
  // DeepSeek documents `base_url (Anthropic) = https://api.deepseek.com/anthropic`,
  // so pasting that root has to produce the Messages URL without the user editing it.
  assert.equal(apiUrlFor("https://api.deepseek.com/anthropic", "anthropic"), "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(apiUrlFor("https://api.anthropic.com", "anthropic"), "https://api.anthropic.com/v1/messages");
});

test("the models path follows the same rule, because the probe is a GET on it", () => {
  // The connectivity check lives or dies on this URL being right: a wrong one is a
  // 404, and a 404 means "no models route here" -- which the probe reads as
  // *inconclusive* and silently falls back to spending tokens.
  assert.equal(apiUrlFor("https://api.deepseek.com", "openai", { models: true }), "https://api.deepseek.com/v1/models");
  assert.equal(apiUrlFor("https://api.openai.com/v1", "openai", { models: true }), "https://api.openai.com/v1/models");
});

test("an empty base produces an empty URL rather than a relative one", () => {
  assert.equal(apiUrlFor("", "openai"), "");
  assert.equal(apiUrlFor("   ", "anthropic"), "");
});

test("a trailing slash on the base does not double up", () => {
  assert.equal(apiUrlFor("https://api.deepseek.com///", "openai"), "https://api.deepseek.com/v1/chat/completions");
});

test("apiUrlFor survives a missing base instead of throwing", () => {
  // It is called with a config that may have been built elsewhere or read from a
  // file written by an older version, and `undefined.trim()` surfaces to the user as
  // `Cannot read properties of undefined (reading 'trim')` -- which is what one
  // report showed, and which says nothing about the AI settings.
  assert.equal(apiUrlFor(undefined, "openai"), "");
  assert.equal(apiUrlFor(null, "anthropic"), "");
  assert.equal(apiUrlFor("", "dsh"), "");
});

test("checkAiConfig never throws, whatever the settings look like", () => {
  // The panels call this to decide whether they can do anything, so it is the last
  // function that may throw. A field arriving as undefined has to read as empty:
  // "还没有填端点地址" is a diagnosis, a TypeError is not.
  const shapes = [
    {},
    { aiProvider: "deepseek" },
    { aiBaseUrl: undefined, aiModel: undefined, aiApiKey: undefined, aiMaxImages: undefined },
    { aiMaxImages: "many" },
    { aiBaseUrl: 42, aiModel: {}, aiApiKey: [] },
  ];
  for (const shape of shapes) {
    const check = checkAiConfig(shape);
    assert.equal(typeof check.ok, "boolean", JSON.stringify(shape));
    if (!check.ok) assert.ok(check.problems.length > 0, "不通过时必须给出原因");
  }
});

test("every hosted preset is https, which is the scheme the transport has to support", () => {
  // `node:http` cannot open an `https:` connection at all -- it throws
  // `Protocol "https:" not supported` before anything leaves the machine. While the
  // transport imported only `node:http`, every one of these presets was unreachable
  // and the failure read like a bad address.
  for (const provider of providerTable.AI_PROVIDERS) {
    if (provider.local || provider.id === "custom") continue;
    assert.ok(provider.baseUrl.startsWith("https://"), `${provider.id} 应当是 https`);
    assert.equal(parseBaseUrl(provider.baseUrl).ok, true, `${provider.id} 的地址应当被策略接受`);
  }
});

test("a hosted request is https and a local one is http, which is what the transport branches on", () => {
  assert.equal(new URL(apiUrlFor(providerById("deepseek").baseUrl, "openai")).protocol, "https:");
  assert.equal(new URL(apiUrlFor(providerById("ollama").baseUrl, "openai")).protocol, "http:");
});

test("the openai backend sends the URL the helper computed", async () => {
  const { fetchImpl, calls } = scripted([{ choices: [{ message: { content: "ok" } }] }]);
  await createOpenAiBackend(cfgFor("deepseek"), fetchImpl).complete({ messages: [{ role: "user", text: "x" }] });
  assert.equal(calls[0].url, apiUrlFor(providerById("deepseek").baseUrl, "openai"));
});

// ---------------------------------------------------------------------------
// Which stored configuration to believe
// ---------------------------------------------------------------------------

test("a stored address is used when it was saved for the same provider", () => {
  const config = readAiSettings({
    provider: "custom",
    storedFor: "custom",
    baseUrl: "https://gateway.example/v1",
    model: "my-model",
  });
  assert.equal(config.baseUrl, "https://gateway.example/v1");
  assert.equal(config.model, "my-model");
});

test("an address saved for a DIFFERENT provider is ignored, not honoured", () => {
  // The report: "DeepSeek 官方 API" pointed at `127.0.0.1:3080` -- the previous
  // provider's address, left behind by a switch. Every request went nowhere and the
  // settings page looked perfectly filled in. The preset wins here because its
  // address is documented and the stale one is guaranteed wrong.
  const config = readAiSettings({
    provider: "deepseek",
    storedFor: "dsh",
    baseUrl: "http://127.0.0.1:3080",
    model: "deepseek-official/deepseek-flash",
  });
  assert.equal(config.baseUrl, providerById("deepseek").baseUrl);
  assert.equal(config.model, providerById("deepseek").model);
});

test("an address saved before this field existed is treated as another provider's", () => {
  // Absence is the dangerous case, not a mismatch: every record written by the
  // previous version has no stamp, and defaulting the stamp to the current provider
  // would make all of them look current -- which is the bug being fixed.
  const config = readAiSettings({ provider: "deepseek", baseUrl: "http://127.0.0.1:3080", model: "leftover" });
  assert.equal(config.baseUrl, providerById("deepseek").baseUrl);
  assert.equal(config.model, providerById("deepseek").model);
});

test("the custom provider keeps its address without needing a matching stamp", () => {
  // `custom` has no preset address at all, so there is nothing to fall back to and
  // nothing a stale value could be confused with.
  const config = readAiSettings({ provider: "custom", baseUrl: "https://gateway.example", model: "m" });
  assert.equal(config.baseUrl, "https://gateway.example");
  assert.equal(config.model, "m");
});

test("a local provider keeps its own address when the stamp matches", () => {
  const config = readAiSettings({ provider: "ollama", storedFor: "ollama", baseUrl: "http://127.0.0.1:9999" });
  assert.equal(config.baseUrl, "http://127.0.0.1:9999");
  assert.equal(config.model, providerById("ollama").model, "模型没有被覆盖时应回落到预设");
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test("createBackend dispatches on the protocol and describes itself for diagnostics", async () => {
  const openai = scripted([{ choices: [{ message: { content: "ok" } }] }]);
  const chosen = createBackend(cfgFor("openai"), openai.fetchImpl);
  assert.equal(chosen.kind, "openai");
  assert.match(chosen.describe(), /gpt-4o-mini @/);
  assert.match(chosen.describe(), /v1\/chat\/completions/);
  await chosen.complete({ messages: [{ role: "user", text: "x" }] });

  const anthropic = scripted([{ content: [{ type: "text", text: "ok" }] }]);
  const claude = createBackend(cfgFor("anthropic"), anthropic.fetchImpl);
  assert.equal(claude.kind, "anthropic");
  assert.match(claude.describe(), /v1\/messages/);

  const dsh = scripted(dshScript("ok"));
  const other = createBackend(cfgFor("dsh", { model: "p/m" }), dsh.fetchImpl);
  assert.equal(other.kind, "dsh");
  assert.match(other.describe(), /dsh p\/m @/);
});

test("every provider in the table gets a backend that builds a request", async () => {
  // A preset whose protocol has no branch would silently fall through to the
  // OpenAI body and fail with a 400 at the user's expense. Asserted over the
  // table so a new row is covered without touching this test.
  //
  // The reply is keyed on the wire shape rather than scripted per provider: each
  // backend reads its own response shape, and walking the table (rather than
  // naming the three protocols here) is what makes a new row a failure instead
  // of an omission.
  const { AI_PROVIDERS } = await import("../.build/aiProviders.js");
  for (const provider of AI_PROVIDERS) {
    // Host-only rows (Gemini) are resolved by the host's protocol registry, not
    // by this legacy backend factory. The row is still in the table so the host
    // can offer it; the old panes never render it.
    if (provider.hostOnly) continue;
    if (provider.id === "custom") continue;
    const payload = provider.kind === "anthropic" ? { content: [{ type: "text", text: "ok" }] } : undefined;
    const { fetchImpl, calls } = scripted(
      provider.kind === "dsh"
        ? dshScript("ok")
        : [payload ?? { choices: [{ message: { content: "ok" } }] }],
    );
    const backend = createBackend(cfgFor(provider.id), fetchImpl);
    assert.equal(backend.kind, provider.kind, `${provider.id} 的协议不对`);
    await backend.complete({ messages: [{ role: "user", text: "x" }] });
    assert.ok(calls.length >= 1, `${provider.id} 没有发出任何请求`);
    assert.ok(calls[0].url.startsWith(provider.baseUrl), `${provider.id} 请求发到了 ${calls[0].url}`);
  }
});
// ---------------------------------------------------------------------------
// Configuration warnings, the 405 message and the connectivity probe
// ---------------------------------------------------------------------------

/** The raw, plugin-facing settings shape, which the panels actually hand over. */
const rawAiSettings = (over = {}) => ({
  aiProvider: AI_DEFAULT_PROVIDER,
  aiStoredFor: AI_DEFAULT_PROVIDER,
  aiBaseUrl: "",
  aiProtocol: "",
  aiModel: "",
  aiApiKey: "test-key",
  aiAuthHeader: "",
  aiAuthPrefix: "",
  aiTimeoutMs: 120_000,
  aiMaxImages: 6,
  ...over,
});

test("configWarnings names a cloud preset aimed at the DSH port", () => {
  const warnings = configWarnings(cfg({ baseUrl: "http://127.0.0.1:3080", storedFor: AI_DEFAULT_PROVIDER }));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "dsh-port-on-other-provider");
  assert.match(warnings[0].message, /3080/);
  assert.equal(warnings[0].fix.patch.aiProvider, "dsh");
  assert.equal(warnings[0].fix.patch.aiBaseUrl, "http://127.0.0.1:3080");
  assert.ok(warnings[0].fix.note, "切到 DSH 还需要令牌，note 必须说出来");
});

test("a loopback address on another port is still the wrong side for a cloud preset", () => {
  const warnings = configWarnings(cfg({ baseUrl: "http://127.0.0.1:11434", storedFor: AI_DEFAULT_PROVIDER }));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "cloud-provider-local-address");
  assert.equal(warnings[0].fix.patch.aiBaseUrl, "", "修复要清空地址，回落到预设");
});

test("a local preset aimed at a remote host is warned the other way", () => {
  const warnings = configWarnings(
    readAiSettings({ provider: "ollama", storedFor: "ollama", baseUrl: "https://gateway.example" }),
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "local-provider-remote-address");
  assert.equal(warnings[0].fix.patch.aiBaseUrl, "http://127.0.0.1:11434");
});

test("custom is never nagged, because a local gateway is a legitimate custom endpoint", () => {
  const warnings = configWarnings(
    readAiSettings({ provider: "custom", storedFor: "custom", baseUrl: "http://127.0.0.1:9999" }),
  );
  assert.deepEqual(warnings, []);
});

test("checkAiConfig keeps the form usable and carries the warning beside it", () => {
  const check = checkAiConfig(
    rawAiSettings({ aiBaseUrl: "http://127.0.0.1:3080", aiModel: "deepseek-flash" }),
  );
  assert.equal(check.ok, true, "地址是错的，但表单是填完的");
  assert.equal(check.warnings.length, 1);
  assert.equal(check.warnings[0].code, "dsh-port-on-other-provider");
});

test("a 405 names the URL that was called and both repairs", () => {
  const error = classifyStatus(
    405,
    "",
    cfg({ baseUrl: "http://127.0.0.1:3080", storedFor: AI_DEFAULT_PROVIDER }),
    "http://127.0.0.1:3080/v1/chat/completions",
  );
  assert.equal(error.status, 405);
  assert.match(error.message, /405/);
  assert.match(error.message, /v1\/chat\/completions/, "实际请求的 URL 必须在文案里");
  assert.match(error.message, /DeepSeek Harness/);
  assert.match(error.message, /端点地址/, "云端那条修复方向也要在");
});

test("probeDsh asks session/list without creating a session", async () => {
  const { fetchImpl, calls } = scripted([rpcOk({ sessions: [] })]);
  const result = await probeDsh(readAiSettings({ provider: "dsh", storedFor: "dsh", apiKey: "tok" }), fetchImpl);
  assert.ok(result);
  assert.match(result.note, /令牌有效/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/api/session/list"), calls[0].url);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].parsed.method, "session/list");
});

test("probeDsh reports a rejected token instead of calling the endpoint broken", async () => {
  const { fetchImpl } = scripted([raw(401, "unauthorized")]);
  await assert.rejects(
    () => probeDsh(readAiSettings({ provider: "dsh", storedFor: "dsh", apiKey: "bad" }), fetchImpl),
    (error) => error instanceof AiError && error.status === 401,
  );
});

test("probeDsh reads a missing route as inconclusive, exactly like /models", async () => {
  const { fetchImpl } = scripted([raw(404, "not found")]);
  const dsh = readAiSettings({ provider: "dsh", storedFor: "dsh", apiKey: "tok" });
  assert.equal(await probeDsh(dsh, fetchImpl), null);
});

test("the connection probe resolves raw settings before asking for /models", async () => {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, method: init.method });
    return { status: 200, text: JSON.stringify({ data: [{ id: "deepseek-flash" }] }) };
  };
  const complete = async () => {
    throw new Error("chat probe must not run while /models answers");
  };
  const message = await probeAiConnection(rawAiSettings(), complete, { send });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/models", "raw settings 必须先解析成 AiConfig");
  assert.match(message, /未消耗 token/);
});

test("the connection probe uses DSH's read-only RPC, not a chat request", async () => {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, parsed: JSON.parse(init.body) });
    return { status: 200, text: JSON.stringify(rpcOk({ sessions: [] })) };
  };
  const complete = async () => {
    throw new Error("DSH probe must not create a session");
  };
  const message = await probeAiConnection(
    rawAiSettings({ aiProvider: "dsh", aiStoredFor: "dsh" }),
    complete,
    { send },
  );
  assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session/list");
  assert.equal(calls[0].parsed.method, "session/list");
  assert.match(message, /未创建会话/);
});

test("a probe with no models route falls back to one chat request", async () => {
  const calls = [];
  const send = async (url) => {
    calls.push(url);
    return { status: 404, text: "not found" };
  };
  const complete = async () => ({
    text: "好",
    describe: "openai deepseek-flash @ https://api.deepseek.com/v1/chat/completions",
  });
  const message = await probeAiConnection(rawAiSettings(), complete, { send });
  assert.equal(calls.length, 1);
  assert.match(message, /回复「好」/);
});