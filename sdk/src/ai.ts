/**
 * The AI core: one prompt/response contract, two backends, no transport.
 *
 * ## Why this module has no networking in it
 *
 * Sending the request lives in each plugin's `src/aiProvider.ts`, which is the
 * only file allowed to import `node:http`. That split is not tidiness: the
 * project forbids `fetch` and `requestUrl` outright, and the one remaining way
 * to reach a local model is the Node HTTP client. Keeping it in one identifiable
 * file is what lets `tools/check-no-network.mjs` keep a real rule instead of
 * being deleted -- everything here is pure, so it is tested by `node --test`
 * against a fake transport rather than by pointing a real client at a server.
 *
 * ## Why `node:http` at all, and not the browser's `fetch`
 *
 * A local model server is not obliged to accept requests from a renderer. The
 * one this was written against checks that the `Origin` header's host equals the
 * `Host` header and rejects anything carrying `Sec-Fetch-Site: cross-site` with
 * a 403 -- so a `fetch` from Obsidian (origin `app://obsidian.md`) fails even
 * with a valid session cookie. Node's client sends neither header.
 *
 * ## The two backends
 *
 * `openai` speaks `POST {base}/v1/chat/completions`, which is what Ollama,
 * LM Studio, vLLM, DeepSeek's own API and most others expose. `dsh` speaks the
 * DeepSeek Harness native RPC, which is *not* OpenAI-shaped and, importantly,
 * does not answer a prompt with the reply: it accepts the prompt, and the text
 * has to be read back out of the session. See `createDshBackend`.
 *
 * ## Images are base64, and the two backends disagree about the wrapper
 *
 * OpenAI-shaped APIs take a data URL (`data:image/png;base64,...`). DSH takes a
 * bare base64 string and rejects the prefix. Both are built here from one
 * `AiImage`, so a caller never has to know which backend it is talking to.
 *
 * Pure: values in, a reply out, no Obsidian, no Node, no timers.
 */

import {
  AI_DEFAULT_PROVIDER,
  authHeaderFor,
  legacyProviderById,
  providerById,
  type AiProtocol,
  type AiProviderId,
  type AiProviderPreset,
} from "./aiProviders";
import { AI_DEFAULT_MAX_IMAGES, AI_DEFAULT_TIMEOUT_MS, AI_IMAGE_TYPES, type AiImageType } from "./ai/aiChat";
import { AI_JSON_ONLY_RULE, AI_NO_INVENTION_RULE, extractJsonObject, joinPrompt } from "./ai/aiOutput";
export { AI_DEFAULT_MAX_IMAGES, AI_DEFAULT_TIMEOUT_MS, AI_IMAGE_TYPES };
export type { AiImageType };
export { AI_JSON_ONLY_RULE, AI_NO_INVENTION_RULE, extractJsonObject, joinPrompt };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Which wire shape a request takes.
 *
 * Re-exported from the provider table rather than declared here, so there is one
 * definition of "protocol" and the table that names the endpoints owns it. A
 * second union in this file is how a preset ends up with a `kind` the factory
 * has no branch for.
 */
export type { AiProtocol } from "./aiProviders";

/**
 * The endpoint a plugin talks to when the user has not chosen one.
 *
 * Kept exported for the local-service path and for the messages that suggest an
 * example address. It is deliberately **not** the default a fresh install gets:
 * that comes from `AI_DEFAULT_PROVIDER`. See `aiProviders.ts` for why the
 * default moved from a local program to a hosted service.
 */
export const AI_DEFAULT_BASE_URL = "http://127.0.0.1:3080";

/**
 * The scheme that may only ever be used for a loopback address.
 *
 * Spelled as a `scheme:` pair rather than a full URL: this file must not name a
 * host, because `tools/check-no-network.mjs` allows a remote hostname in exactly
 * one file and this is not it.
 */
export const AI_LOCAL_SCHEME = "http:";

/** The scheme a hosted provider uses. TLS is required for a key in transit. */
export const AI_REMOTE_SCHEME = "https:";

/**
 * The default model, in `provider/model` form.
 *
 * The two halves are meaningless to `openai` backends (there the model is the
 * bare id) and meaningful to `dsh`, which needs both. Keeping the qualified form
 * in one setting means switching protocol does not silently send a model name
 * the other backend will reject; `openAiModelId` strips the prefix at use time.
 */
export const AI_DEFAULT_MODEL = "deepseek-official/deepseek-flash";


export interface AiConfig {
  /** Which preset the user picked. The transport uses it for diagnostics only. */
  provider: AiProviderId;
  /** Where the endpoint is. Whatever the preset says, or the user's override. */
  baseUrl: string;
  /** The wire shape. Derived from the preset; overridable for `custom`. */
  protocol: AiProtocol;
  /** `provider/model` for `dsh`, the bare id for `openai` and `anthropic`. */
  model: string;
  /** The user's key. Empty when the provider does not need one. */
  apiKey: string;
  /**
   * The provider this stored configuration belongs to.
   *
   * Written whenever a field is saved and compared on read: a mismatch means the
   * stored address and model describe a **different service**, so they are
   * discarded in favour of the preset's. Without it, switching providers leaves
   * the previous one's address in place and the settings page still looks
   * complete while every request goes nowhere.
   */
  storedFor?: string;
  /** The header the key goes in, already resolved. Empty means "send no credential". */
  authHeader: string;
  /** Prepended to the key, e.g. `Bearer `. */
  authPrefix: string;
  /**
   * Headers the provider requires on every request, from its preset.
   *
   * Carried in the config rather than read from the table at request time so the
   * backends stay free of the table: they attach what they are handed.
   * `anthropic-version` is the case that needs this.
   */
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
  maxImages: number;
}

