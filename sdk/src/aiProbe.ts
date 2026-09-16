/**
 * The connectivity probe, kept pure so `node --test` can exercise it.
 *
 * This module exists because of the bug that made the two-step check fiction:
 * `probeAiConnection` handed the plugin's raw settings (`aiBaseUrl`, `aiModel`)
 * to `probeModels`, which reads an `AiConfig` (`baseUrl`, `model`). The URL came
 * out empty, the probe returned `null`, and every "检测连接" quietly fell through
 * to a chat request that spent a token -- so the `/models` step that exists to be
 * free was never once used.
 *
 * The rule that falls out of it: **resolve the settings before deciding
 * anything**, which is the first line of `probeAiConnection` now, and is the
 * reason this file is separate from `aiSettings.ts` -- the settings renderer
 * imports Obsidian, and a module that imports Obsidian cannot be run by
 * `node --test`.
 */
import { aiSettingsFrom, probeDsh, probeModels, type AiFetch } from "./ai";
import { AiStatusTracker, statusKey } from "./aiStatus";

/**
 * The prompt every connectivity check sends.
 *
 * One word in, one word out: the check is about reachability and credentials, and
 * anything longer costs tokens and time for information the user did not ask for.
 * The instruction to answer with a single character is also a cheap sanity check
 * that the model is a chat model at all -- a completion endpoint that ignores it
 * still answers, which is the signal.
 */
export const AI_PROBE_MESSAGES = [
  { role: "system" as const, text: "只回一个字。" },
  { role: "user" as const, text: "回「好」。" },
];

/**
 * A tracker for the whole plugin: one probe, one verdict, three surfaces.
 *
 * `send` is the plugin's transport, passed so the models probe can run before the
 * chat probe. Without it the tracker would have to fall back to the chat request
 * for every check, which is the behaviour the two-step probe exists to avoid.
 */
export function makeAiStatusTracker(
  settings: () => Record<string, unknown>,
  complete: (config: Record<string, unknown>) => Promise<{ text: string; describe: string }>,
  send?: AiFetch,
): AiStatusTracker {
  return new AiStatusTracker(async () => {
    const config = settings();
    const message = await probeAiConnection(config, complete, send ? { send } : {});
    return {
      message,
      endpoint: String(config.aiBaseUrl ?? ""),
      model: String(config.aiModel ?? ""),
    };
  });
}

/** The key a verdict is filed under, from the plugin's own settings. */
export function aiStatusKeyFor(settings: Record<string, unknown>): string {
  return statusKey({
    provider: String(settings.aiProvider ?? ""),
    baseUrl: String(settings.aiBaseUrl ?? ""),
    protocol: String(settings.aiProtocol ?? ""),
    model: String(settings.aiModel ?? ""),
    apiKey: String(settings.aiApiKey ?? ""),
  });
}

/**
 * Ask the configured endpoint whether it answers, and report it in one sentence.
 *
 * Two steps, cheapest first:
 *
 * 1. `GET /models` -- no tokens, and it does not care whether the model name is
 *    right, so a 200 proves the address and the key are both good. This is the step
 *    that exists because the first version sent a chat request instead, so a typo
 *    in the model field came back as a failure of the whole configuration and a
 *    token was billed to find out.
 * 2. Only when the endpoint has no such route (404/405, reported as `null`), a
 *    one-word chat request -- which also proves the *model* works.
 *
 * The message says which step produced the answer, because "已连通" from a `/models`
 * 200 and one from a real completion mean slightly different things.
 */
export async function probeAiConnection(
  config: Record<string, unknown>,
  complete: (config: Record<string, unknown>) => Promise<{ text: string; describe: string }>,
  options: { send?: AiFetch; } = {},
): Promise<string> {
  if (options.send) {
    // Resolve the plugin's `aiXxx` keys into an `AiConfig` before probing: the
    // first version handed raw settings to `probeModels`, whose `baseUrl` was
    // undefined there, so the probe URL came out empty and every check fell
    // through to a token-billed chat request.
    const resolved = aiSettingsFrom(config);
    const models = await probeModels(resolved, options.send);
    if (models) {
      const count = models.models ? `能读到 ${models.models} 个模型` : "模型列表可读";
      return `${resolved.baseUrl} · ${count} ${models.note}（未消耗 token）`;
    }
    if (resolved.protocol === "dsh") {
      const dsh = await probeDsh(resolved, options.send);
      if (dsh) return `${resolved.baseUrl} · ${dsh.note}（未创建会话）`;
    }
  }
  const answer = await complete(config);
  return `${answer.describe} · 回复「${answer.text.trim().slice(0, 20)}」`;
}

