/**
 * The provider table: the one file allowed to name a remote host.
 *
 * ## Why a table, and why here
 *
 * `tools/check-no-network.mjs` refuses a literal `http(s)://<host>` anywhere in
 * the tree **except in this file**, and it refuses `https://` in the shipped
 * bundle except for the hostnames below. That rule is what replaced the old
 * "this project never makes a request": a request is now possible, so what has
 * to be provable is *where it can go*. One table means the answer is one screen
 * long, and adding a provider is adding a row rather than an exception.
 *
 * ## Why the auth shape is data and not code
 *
 * Three of the four styles below exist because the providers disagree about how
 * a key is presented -- `Authorization: Bearer`, a bare `x-api-key`, or a
 * vendor's own header. Writing that as a field per provider rather than as a
 * branch in the transport is what makes `custom` possible at all: a user with an
 * endpoint nobody anticipated gets the same machinery instead of a new release.
 * The transport reads these fields; it never switches on the provider id.
 *
 * ## Two tables, not one
 *
 * `AI_API_PROVIDERS` are reachable services; `AI_LOCAL_PROVIDERS` are programs
 * the user runs themselves. They are kept apart because the UI has to render
 * them differently -- one needs a key, the other needs a service to be running --
 * and because a single table would tempt a caller into treating "no key" as
 * misconfiguration for a local server that legitimately has none.
 *
 * Pure: constants and lookups, no I/O.
 */

/**
 * Which wire shape a request takes.
 *
 * Declared here rather than in `ai.ts` so that this file has no imports at all:
 * it is the leaf of the AI modules, and the only one allowed to contain a
 * hostname.
 */
export type AiProtocol = "openai" | "anthropic" | "gemini" | "dsh";

/**
 * What a preset (and later a stored model option) is allowed to claim.
 *
 * A flat union of strings rather than a bag of booleans, because the settings
 * page and the chat layer both need to answer "can this provider do X" with one
 * lookup, and a row that grows a `supportsTools` boolean per feature ends with
 * twenty fields that must all be remembered. The list is closed: a capability
 * the UI does not know about is a control nobody can render, so an unknown
 * string is dropped by the normalizer rather than silently kept.
 *
 * `supportsImages` remains on the preset for compatibility with the existing
 * extractor; `vision` is the same fact stated once for the new capability path,
 * and a test keeps the two from disagreeing.
 */
export const AI_PROVIDER_CAPABILITY_VALUES = ["stream", "tools", "vision", "reasoning", "embeddings", "json"] as const;
export type AiProviderCapability = (typeof AI_PROVIDER_CAPABILITY_VALUES)[number];

/** How a credential is presented. `none` is legitimate: a local server may not want one. */
export type AiAuthStyle = "bearer" | "x-api-key" | "custom" | "none";

export type AiProviderId = "deepseek" | "openai" | "anthropic" | "gemini" | "ollama" | "dsh" | "custom";

export interface AiProviderPreset {
  id: AiProviderId;
  /** What the settings dropdown shows. */
  label: string;
  /** One line: where the key comes from, or what has to be running. */
  hint: string;
  /** Empty for `custom`: the address has to come from the user. */
  baseUrl: string;
  kind: AiProtocol;
  auth: AiAuthStyle;
  /** Only for `auth: "custom"`. */
  header?: string;
  /** Only for `auth: "custom"`; prepended to the key, e.g. `Token `. */
  prefix?: string;
  /**
   * Headers every request to this provider must carry, beyond the credential.
   *
   * `anthropic-version` is the reason this exists: the Messages API rejects a
   * request without it, and the rejection reads as a malformed body rather than
   * as a missing version header -- exactly the kind of failure a user cannot
   * diagnose from a 400.
   */
  extraHeaders?: Record<string, string>;
  /** Empty for `custom`. */
  model: string;
  /** A program on this machine, not a service. */
  local: boolean;
  /**
   * Whether the feature is unusable until the user supplies a credential.
   *
   * Named "key" for history, but a local service may need a token rather than an
   * API key; `credentialLabel` says what to call it on screen.
   */
  needsKey: boolean;
  /**
   * What the credential field is called. Defaults to "API Key" when absent.
   *
   * The DeepSeek Harness preset is the reason this exists: its credential is the
   * one-time token printed by `dsh web`, and calling that an "API Key" is how a
   * user concludes the field is not for them.
   */
  credentialLabel?: string;
  /** One line telling the user where this provider's credential comes from. */
  credentialHint?: string;
  /**
   * Which side of the network this preset's own address is expected to be on.
   *
   * Used only for a warning, never to refuse a request: a cloud preset pointed at
   * `127.0.0.1` is almost always a stale address (the bug report this came from),
   * but a `custom` row is allowed to be either, so its expectation is absent.
   */
  expectedHost?: "loopback" | "remote";
  /** Whether the model takes image input, for the card extractor's sanity check. */
  supportsImages: boolean;
  /**
   * Which optional behaviours this preset can support.
   *
   * Capability is about the *preset's* protocol surface, not any one model: a
   * DeepSeek account can call a text-only model, and Ollama's installed model
   * decides what actually works. That is why this is a claim the UI uses to
   * decide what to *offer*, and why every advanced switch still has to be
   * user-chosen -- a capability bit is never consent.
   */
  capabilities: readonly AiProviderCapability[];
  /**
   * Offered only by the AI host, not by the legacy in-plugin AI panes.
   *
   * Gemini landed after the two domain plugins shipped their own provider
   * dropdowns. The host knows how to build a Gemini request; they do not, so the
   * row is hidden from `AI_PROVIDER_GROUPS` (what their panes render) while
   * staying in `AI_PROVIDERS` (what the host resolves). A row that exists but is
   * never offered is how a protocol gets supported without breaking an old
   * caller in the same release.
   */
  hostOnly?: boolean;
}