/**
 * What an unset field falls back to.
 *
 * Note what is **empty** here: `baseUrl`, `model`, and the auth pair. Those come
 * from the preset, so a blank means "ask the preset" rather than "use this
 * global value". A credential header name spelled into this object would be a
 * second declaration of something only the provider table is allowed to name --
 * and `tools/check-no-network.mjs` rejects it by name.
 *
 * **Every field of `AiConfig` has to be here**, and `storedFor` is the one whose
 * absence was a real bug rather than untidiness: `readAiSettings` decides a value's
 * type by comparing it against this object, so a key missing here has an
 * `undefined` default and every stored value of it is rejected -- which silently
 * disabled the whole "is this configuration this provider's?" check and brought
 * back the stale-address bug it was written to fix.
 */
export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: AI_DEFAULT_PROVIDER,
  storedFor: "",
  baseUrl: "",
  protocol: "openai",
  model: "",
  apiKey: "",
  authHeader: "",
  authPrefix: "",
  timeoutMs: AI_DEFAULT_TIMEOUT_MS,
  maxImages: AI_DEFAULT_MAX_IMAGES,
};

/**
 * Read the AI fields out of a plugin's stored settings.
 *
 * Field by field with a fallback each, in the same spirit as the plugins'
 * `mergeSettings`: `data.json` is a text file a user can edit, and a `timeoutMs`
 * that arrived as a string would otherwise reach `setTimeout` as `NaN` and
 * produce a request that never times out instead of one that fails clearly.
 *
 * **The preset supplies anything the user left blank.** That is what makes
 * "pick a provider, paste a key" the whole setup: `baseUrl`, `protocol`, `model`
 * and the auth pair fall back to the preset rather than to a global default, so
 * an empty field means "use DeepSeek's address", not "use wherever the last
 * provider pointed".
 */
export function readAiSettings(raw: Record<string, unknown>): AiConfig {
  const pick = <K extends keyof AiConfig>(key: K): AiConfig[K] => {
    const value = raw[key];
    if (value === undefined || value === null) return DEFAULT_AI_CONFIG[key];
    if (typeof value !== typeof DEFAULT_AI_CONFIG[key]) return DEFAULT_AI_CONFIG[key];
    return value as AiConfig[K];
  };
  const providerId = pick("provider");
  const preset = legacyProviderById(providerId) ?? providerById(AI_DEFAULT_PROVIDER);
  const timeout = pick("timeoutMs");
  const maxImages = pick("maxImages");
  // The stored address and model belong to the provider that was selected when
  // they were saved. If that is not the provider selected now they are **leftover
  // from a different service**, and honouring them is how a user ends up with
  // "DeepSeek 官方 API" pointed at `127.0.0.1:3080` -- the report that produced
  // this check. Every request then went nowhere and the settings page looked
  // perfectly filled in.
  //
  // `storedFor` records the provider a configuration was saved under. An older
  // record has no marker at all, and an unmarked value from before this field
  // existed is exactly the case that must not be trusted either -- so absence is
  // treated as "a different provider", which discards it in favour of the preset.
  // That is the safe direction: the preset's address is documented and correct,
  // while a stale one is guaranteed wrong.
  const storedFor = pick("storedFor");
  const current = storedFor === preset?.id;
  const keepStored = preset?.id === "custom" || current;
  // The auth pair follows the same rule as the address and the model: an override
  // saved for another provider is not an override for this one. For a named
  // provider this branch is unreachable anyway (`custom` is the only preset with
  // `auth: "custom"`), but making the condition explicit keeps the three fields
  // from drifting into three different policies.
  const auth =
    preset?.auth === "custom"
      ? authHeaderFor(preset, keepStored ? { header: pick("authHeader"), prefix: pick("authPrefix") } : {})
      : preset
        ? authHeaderFor(preset)
        : { header: "", prefix: "" };
  const protocol = pick("protocol");
  return {
    provider: preset?.id ?? AI_DEFAULT_PROVIDER,
    baseUrl: ((keepStored ? pick("baseUrl").trim() : "") || preset?.baseUrl || "").replace(/\/+$/, ""),
    protocol: protocol === "dsh" || protocol === "anthropic" ? protocol : preset?.kind ?? "openai",
    model: (keepStored ? pick("model").trim() : "") || preset?.model || "",
    apiKey: pick("apiKey"),
    authHeader: auth.header,
    authPrefix: auth.prefix,
    extraHeaders: preset?.extraHeaders ? { ...preset.extraHeaders } : undefined,
    timeoutMs: Number.isFinite(timeout) && timeout >= 5000 ? Math.min(timeout, 600_000) : AI_DEFAULT_TIMEOUT_MS,
    maxImages: Number.isInteger(maxImages) && maxImages >= 1 ? Math.min(maxImages, 20) : AI_DEFAULT_MAX_IMAGES,
  };
}

/** The key names `readAiSettings` reads, so each plugin's settings file lists them once. */
export const AI_SETTING_KEYS = [
  "aiProvider",
  "aiStoredFor",
  "aiBaseUrl",
  "aiProtocol",
  "aiModel",
  "aiApiKey",
  "aiAuthHeader",
  "aiAuthPrefix",
  "aiTimeoutMs",
  "aiMaxImages",
] as const;
export type AiSettingKey = (typeof AI_SETTING_KEYS)[number];

/** Every `AiConfig` field, paired with the settings key a plugin stores it under. */
const AI_SETTING_FIELDS: readonly (readonly [keyof AiConfig, AiSettingKey])[] = [
  ["provider", "aiProvider"],
  ["storedFor", "aiStoredFor"],
  ["baseUrl", "aiBaseUrl"],
  ["protocol", "aiProtocol"],
  ["model", "aiModel"],
  ["apiKey", "aiApiKey"],
  ["authHeader", "aiAuthHeader"],
  ["authPrefix", "aiAuthPrefix"],
  ["timeoutMs", "aiTimeoutMs"],
  ["maxImages", "aiMaxImages"],
];

