/**
 * Settings plus a secret lookup become one request-shaped runtime config.
 *
 * This is the seam between the stored schema (`AiSettings`, normalized by the
 * SDK) and the adapter (which only understands a base URL, a model and a header
 * pair). Keeping it pure is what makes the interesting failures testable without
 * Obsidian: a selected provider whose key is missing, a custom row with no
 * address, a protocol the host cannot speak yet.
 *
 * The key is passed in as a lookup rather than read from settings on purpose:
 * `AiSettings.apiKeyRef` is an id, and the value lives in the keychain. Nothing
 * in this file can accidentally serialize a credential because it never stores
 * one -- the returned config carries the key for the lifetime of one request.
 */

import { AI_DEFAULT_PROVIDER, providerById } from "../sdk/src/aiProviders";
import { adapterFor } from "../sdk/src/ai/aiAdapters/index";
import { resolveProviders, type AiProviderEntry, type AiSettings } from "../sdk/src/ai/aiSettingsSchema";

/**
 * Re-exported so the host and its tests can build a settings object without
 * reaching around this module into the SDK. A first run needs "the defaults",
 * and that is a legitimate thing for the settings adapter to hand out.
 */
export { defaultAiSettings, normalizeAiSettings } from "../sdk/src/ai/aiSettingsSchema";

/** Which settings slot is being resolved. */
export type AiRuntimeRole = "chat" | "apply" | "embedding";

export interface AiRuntimeConfig {
  providerId: string;
  label: string;
  protocol: "openai" | "anthropic" | "gemini" | "dsh";
  baseUrl: string;
  model: string;
  /** Secret value for one request. Never written back to settings. */
  apiKey: string;
  /** Resolved header name; empty means the provider sends no credential. */
  authHeader: string;
  authPrefix: string;
  extraHeaders: Record<string, string>;
  timeoutMs: number;
  maxImages: number;
  stream: boolean;
  temperature: number;
  needsKey: boolean;
}

export type AiRuntimeResult =
  | { ok: true; config: AiRuntimeConfig }
  | { ok: false; reason: "unsupported-protocol" | "unsupported-embedding" | "missing-base-url" | "missing-model" | "missing-key"; message: string };

/**
 * The provider row a role should use right now.
 *
 * `apply` and `embedding` fall back to the chat slot rather than to the default
 * preset: a user who chose DeepSeek and left apply empty means "same account",
 * not "silently switch to whatever the table ships first".
 */
export function selectProviderRow(settings: AiSettings, role: AiRuntimeRole): AiProviderEntry {
  const rows = resolveProviders(settings);
  const slot =
    role === "chat"
      ? { providerId: settings.chat.providerId, model: settings.chat.model }
      : role === "apply"
        ? {
            providerId: settings.apply.providerId || settings.chat.providerId,
            model: settings.apply.model || settings.chat.model,
          }
        : {
            providerId: settings.rag.embeddingProviderId || settings.chat.providerId,
            model: settings.rag.embeddingModel,
          };
  const wanted = (slot.providerId || "").trim() || AI_DEFAULT_PROVIDER;
  return rows.find((row) => row.id === wanted) ?? rows.find((row) => row.id === AI_DEFAULT_PROVIDER) ?? rows[0];
}

/** Resolve one role into everything the adapter and transport need. */
export function runtimeConfigFor(
  settings: AiSettings,
  role: AiRuntimeRole,
  secretOf: (apiKeyRef: string) => string | null,
): AiRuntimeResult {
  const row = selectProviderRow(settings, role);
  const preset = providerById(row.id);
  const slotModel =
    role === "chat" ? settings.chat.model : role === "apply" ? settings.apply.model || settings.chat.model : settings.rag.embeddingModel;
  const model = (slotModel || row.model || preset?.model || "").trim();
  const baseUrl = (row.baseUrl || preset?.baseUrl || "").trim().replace(/\/+$/, "");

  const adapter = adapterFor(row.protocol);
  if (!adapter) {
    return {
      ok: false,
      reason: "unsupported-protocol",
      message:
        `宿主还不能使用 ${row.protocol} 协议（${row.label}）。` +
        "可以换成 OpenAI 兼容 / Anthropic / Gemini，或一个 OpenAI 兼容的网关。",
    };
  }
  if (role === "embedding" && !adapter.buildEmbedding) {
    return {
      ok: false,
      reason: "unsupported-embedding",
      message: `${row.label} 不提供嵌入接口。RAG 需要 OpenAI 兼容或 Gemini 的 embedding 模型。`,
    };
  }
  if (!baseUrl) {
    return { ok: false, reason: "missing-base-url", message: `${row.label} 还没有端点地址，请到设置里填一个。` };
  }
  if (!model) {
    return { ok: false, reason: "missing-model", message: `${row.label} 还没有模型名，请到设置里填一个。` };
  }
  const needsKey = preset ? preset.needsKey : Boolean(row.authHeader);
  const apiKey = (secretOf(row.apiKeyRef) ?? "").trim();
  if (needsKey && !apiKey) {
    return {
      ok: false,
      reason: "missing-key",
      message: `${row.label} 需要 API Key。它不会写进 data.json，只会存到 Obsidian 的钥匙串里。`,
    };
  }
  return {
    ok: true,
    config: {
      providerId: row.id,
      label: row.label,
      protocol: row.protocol,
      baseUrl,
      model,
      apiKey,
      authHeader: row.authHeader,
      authPrefix: row.authPrefix,
      extraHeaders: { ...row.extraHeaders },
      timeoutMs: settings.chat.timeoutMs,
      maxImages: settings.chat.maxImages,
      stream: settings.chat.stream,
      temperature: settings.chat.temperature,
      needsKey,
    },
  };
}

/**
 * A one-line description for diagnostics and the settings status row.
 *
 * The host is shown, not the full URL: a base URL can legitimately carry a query
 * token (`?token=`), and a diagnostics export that includes one is a leak with
 * extra steps. The path is dropped for the same reason.
 */
export function describeRuntime(config: AiRuntimeConfig): string {
  return `${config.label}  ${config.protocol}  ${config.model} @ ${hostOf(config.baseUrl)}`;
}

/** Hostname only, or a marker when the address cannot be parsed. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "(无主机)";
  } catch {
    return "(地址无效)";
  }
}

/** The protocols this host can speak today; the union is wider for the schema's sake. */
export function isSupportedProtocol(protocol: string): protocol is "openai" {
  return protocol === "openai";
}