/**
 * The services a user reaches with a key.
 *
 * Order is the order the settings dropdown shows, and the first entry is what a
 * fresh install gets: the point of this table is that pasting a key works with
 * nothing else installed, so the default has to be a service rather than a
 * program the user has to run first.
 *
 * ## The base URLs are the services' documented roots, and that is load-bearing
 *
 * DeepSeek's `base_url` is `https://api.deepseek.com` with the path appended by
 * the choice of API shape: `…/chat/completions` for OpenAI, `…/anthropic/v1/messages`
 * for Anthropic. There is **no** `/v1` on the OpenAI side, which is where guessing
 * from OpenAI's own convention goes wrong -- see `apiRootFor()` in `ai.ts`, which
 * is what turns this root into a real URL.
 */
export const AI_API_PROVIDERS: readonly AiProviderPreset[] = [
  {
    id: "deepseek",
    expectedHost: "remote",
    label: "DeepSeek 官方 API",
    // `deepseek-flash` is the current model name and it **does** accept images
    // (DeepSeek's vision guide covers exactly this model), so it is both the
    // text and the reading default. `deepseek-v4-pro` is the heavier alternative
    // and the retired `deepseek-v4-flash*` names are still accepted as aliases.
    hint: "在 platform.deepseek.com 申请 API Key。默认模型 deepseek-flash 既能规划也能读图；要更慢更大的可以填 deepseek-v4-pro。",
    baseUrl: "https://api.deepseek.com",
    kind: "openai",
    auth: "bearer",
    model: "deepseek-flash",
    local: false,
    needsKey: true,
    supportsImages: true,
    capabilities: ["stream", "tools", "vision", "reasoning", "json"],
  },
  {
    id: "openai",
    expectedHost: "remote",
    label: "OpenAI 官方 API",
    hint: "在 platform.openai.com 申请 API Key。",
    baseUrl: "https://api.openai.com/v1",
    kind: "openai",
    auth: "bearer",
    model: "gpt-4o-mini",
    local: false,
    needsKey: true,
    supportsImages: true,
    capabilities: ["stream", "tools", "vision", "reasoning", "embeddings", "json"],
  },
  {
    id: "anthropic",
    expectedHost: "remote",
    label: "Anthropic 官方 API",
    hint: "在 console.anthropic.com 申请 API Key。请求形状与 OpenAI 不同，插件会自己换。",
    baseUrl: "https://api.anthropic.com",
    kind: "anthropic",
    auth: "x-api-key",
    // Required by the Messages API; omitting it is a 400 about the body, which
    // reads like a code bug rather than a missing header.
    extraHeaders: { "anthropic-version": "2023-06-01" },
    model: "claude-3-5-haiku-latest",
    local: false,
    needsKey: true,
    supportsImages: true,
    capabilities: ["stream", "tools", "vision", "reasoning", "json"],
  },
  {
    id: "gemini",
    expectedHost: "remote",
    label: "Google Gemini 官方 API",
    hint: "在 aistudio.google.com 申请 API Key。请求形状与 OpenAI 不同，宿主会自己换。",
    baseUrl: "https://generativelanguage.googleapis.com",
    kind: "gemini",
    auth: "custom",
    header: "x-goog-api-key",
    prefix: "",
    model: "gemini-2.0-flash",
    local: false,
    needsKey: true,
    supportsImages: true,
    capabilities: ["stream", "tools", "vision", "reasoning", "embeddings", "json"],
    hostOnly: true,
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容 / 中转）",
    hint: "自己填地址、模型和鉴权方式。中转站、自建网关、以及任何提供 /v1/chat/completions 的服务都属于这一类。",
    baseUrl: "",
    kind: "openai",
    // `custom` is the only row whose auth is not determined by the provider:
    // the whole reason it exists is that the user tells us the header. The two
    // fields below are its starting point, not its answer.
    auth: "custom",
    header: "authorization",
    prefix: "Bearer ",
    model: "",
    local: false,
    needsKey: true,
    supportsImages: false,
    // Open-ended by definition: a gateway that speaks this shape may support any
    // of these, and none of them can be checked before the first request. The
    // conservative set keeps tools/vision off by default -- an unproven
    // capability is not a preset's to claim -- while stream and json are the
    // contract `custom` exists to keep.
    capabilities: ["stream", "json"],
  },
];