/**
 * Lift this plugin's own `aiXxx` keys into the shape above.
 *
 * The key names are read through `AI_SETTING_KEYS` rather than spelled inline,
 * and that is deliberate: `tools/check-settings.mjs` looks for each declared key
 * **in the plugin's own source**, so a mapping that named the keys nowhere would
 * make every AI setting read as "offered and never consumed". The table above
 * therefore has to be traversed, not unrolled -- the same trap that check exists
 * to catch, turned on itself.
 */
export function aiSettingsFrom(settings: Record<string, unknown>): AiConfig {
  const raw: Record<string, unknown> = {};
  for (const [field, key] of AI_SETTING_FIELDS) {
    if (!AI_SETTING_KEYS.includes(key)) continue;
    raw[field] = settings[key];
  }
  return readAiSettings(raw);
}

/**
 * Is this configuration usable, and if not, what does the user have to do?
 *
 * Split into "needs setup" and "is wrong" on purpose, because the two want
 * different interfaces: the first is a fresh install with an empty form and gets
 * a "configure now" button, the second is a typo and gets the specific sentence.
 * A single `ok: false` would make the UI either nag a user who is halfway
 * through filling the form, or hide a real mistake behind a generic invitation.
 */
export interface AiConfigWarning {
  /** A stable id, so the panels and the tests can key on it. */
  code: "cloud-provider-local-address" | "local-provider-remote-address" | "dsh-port-on-other-provider";
  /** The sentence the panel shows, written as the correction it is. */
  message: string;
  /**
   * The one click that repairs it, when there is one.
   *
   * The patch goes through whatever save path the panel already uses, so it is
   * stamped (`aiStoredFor`) exactly like a hand edit -- a fix that bypassed the
   * stamp would be discarded on the next read, which is the stale-address bug
   * wearing a different hat.
   */
  fix?: { label: string; patch: Record<string, unknown>; note?: string };
}

export type AiConfigCheck =
  | { ok: true; config: AiConfig; warnings: AiConfigWarning[] }
  | { ok: false; problems: string[]; needsSetup: boolean };

/** Whether the user has done enough for a request to be attempted at all. */
export function checkAiConfig(settings: Record<string, unknown>): AiConfigCheck {
  const config = aiSettingsFrom(settings);
  const preset = legacyProviderById(config.provider);
  const problems: string[] = [];
  let needsSetup = false;
  // Read through a coercion rather than the declared type: this is the function the
  // panels call to decide whether they can do anything, so it is the last place that
  // should be able to throw. A field that arrived as `undefined` has to read as
  // "empty" -- "还没有填端点地址" is a diagnosis, and
  // `Cannot read properties of undefined (reading 'trim')` is not.
  const text = (value: unknown): string => (typeof value === "string" ? value : "");

  if (!text(config.apiKey).trim() && preset?.needsKey) {
    needsSetup = true;
    problems.push(`还没有填 ${preset.label} 的 ${preset.credentialLabel ?? "API Key"}。`);
  }
  const baseUrl = text(config.baseUrl);
  if (!baseUrl.trim()) {
    needsSetup = true;
    problems.push("还没有填端点地址。");
  } else {
    const verdict = parseBaseUrl(baseUrl);
    if (!verdict.ok) problems.push(verdict.reason);
  }
  if (!text(config.model).trim()) {
    needsSetup = true;
    problems.push("还没有填模型名。");
  }
  // Zero images allowed means the card extractor would ask for cards from
  // nothing; the planner does not care, so this is reported rather than refused.
  if (!(Number(config.maxImages) >= 1)) problems.push("「一次最多几张图片」至少要 1。");

  if (problems.length) return { ok: false, problems, needsSetup };
  return { ok: true, config, warnings: configWarnings(config, preset) };
}

/**
 * Combinations that are filled in, parseable, and almost certainly wrong.
 *
 * `checkAiConfig` answers "can a request be attempted"; this answers "is the
 * request being aimed at the right thing". Keeping them apart is what lets the
 * panel still work while saying the address is wrong: a cloud preset pointed at
 * `127.0.0.1:3080` is not an incomplete form, it is a complete form aimed at
 * another program -- and it fails with a 405 that names the address but not the
 * mismatch. These are the sentences and the one-click fixes that replace it.
 *
 * A warning is never a refusal. `custom` has no `expectedHost`, so a user who
 * really does run an OpenAI-shaped gateway on this machine is not nagged.
 */
