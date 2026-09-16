/**
 * The provider table's shape, asserted because it is now load-bearing.
 *
 * `tools/check-no-network.mjs` permits a remote hostname **only** in the file
 * this table lives in. That makes the table the security boundary: a row added
 * carelessly is a new place the plugin can send a key, and a row whose `auth`
 * disagrees with its `needsKey` produces a settings page that asks for something
 * it will never send. Neither shows up as a failure at runtime -- the first is a
 * request that succeeds, and the second is a 401 the user cannot explain.
 *
 * So these are invariant tests rather than examples: they describe what every
 * row must satisfy, not what any one row currently says.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_API_PROVIDERS,
  AI_DEFAULT_PROVIDER,
  AI_LOCAL_PROVIDERS,
  AI_PROVIDERS,
  AI_PROVIDER_GROUPS,
  authHeaderFor,
  needsKeyProviders,
  providerById,
} from "../.build/aiProviders.js";

// ---------------------------------------------------------------------------
// Table invariants
// ---------------------------------------------------------------------------

test("every provider id appears exactly once across the whole table", () => {
  const ids = AI_PROVIDERS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, `重复的 id：${ids.join(", ")}`);
  assert.ok(ids.length >= 4, "至少要有云端与本机各几个");
});

test("the grouped view and the flat table are the same providers", () => {
  const grouped = AI_PROVIDER_GROUPS.flatMap((group) => group.providers.map((entry) => entry.id));
  const offered = AI_PROVIDERS.filter((entry) => !entry.hostOnly);
  assert.deepEqual([...grouped].sort(), [...offered.map((entry) => entry.id)].sort());
});

test("every non-custom provider names a parseable http(s) endpoint", () => {
  for (const provider of AI_PROVIDERS) {
    if (provider.id === "custom") {
      // `custom` is the one row whose address has to come from the user; an
      // address here would be a default nobody asked for.
      assert.equal(provider.baseUrl, "", "custom 的地址必须留空");
      continue;
    }
    const url = new URL(provider.baseUrl);
    assert.ok(url.protocol === "http:" || url.protocol === "https:", `${provider.id} 的协议`);
    assert.ok(provider.baseUrl.startsWith(url.origin), `${provider.id} 的地址应当是可拼接的前缀`);
    // A trailing slash would turn `base + "/v1/..."` into `//v1/...`.
    assert.equal(provider.baseUrl.endsWith("/"), false, `${provider.id} 的地址不应以斜杠结尾`);
  }
});

test("every non-custom provider names a default model", () => {
  for (const provider of AI_PROVIDERS) {
    if (provider.id === "custom") continue;
    assert.ok(provider.model.trim().length > 0, `${provider.id} 缺少默认模型`);
  }
});

test("asking for a key and presenting one are the same decision", () => {
  // The failure this prevents: a provider whose pane says "paste your key" while
  // the transport sends no credential, so every request is a 401 and the settings
  // page looks correct.
  for (const provider of AI_PROVIDERS) {
    if (provider.needsKey) {
      assert.notEqual(provider.auth, "none", `${provider.id} 要 key 但 auth 是 none`);
    } else {
      // No key required means either no credential at all, or one the user may
      // optionally supply (dsh's launch token).
      assert.ok(
        provider.auth === "none" || provider.auth === "bearer",
        `${provider.id} 不要 key，auth 只应为 none 或 bearer`,
      );
    }
  }
});

test("local providers point at this machine", () => {
  // A "local" row with a remote address would be a service pretending to be a
  // program: the user would be told nothing needs installing while their prompts
  // left the machine.
  for (const provider of AI_LOCAL_PROVIDERS) {
    const url = new URL(provider.baseUrl);
    assert.ok(
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1",
      `${provider.id} 标了本机但地址是 ${url.hostname}`,
    );
    assert.ok(provider.local, `${provider.id} 应当标记 local`);
  }
});

test("the services a key unlocks are not marked local", () => {
  for (const provider of AI_API_PROVIDERS) {
    assert.equal(provider.local, false, `${provider.id} 不应当是本机的`);
    assert.ok(provider.label.trim().length > 0, `${provider.id} 缺少名称`);
    assert.ok(provider.hint.trim().length > 0, `${provider.id} 缺少说明`);
  }
});

test("the default provider exists, takes a key, and is not local", () => {
  // The default is the whole point of this change: a fresh install must work by
  // pasting a key, with nothing else installed.
  const provider = providerById(AI_DEFAULT_PROVIDER);
  assert.ok(provider, `默认服务商 ${AI_DEFAULT_PROVIDER} 不在表里`);
  assert.equal(provider.local, false);
  assert.equal(provider.needsKey, true);
});

test("the default provider is the first one offered", () => {
  // The dropdown's first row is what a user reads as "the normal choice"; a
  // default that is buried further down is a default in name only.
  assert.equal(AI_API_PROVIDERS[0].id, AI_DEFAULT_PROVIDER);
});

// ---------------------------------------------------------------------------
// Lookup and auth resolution
// ---------------------------------------------------------------------------

test("providerById resolves every row and nothing else", () => {
  for (const provider of AI_PROVIDERS) {
    assert.equal(providerById(provider.id)?.id, provider.id);
  }
  assert.equal(providerById("mystery"), null);
  assert.equal(providerById(""), null);
  assert.equal(providerById("DeepSeek"), null, "id 区分大小写");
});

test("needsKeyProviders is every preset that requires a credential", () => {
  assert.deepEqual(
    needsKeyProviders().map((entry) => entry.id),
    AI_PROVIDERS.filter((entry) => entry.needsKey).map((entry) => entry.id),
  );
  assert.ok(
    needsKeyProviders().some((entry) => entry.id === "dsh"),
    "DSH needs the token its own startup printed, or every RPC is a 401",
  );
  assert.ok(
    !needsKeyProviders().some((entry) => entry.id === "ollama"),
    "Ollama needs no credential, and asking for one would break a working install",
  );
});

test("a bearer provider gets the authorization header with a space in the prefix", () => {
  // `Bearer` + the key with no space is a 401 on every provider that uses it,
  // and it looks like a wrong key rather than a wrong prefix.
  const deepseek = providerById("deepseek");
  assert.deepEqual(authHeaderFor(deepseek), { header: "authorization", prefix: "Bearer " });
});

test("an x-api-key provider sends the bare key", () => {
  const anthropic = providerById("anthropic");
  assert.deepEqual(authHeaderFor(anthropic), { header: "x-api-key", prefix: "" });
});

test("a local provider that wants no credential resolves to no header", () => {
  const ollama = providerById("ollama");
  assert.deepEqual(authHeaderFor(ollama), { header: "", prefix: "" });
});

test("dsh keeps a bearer header, because its launch token is presented as one", () => {
  const dsh = providerById("dsh");
  assert.deepEqual(authHeaderFor(dsh), { header: "authorization", prefix: "Bearer " });
});

test("a named custom header with no prefix sends a bare key", () => {
  // The distinction the resolver has to keep: a *named* header with an empty
  // prefix is a deliberate bare key (`X-Api-Token: <key>`), while a header that
  // is itself blank means "not filled in yet" and gets the OpenAI-ish default.
  // Collapsing the two sends `X-Api-Token: Bearer <key>`, which no server reads.
  const custom = providerById("custom");
  assert.deepEqual(authHeaderFor(custom, { header: "X-Api-Token" }), { header: "X-Api-Token", prefix: "" });
  // And a header that is only whitespace is not a header.
  assert.deepEqual(authHeaderFor(custom, { header: "   " }), { header: "authorization", prefix: "Bearer " });
});

// ---------------------------------------------------------------------------
// The table is the only place a hostname may live
// ---------------------------------------------------------------------------

test("the table carries the only remote hostnames the plugin knows", () => {
  // The guard asserts *where* a hostname may be written in the source; this
  // asserts what that permission was granted for. A source scan of the built
  // output would be the wrong test: esbuild inlines the table into whichever
  // module imports it, so `ai.js` legitimately contains these strings too.
  //
  // What must stay true is that the hosts a request can reach are exactly the
  // ones declared here -- so a URL assembled at runtime from pieces, or a host
  // smuggled into another module, is not a thing this plugin can do.
  // `custom` is excluded as well as the local ones: its address is the user's,
  // so it has no hostname of its own to declare. That is the point of it.
  const hosts = AI_PROVIDERS.filter((entry) => !entry.local && entry.id !== "custom").map((entry) => {
    assert.ok(entry.baseUrl.startsWith("https://"), `${entry.id} 的云端地址必须是 https`);
    return new URL(entry.baseUrl).hostname;
  });
  assert.deepEqual([...hosts].sort(), ["api.anthropic.com", "api.deepseek.com", "api.openai.com", "generativelanguage.googleapis.com"]);
});

test("every local provider's host is this machine, so nothing here needs a permission", () => {
  const hosts = AI_LOCAL_PROVIDERS.map((entry) => new URL(entry.baseUrl).hostname);
  for (const host of hosts) {
    assert.ok(
      host === "127.0.0.1" || host === "localhost" || host === "::1",
      `本机服务不应指向 ${host}`,
    );
  }
});