/**
 * Programs the user runs on this machine.
 *
 * `ollama` is the reason a local model is still first-class here: it needs no
 * key and no account, and for someone who already has it running, a pasted key
 * would be a step backwards.
 */
export const AI_LOCAL_PROVIDERS: readonly AiProviderPreset[] = [
  {
    id: "ollama",
    expectedHost: "loopback",
    label: "本机 Ollama",
    hint: "不需要 API Key，但要先在终端里跑起来 Ollama 并拉一个模型。",
    baseUrl: "http://127.0.0.1:11434",
    kind: "openai",
    auth: "none",
    model: "qwen2.5-vl",
    local: true,
    needsKey: false,
    supportsImages: true,
    capabilities: ["stream", "tools", "vision", "reasoning", "embeddings", "json"],
  },
  {
    id: "dsh",
    expectedHost: "loopback",
    label: "本机 DeepSeek Harness",
    hint: "不需要 API Key，但要跑着 dsh web，并在下面填它启动时打印的令牌。",
    credentialLabel: "访问令牌",
    credentialHint: "dsh web 启动时打印的链接里的 ?token=…；也可以从本机 DeepSeek Harness 插件的面板里复制。",
    baseUrl: "http://127.0.0.1:3080",
    kind: "dsh",
    auth: "bearer",
    model: "deepseek-official/deepseek-flash",
    local: true,
    needsKey: true,
    supportsImages: true,
    capabilities: ["stream", "tools", "vision", "reasoning", "json"],
  },
];

/** The three groups in the order the settings page shows them. */
export const AI_PROVIDER_GROUPS: readonly { title: string; providers: readonly AiProviderPreset[] }[] = [
  { title: "云端 API Key", providers: AI_API_PROVIDERS.filter((provider) => !provider.hostOnly) },
  { title: "本机服务", providers: AI_LOCAL_PROVIDERS },
];

/** Every preset, for lookups and for the tests that assert the table's shape. */
export const AI_PROVIDERS: readonly AiProviderPreset[] = [...AI_API_PROVIDERS, ...AI_LOCAL_PROVIDERS];

/**
 * The provider a fresh install starts on.
 *
 * A service, not a program: the whole point of the API-key path is that it works
 * with nothing else installed, and a default that requires the user to start a
 * server first would put that requirement back without saying so.
 */
export const AI_DEFAULT_PROVIDER: AiProviderId = "deepseek";

/** One preset by id, or null for a value that is not in the table. */
export function providerById(id: string): AiProviderPreset | null {
  return AI_PROVIDERS.find((entry) => entry.id === id) ?? null;
}

/**
 * A preset the legacy in-plugin panes may offer.
 *
 * Host-only rows (Gemini) are in the table so the host can resolve them, but the
 * legacy path has no backend for their wire shape; a hand-edited `data.json`
 * naming one must fall back to the default instead of sending an OpenAI body to
 * Gemini. `providerById` remains the full lookup for the host.
 */
export function legacyProviderById(id: string): AiProviderPreset | null {
  const preset = providerById(id);
  return preset && !preset.hostOnly ? preset : null;
}

/** The presets that take a key, which is what "云端 API Key" means. */
export function needsKeyProviders(): readonly AiProviderPreset[] {
  return AI_PROVIDERS.filter((entry) => entry.needsKey);
}

/**
 * The header name and prefix to attach a key with.
 *
 * Resolved once, here, so the transport never switches on a provider id: it asks
 * for "what header, what prefix" and writes what it is told. A user's `custom`
 * header wins over the preset's, because the two fields exist precisely so that
 * an endpoint nobody anticipated can still be reached.
 *
 * The prefix falls back with the header rather than on its own. A `custom`
 * provider with a header and no prefix means a bare key; a `custom` provider
 * with *neither* means the user has not decided yet, and the default OpenAI-ish
 * `Authorization: Bearer` is the shape most gateways accept. Resolving the two
 * independently is how a preset ends up sending `X-Api-Token: Bearer <key>`,
 * which no server has ever read.
 */
export function authHeaderFor(
  provider: AiProviderPreset,
  override: { header?: string; prefix?: string } = {},
): { header: string; prefix: string } {
  if (provider.auth === "none") return { header: "", prefix: "" };
  if (provider.auth === "bearer") return { header: "authorization", prefix: "Bearer " };
  if (provider.auth === "x-api-key") return { header: "x-api-key", prefix: "" };
  // `custom`: the user's own values, resolved as a *pair*. A blank header field
  // means "not filled in yet" and gets `Authorization: Bearer`; a named header
  // with no prefix is a deliberate bare key, so it does not inherit a `Bearer `
  // from the preset. Resolving the two fields separately is how a preset ends up
  // sending `X-Api-Token: Bearer <key>`, which no server has ever read.
  const header = override.header?.trim() || "";
  if (!header) {
    return { header: provider.header?.trim() || "authorization", prefix: override.prefix ?? "Bearer " };
  }
  return { header, prefix: override.prefix ?? "" };
}