export function configWarnings(
  config: AiConfig,
  preset: AiProviderPreset | null = legacyProviderById(config.provider),
): AiConfigWarning[] {
  const warnings: AiConfigWarning[] = [];
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  if (!baseUrl || !preset) return warnings;
  let host = "";
  let port = "";
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    port = url.port;
  } catch {
    return warnings;
  }
  const loopback = isLoopbackHost(host);
  // 3080 is checked first because it is the most specific answer: an endpoint
  // there is not "a cloud address that looks local", it is the DSH web server,
  // and switching to that preset is the repair rather than clearing the field.
  if (loopback && port === "3080" && preset.id !== "dsh") {
    warnings.push({
      code: "dsh-port-on-other-provider",
      message:
        "这个端口（3080）是本机 DeepSeek Harness（dsh web）的 Web 服务，它不是 OpenAI 兼容接口。" +
        "要连它请把服务商改成「本机 DeepSeek Harness」并填访问令牌。",
      fix: {
        label: "改用本机 DeepSeek Harness",
        patch: {
          aiProvider: "dsh",
          aiStoredFor: "dsh",
          aiBaseUrl: "http://127.0.0.1:3080",
          aiProtocol: "",
          aiModel: "",
        },
        note: "切换后还需要把 dsh web 启动链接里的令牌填进「访问令牌」。",
      },
    });
    return warnings;
  }
  if (preset.expectedHost === "remote" && loopback) {
    warnings.push({
      code: "cloud-provider-local-address",
      message:
        `服务商是「${preset.label}」，但端点地址指向本机（${baseUrl}）。云端服务不会监听这个端口，` +
        "这通常是地址填错了；清空端点地址就会回落到服务商的默认地址。",
      fix: { label: "改用官方默认地址", patch: { aiBaseUrl: "", aiProtocol: "", aiModel: "" } },
    });
  }
  if (preset.expectedHost === "loopback" && !loopback) {
    warnings.push({
      code: "local-provider-remote-address",
      message:
        `服务商是「${preset.label}」（本机服务），但端点地址是 ${host}。` +
        "本机服务只在 127.0.0.1 / localhost 上，改成默认地址才能连上。",
      fix: { label: "改用默认本机地址", patch: { aiBaseUrl: preset.baseUrl, aiProtocol: "", aiModel: "" } },
    });
  }
  return warnings;
}


/** The model id to send to an OpenAI-shaped endpoint, with any `provider/` stripped. */
export function openAiModelId(model: string): string {
  const at = model.lastIndexOf("/");
  return at < 0 ? model : model.slice(at + 1);
}

// ---------------------------------------------------------------------------
// Base URL policy
// ---------------------------------------------------------------------------

/** Is this hostname the machine the plugin is running on? */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "::1") return true;
  // The whole 127/8 block, not just 127.0.0.1: a second local server on
  // 127.0.0.2 is still local, and rejecting it would be a rule about a spelling.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  return false;
}

export type BaseUrlVerdict = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Accept only what the plugin is allowed to talk to.
 *
 * The rule is about the **scheme**, not about the host, and that is the change
 * this version makes: a hosted provider is reachable (it is in the preset table,
 * or the user typed it), but a key may only ever travel over TLS. So:
 *
 * * `https:` is allowed to any host -- it is the user's own endpoint and their
 *   own key, and the guard's job is now to keep the *places* a request can be
 *   built to one file rather than to forbid the request.
 * * `http:` is allowed **only to this machine**. Sending an API key in cleartext
 *   across a network is the one thing worth refusing outright, and a loopback
 *   address is the one case where there is no network to cross. This is what
 *   replaced the old `allowRemote` flag: the flag could not express the
 *   distinction it was named for, because it also refused `https:`.
 *
 * A trailing slash is stripped so `base + "/v1/..."` cannot produce a `//`.
 */
export function parseBaseUrl(raw: string): BaseUrlVerdict {
  const text = raw.trim().replace(/\/+$/, "");
  if (!text) return { ok: false, reason: "端点地址是空的。" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `端点地址不是一个合法的 URL，例如 ${AI_DEFAULT_BASE_URL}。` };
  }
  if (url.protocol === AI_REMOTE_SCHEME) return { ok: true, url: url.origin + url.pathname.replace(/\/+$/, "") };
  if (url.protocol === AI_LOCAL_SCHEME) {
    if (!isLoopbackHost(url.hostname)) {
      return {
        ok: false,
        reason: `明文 http 只允许连本机（127.0.0.1 / localhost），而 ${url.hostname} 不是。改用 https，否则 API Key 会以明文经过网络。`,
      };
    }
    return { ok: true, url: url.origin + url.pathname.replace(/\/+$/, "") };
  }
  return { ok: false, reason: `不支持的协议 ${url.protocol}，只支持 https:（远程）与 http:（仅本机）。` };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type AiRole = "system" | "user" | "assistant";

export interface AiImage {
  mediaType: AiImageType;
  /** Canonical base64, no `data:` prefix. */
  base64: string;
  name?: string;
}

export interface AiMessage {
  role: AiRole;
  text: string;
  images?: AiImage[];
}

export interface AiRequest {
  messages: AiMessage[];
  maxTokens?: number;
}

export interface AiReply {
  text: string;
  model: string;
  /**
   * Reasoning a provider chose to return, when it returns any.
   *
   * DeepSeek reasoner and some gateways put `reasoning_content` beside the
   * answer. It is not a hidden chain of thought and it is not always present;
   * the process panel shows it when it exists and says so when it does not,
   * because inventing a reasoning trace would be worse than having none.
   */
  reasoning?: string;
}

/**
 * The one capability a plugin must supply.
 *
 * Injected rather than imported so this module stays pure. The plugin's
 * implementation is a dozen lines over `node:http`; the tests' implementation
 * returns whatever the test scripted, which is what makes the request bodies
 * (the part that is easy to get wrong and hard to see) assertable at all.
 *
 * Note what is **not** in the options: a credential. The caller passes the
 * `AiConfig` and the transport decides what to do with `config.apiKey`, because
 * the guard forbids a header assignment anywhere but the one declared transport
 * file. That is not a technicality -- it is the property that makes "this
 * plugin only ever sends your credentials from one auditable place" true.
 */
export type AiFetch = (
  url: string,
  init: { method: "POST" | "GET"; headers: Record<string, string>; body: string },
  config: AiConfig,
) => Promise<{ status: number; text: string }>;

/**
 * A failure worth showing the user, with a message already in their language.
 *
 * `status` is carried for the diagnostics line and for tests; nothing branches
 * on it for control flow, because by the time a request fails the useful
 * question is "what do I change", not "which number came back".
 */
export class AiError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "AiError";
    this.status = options.status;
    this.code = options.code;
  }
}

/**
 * Every non-2xx status, phrased as the change that would fix it.
 *
 * `config` is optional so the pure per-status behaviour stays testable on its
 * own, but every call site passes it: the two facts a user needs to fix a 401
 * are **which header the key went into** and **which URL was called**, and
 * neither is recoverable from the status code. Without them "令牌无效" sends the
 * reader to the key, when the actual mistake is often that the provider was
 * switched and the header no longer matches the service.
 */
export function classifyStatus(status: number, body = "", config?: AiConfig, requestUrl?: string): AiError {
  const snippet = body.trim().slice(0, 200);
  const trailer = snippet ? ` 返回内容：${snippet}` : "";
  // Where the request went and how it was authenticated. Named so a mismatch is
  // visible: `x-api-key` against a service expecting `Authorization` produces a
  // 401 that looks exactly like a wrong key.
  const where = config ? `端点 ${config.baseUrl}` : "";
  const how = config?.authHeader ? `，用的是 ${config.authHeader} 头` : "";
  const context = where ? `${where}${how}。` : "";

  if (status === 401 || status === 403) {
    const expired = /expired|invalid|revoked|incorrect|unauthorized/i.test(body) ? " 服务端说是无效或已过期。" : "";
    return new AiError(
      `API Key 被拒绝了（${status}）：${context}到设置里检查 Key，或换一个服务商。${expired}${trailer}`,
      { status },
    );
  }
  if (status === 404) {
    return new AiError(
      `端点没有这个路径（404）：${context}地址通常要写到 ` +
        `服务商的根或 /v1 为止，不要写到 /chat/completions。${trailer}`,
      { status },
    );
  }
  if (status === 405) {
    // 405 is the shape mismatch this project can actually diagnose: the path
    // exists, the method does not fit it. The two live arrangements that
    // produce it are a cloud preset aimed at the local DSH port and a DSH
    // preset spoken to with the OpenAI protocol, so both repairs are named.
    const target = requestUrl ? `请求实际发到了 ${requestUrl}。` : "";
    return new AiError(
      `这个地址不接受这种请求（405）。${target}` +
        "如果端点是本机 3080（DeepSeek Harness 的 Web 服务），它不是 OpenAI 兼容接口：" +
        "请把服务商换成「本机 DeepSeek Harness」并填访问令牌；" +
        `如果用的是云端服务，请把「高级 → 端点地址」清空，用服务商的默认地址。${trailer}`,
      { status },
    );
  }
  if (status === 413) {
    return new AiError(`图片或请求体太大（413）：减少图片张数，或先压缩图片。${trailer}`, { status });
  }
  if (status === 429) {
    return new AiError(
      `触发限流或额度用尽（429）：稍后重试；API Key 的免费额度用完也是这个状态。${trailer}`,
      { status },
    );
  }
  if (status >= 500) {
    return new AiError(`服务端错误（${status}）：服务可能没起来，或模型没加载。${trailer}`, { status });
  }
  return new AiError(`请求失败（${status}）。${context}${trailer}`, { status });
}

/**
 * A non-2xx response, with the "this address is a web page, not an API" case
 * separated out.
 *
 * The commonest setup mistake is an endpoint one path segment too long, and the
 * symptom is an HTML error page from a CDN or a 404 page from the vendor. Both
 * arrive as a body full of `<!DOCTYPE html>`, and reporting that as "the
 * endpoint returned invalid JSON" sends the reader to the model instead of to
 * the address field.
 */
export function classifyResponse(status: number, body: string, config?: AiConfig, requestUrl?: string): AiError {
  const head = body.trim().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<html")) {
    return new AiError(
      `这个地址返回的是网页不是 API（${status}）：${config ? `端点 ${config.baseUrl}。` : ""}` +
        `地址通常写到服务商的根或 /v1 为止，不要带 /chat/completions。`,
      { status },
    );
  }
  return classifyStatus(status, body, config, requestUrl);
}


// ---------------------------------------------------------------------------
// The backends
// ---------------------------------------------------------------------------

export interface AiBackend {
  kind: AiProtocol;
  /** A short label for diagnostics: what was called, and where. */
  describe(): string;
  complete(request: AiRequest): Promise<AiReply>;
}

/**
 * The headers this module sets itself.
 *
 * No credential, deliberately: the transport owns the key so that every place it
 * could be attached is one file. See `AiFetch`.
 *
 * A provider's own required headers travel in the `AiConfig`, not in the
 * transport, because they are a fact about the provider rather than about the
 * socket: the transport's job is to attach whatever it is handed.
 */
function jsonHeaders(config: AiConfig): Record<string, string> {
  return { "content-type": "application/json", ...(config.extraHeaders ?? {}) };
}

/**
 * The default output ceiling for the Anthropic shape.
 *
 * `max_tokens` is **required** there -- omitting it is a 400, not a default --
 * so this is a value the request must carry rather than a limit that can be left
 * out. 4096 is comfortably above a full card set or plan and below the point
 * where a runaway reply costs anything noticeable.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/**
 * The endpoint a request is actually sent to, built from the base the user has.
 *
 * ## Why this cannot be `base + "/v1/chat/completions"`
 *
 * Because services disagree about where the path starts, and the docs are the
 * only authority. DeepSeek's `base_url` is `https://api.deepseek.com` and its
 * OpenAI-compatible chat endpoint is `https://api.deepseek.com/chat/completions`
 * -- there is **no** `/v1`. OpenAI's own base_url already ends in `/v1`, so
 * appending another one gave `…/v1/v1/chat/completions`. Guessing from one
 * provider's convention produced a URL that was wrong for the other, and the
 * symptom was a bare 404 with nothing on screen to explain it.
 *
 * The rule is therefore symmetric and stated once:
 *
 * * a base that already ends in `/v1` keeps it, and the path is `/chat/completions`;
 * * any other base gets `/v1/chat/completions`.
 *
 * So `https://api.deepseek.com` and `https://api.openai.com/v1` both produce the
 * right URL, and a user who pastes either spelling from either set of docs is
 * correct. For the Anthropic shape the Messages path hangs off `/v1` for everyone
 * (their own docs and DeepSeek's Anthropic-compatible endpoint both use it), so
 * `https://api.deepseek.com/anthropic` works as pasted.
 */
export function apiUrlFor(baseUrl: string, protocol: AiProtocol, options: { models?: boolean } = {}): string {
  // `?? ""` rather than trusting the type: this is called with a config that may
  // have been built by another module or read from a file an older version wrote,
  // and `undefined.trim()` is a `TypeError` the user sees instead of a diagnosis.
  // A missing base then produces an empty URL, which the callers already treat as
  // "not configured".
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (protocol === "dsh") return `${base}/api/${options.models ? "session/list" : "session/create"}`;
  const hasV1 = /\/v1$/.test(base);
  const suffix = options.models ? "/models" : protocol === "anthropic" ? "/messages" : "/chat/completions";
  return hasV1 ? `${base}${suffix}` : `${base}/v1${suffix}`;
}

/**
 * The OpenAI-compatible shape.
 *
 * Images become data URLs here; the Anthropic adapter below uses a different
 * wrapper for the same bytes, which is why the two cannot share one request
 * builder.
 */
export function createOpenAiBackend(config: AiConfig, send: AiFetch): AiBackend {
  const url = apiUrlFor(config.baseUrl, "openai");
  const model = openAiModelId(config.model);
  return {
    kind: "openai",
    describe: () => `openai ${model} @ ${url}`,
    async complete(request) {
      const body = JSON.stringify({
        model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: [
            { type: "text", text: message.text },
            ...(message.images ?? []).map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
            })),
          ],
        })),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      });
      const response = await send(url, { method: "POST", headers: jsonHeaders(config), body }, config);
      if (response.status < 200 || response.status >= 300) throw classifyResponse(response.status, response.text, config, url);
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.text);
      } catch {
        throw new AiError(`端点返回的不是 JSON：${response.text.trim().slice(0, 200)}`, { status: response.status });
      }
      const text = openAiReplyText(parsed);
      if (text === null) {
        throw new AiError("端点的回复里没有找到文本内容（choices[0].message.content）。", { status: response.status });
      }
      const reasoning = openAiReplyReasoning(parsed);
      return { text, model, ...(reasoning ? { reasoning } : {}) };
    },
  };
}

/** `choices[0].message.reasoning_content`, or null when the provider sent none. */
function openAiReplyReasoning(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const reasoning = (message as { reasoning_content?: unknown; reasoning?: unknown }).reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning;
  const fallback = (message as { reasoning?: unknown }).reasoning;
  return typeof fallback === "string" && fallback.trim() ? fallback : null;
}

/** `choices[0].message.content`, or null when the shape is not that. */
function openAiReplyText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  // Some servers answer with the content-parts array even when not streaming.
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : null))
      .filter((part): part is string => typeof part === "string");
    return parts.length ? parts.join("") : null;
  }
  return null;
}

/**
 * The Anthropic Messages shape.
 *
 * Three things differ from the OpenAI shape, and each of them fails in a way
 * that reads like a different problem:
 *
 * 1. **`system` is a top-level field, not a message.** Sent inside `messages` it
 *    is a 400 whose text mentions roles, which reads like a malformed request
 *    rather than like a misplaced prompt.
 * 2. **`max_tokens` is required.** Omitting it is a 400, so the default here is
 *    not a convenience but the field the API insists on.
 * 3. **Images are `{type:"image", source:{type:"base64", ...}}`**, not an
 *    `image_url` carrying a data URL. Reusing the OpenAI encoder would send a
 *    data URL as the base64 payload and produce a decode error server-side.
 *
 * `kind` is reported as `anthropic` so diagnostics say which shape was used.
 */
export function createAnthropicBackend(config: AiConfig, send: AiFetch): AiBackend {
  const url = apiUrlFor(config.baseUrl, "anthropic");
  const model = openAiModelId(config.model);
  return {
    kind: "anthropic",
    describe: () => `anthropic ${model} @ ${url}`,
    async complete(request) {
      // The system turns are lifted out and joined; the rest keep their order.
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.text)
        .filter((text) => text.trim().length > 0)
        .join("\n\n");
      const turns = request.messages.filter((message) => message.role !== "system");
      const body = JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages: turns.map((message) => ({
          role: message.role,
          content: [
            ...(message.text.trim() ? [{ type: "text", text: message.text }] : []),
            ...(message.images ?? []).map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data: image.base64 },
            })),
          ],
        })),
      });
      const response = await send(url, { method: "POST", headers: jsonHeaders(config), body }, config);
      if (response.status < 200 || response.status >= 300) {
        throw classifyResponse(response.status, response.text, config, url);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.text);
      } catch {
        throw new AiError(`端点返回的不是 JSON：${response.text.trim().slice(0, 200)}`, { status: response.status });
      }
      const text = anthropicReplyText(parsed);
      if (text === null) {
        throw new AiError("端点的回复里没有找到文本内容（content[].text）。", { status: response.status });
      }
      return { text, model };
    },
  };
}

/** `content[].text` joined, or null when the shape is not that. */
function anthropicReplyText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const content = (payload as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : null))
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length ? parts.join("") : null;
}

/**
 * The DeepSeek Harness native RPC.
 *
 * Four calls, in order, and the shape of each one is load-bearing:
 *
 * 1. `session/create` -- DSH has no stateless completion. A prompt needs a
 *    session that already exists.
 * 2. `session/selectModel` -- the model is a property of the session, not of the
 *    request, so it has to be chosen before the prompt is sent.
 * 3. `session/prompt` -- **fire and forget**. It answers `{accepted:true}` and
 *    nothing else; there is no endpoint that returns the model's text in the
 *    same response.
 * 4. `session/page` -- polled until an assistant message shows up, which is the
 *    only way to read the reply over plain HTTP.
 *
 * A **fresh session per call** is deliberate. Reusing one would make the page
 * window contain the previous answers, and would hand the model a transcript to
 * continue instead of an instruction to follow -- and it would put `requestId`
 * de-duplication in the path, so a retry after a timeout would return the first
 * attempt's `accepted` and look like the second attempt ran. The cost is a
 * throwaway session per action, which is written under the user's own DSH home
 * and is therefore not hidden from them.
 */
export function createDshBackend(
  config: AiConfig,
  send: AiFetch,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): AiBackend {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rpc = (method: string) => `${config.baseUrl}/api/${method}`;
  const catalog = splitModel(config.model);

  /**
   * One RPC round trip.
   *
   * `result.ok === false` is the interesting case: DSH reports business errors
   * *inside* an HTTP 200 envelope, so a client that only checks the status code
   * treats "no such model" as success and then waits for a reply that will never
   * come. Both layers are checked here.
   */
  async function call(method: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const url = rpc(method);
    let response: { status: number; text: string };
    try {
      response = await withTimeout(
        send(
          url,
          {
            method: "POST",
            headers: jsonHeaders(config),
            body: JSON.stringify({
              type: "client-request",
              rpcId: `${method}-${now().toString(36)}`,
              method,
              payload: { args },
            }),
          },
          config,
        ),
        timeoutMs,
        `调用 ${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`,
      );
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError(`连接 ${url} 失败：${describeError(error)}`);
    }
    if (response.status < 200 || response.status >= 300) throw classifyResponse(response.status, response.text, config, url);
    let envelope: unknown;
    try {
      envelope = JSON.parse(response.text);
    } catch {
      throw new AiError(`${method} 返回的不是 JSON：${response.text.trim().slice(0, 200)}`);
    }
    const result = (
      envelope as { result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } }
    ).result;
    if (!result) throw new AiError(`${method} 的回复里没有 result 字段：${response.text.trim().slice(0, 200)}`);
    if (result.ok === false) {
      throw new AiError(
        `${method} 失败：${result.error?.message ?? "没有说明"}（${result.error?.code ?? "未知错误码"}）`,
        { code: result.error?.code },
      );
    }
    return result.value;
  }

  return {
    kind: "dsh",
    describe: () => `dsh ${config.model} @ ${config.baseUrl}`,
    async complete(request) {
      const created = (await call("session/create", { request: {} }, config.timeoutMs)) as { sessionId?: unknown };
      const sessionId = typeof created?.sessionId === "string" ? created.sessionId : "";
      if (!sessionId) throw new AiError("DSH 没有返回会话 id，无法继续。");
      if (catalog.provider) {
        await call(
          "session/selectModel",
          { request: { sessionId, provider: catalog.provider, ...(catalog.model ? { model: catalog.model } : {}) } },
          config.timeoutMs,
        );
      }
      const content = request.messages.flatMap((message) => dshContent(message));
      await call(
        "session/prompt",
        {
          request: {
            requestId: `sfc-${now().toString(36)}`,
            sessionId,
            mode: "queue",
            content,
          },
        },
        config.timeoutMs,
      );

      const deadline = now() + config.timeoutMs;
      let lastExcerpt = "";
      for (;;) {
        const page = await call(
          "session/page",
          { request: { address: { kind: "session", sessionId }, throughSeq: -1, maxMessages: 50 } },
          Math.max(5000, deadline - now()),
        );
        const found = dshReplyText(page);
        if (found) return { text: found, model: config.model };
        lastExcerpt = JSON.stringify(page).slice(0, 400);
        if (now() >= deadline) {
          throw new AiError(
            `等待模型回复超时（${Math.round(config.timeoutMs / 1000)} 秒）。会话已经建立，` +
              `可以在 DSH 里查看 ${sessionId}。最后读到的事件：${lastExcerpt}`,
          );
        }
        await sleep(700);
      }
    },
  };
}

/** `provider/model` -> both halves; a bare id leaves `provider` empty. */
export function splitModel(model: string): { provider: string; model: string } {
  const at = model.indexOf("/");
  if (at < 0) return { provider: "", model };
  return { provider: model.slice(0, at), model: model.slice(at + 1) };
}

/** A message as DSH content parts. Images are bare base64, never a data URL. */
function dshContent(message: AiMessage): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  if (message.text.trim()) parts.push({ type: "text", text: message.text });
  for (const image of message.images ?? []) {
    parts.push({
      type: "image",
      mediaType: image.mediaType,
      data: image.base64,
      ...(image.name ? { name: image.name } : {}),
    });
  }
  return parts;
}

/**
 * The reply text out of a `session/page` result.
 *
 * The event's payload shape was **not** confirmed against a live server: DSH
 * stores sessions as zstd-compressed logs, and the offline survey could only
 * establish that an `assistant/message` event carries the text somewhere in
 * `data`. So three plausible shapes are accepted, and a shape that is none of
 * them yields `null` -- which makes the caller time out and print the raw event,
 * the one outcome that actually gets the shape fixed. Guessing here would mean
 * silently returning an empty card list instead.
 */
export function dshReplyText(page: unknown): string | null {
  const records = (page as { records?: unknown })?.records;
  if (!Array.isArray(records)) return null;
  let best: string | null = null;
  for (const record of records) {
    const event = (record as { event?: { type?: unknown; data?: unknown } })?.event;
    if (!event || typeof event.type !== "string") continue;
    if (event.type !== "assistant/message") continue;
    const text = textInData(event.data);
    if (text) best = text;
  }
  return best;
}

/** Depth-first search for a `text` string, for the three shapes we expect. */
function textInData(data: unknown): string | null {
  if (typeof data === "string") return data.trim() || null;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : null))
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    if (parts.length) return parts.join("");
  }
  if (record.message) {
    const inner = textInData(record.message);
    if (inner) return inner;
  }
  return null;
}

/** Reject a promise that outlives the budget, with a message the user can act on. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AiError(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `${error.message}（${code}）` : error.message;
  }
  return String(error);
}

/**
 * Build whichever backend the configuration names.
 *
 * Three shapes, one entry point. A protocol with no branch here would be a
 * preset that silently falls through to OpenAI's request body and fails with a
 * 400 -- which is why the union lives in the provider table and not in this
 * file: an unhandled `kind` is a compile error rather than a runtime surprise.
 */
export function createBackend(config: AiConfig, send: AiFetch): AiBackend {
  switch (config.protocol) {
    case "anthropic":
      return createAnthropicBackend(config, send);
    case "dsh":
      return createDshBackend(config, send);
    default:
      return createOpenAiBackend(config, send);
  }
}

/**
 * Check a configuration by asking for the model list.
 *
 * `GET /models` is the one request that answers "is this reachable and is this key
 * accepted" **without spending tokens and without needing the model name to be
 * right**. The first version of the connection check sent a one-word chat request,
 * which meant a typo in the model field came back as a failure of the whole
 * configuration -- and a token was billed for the privilege. Every provider in the
 * table that speaks OpenAI or Anthropic serves `/models`, and it needs the same
 * credential the real requests do, so a 200 here is a real answer.
 *
 * Returns `null` when the endpoint has no such route (a 404 or 405), which means
 * *inconclusive* rather than broken: the caller falls back to a chat probe, and
 * says in its message which one it used.
 */
export async function probeModels(
  config: AiConfig,
  send: AiFetch,
): Promise<{ ok: boolean; models: number; note: string } | null> {
  if (config.protocol === "dsh") return null;
  const url = apiUrlFor(config.baseUrl, config.protocol === "anthropic" ? "anthropic" : "openai", { models: true });
  if (!url) return null;
  const response = await send(url, { method: "GET", headers: jsonHeaders(config), body: "" }, config);
  if (response.status === 404 || response.status === 405) return null;
  if (response.status < 200 || response.status >= 300) {
    throw classifyResponse(response.status, response.text, config, url);
  }
  let count = 0;
  try {
    const parsed: unknown = JSON.parse(response.text);
    // Both shapes: OpenAI uses `data`, Anthropic uses `data` too, and a gateway may
    // answer with a bare array.
    const list = Array.isArray(parsed) ? parsed : (parsed as { data?: unknown })?.data;
    count = Array.isArray(list) ? list.length : 0;
  } catch {
    // A 200 whose body is not JSON is still a reachable, authenticated endpoint.
    return { ok: true, models: 0, note: "（返回的不是模型列表，但地址与 Key 都被接受了）" };
  }
  const names = modelNames(response.text);
  const wanted = openAiModelId(config.model);
  const note = names.length && wanted && !names.includes(wanted) ? `（列表里没有 ${wanted}，确认一下模型名）` : "";
  return { ok: true, models: count, note };
}
/**
 * Check a DSH endpoint without creating a session.
 *
 * `session/list` is DSH's read-only RPC: it wants the same bearer token every
 * other call does, answers in the same `{result:{ok,...}}` envelope, and creates
 * nothing. That is what lets the local path report "connected" without the
 * token-billed chat probe -- and without leaving a throwaway session behind just
 * to prove the server is running.
 *
 * `null` means "no such route", not "broken": a gateway that only implements
 * `session/create` falls through to the chat probe the same way a cloud endpoint
 * without `/models` does.
 */
export async function probeDsh(config: AiConfig, send: AiFetch): Promise<{ note: string } | null> {
  if (config.protocol !== "dsh") return null;
  const url = apiUrlFor(config.baseUrl, "dsh", { models: true });
  if (!url) return null;
  const response = await send(
    url,
    {
      method: "POST",
      headers: jsonHeaders(config),
      body: JSON.stringify({
        type: "client-request",
        // Unique per call so a retry is not de-duplicated by the server into the
        // previous attempt''s answer; its value carries no meaning.
        rpcId: `probe-${Date.now().toString(36)}`,
        method: "session/list",
        payload: { args: {} },
      }),
    },
    config,
  );
  if (response.status === 404 || response.status === 405) return null;
  if (response.status < 200 || response.status >= 300) {
    throw classifyResponse(response.status, response.text, config, url);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(response.text);
  } catch {
    // A 200 that is not the RPC envelope still proves the endpoint and token
    // were accepted; saying so is more useful than calling it a parse failure.
    return { note: "端点可读（返回的不是 RPC 信封，但令牌被接受了）" };
  }
  const result = (envelope as { result?: { ok?: boolean; error?: { message?: string; code?: string } } }).result;
  if (result?.ok === false) {
    throw new AiError(
      `DSH 拒绝了这个请求：${result.error?.message ?? "没有说明"}（${result.error?.code ?? "未知错误码"}）`,
      { code: result.error?.code },
    );
  }
  return { note: "令牌有效（未创建会话）" };
}

/** Model ids out of a `/models` body, so a wrong model name can be noticed here. */
function modelNames(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : (parsed as { data?: unknown })?.data;
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly, shared by both features
// ---------------------------------------------------------------------------

