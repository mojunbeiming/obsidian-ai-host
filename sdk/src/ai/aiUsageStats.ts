/**
 * The numbers under the composer: turns, steps, tokens, cache hit rate.
 *
 * "Cost is visible" is a safety property, not a decoration: a user who cannot
 * see how many tokens a loop has spent cannot decide whether to stop it. The
 * arithmetic is kept here, away from the view, because it is the part that can
 * be wrong -- a hit rate computed from the wrong pair of numbers is worse than
 * no hit rate at all.
 *
 * ## What the cache hit rate means
 *
 * Providers report cached input differently: DeepSeek sends
 * `prompt_cache_hit_tokens`, Anthropic `cache_read_input_tokens`, Gemini
 * `cachedContentTokenCount`. All three answer the same question -- how much of
 * the *input* was served from cache -- so the adapters normalize them into
 * `cachedTokens`, and the rate is `cached / prompt`. When a provider reports
 * nothing, the rate is `null` and the UI omits it; showing 0% for a provider
 * that simply does not cache would be a lie.
 *
 * Pure: values in, values out.
 */

/** Token counts accumulated across turns. `cached` is a subset of `prompt`. */
export interface AiTokenTotals {
  prompt: number;
  completion: number;
  total: number;
  cached: number;
}

export interface AiUsageLike {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export function emptyTokenTotals(): AiTokenTotals {
  return { prompt: 0, completion: 0, total: 0, cached: 0 };
}

/** Add one turn's usage. Negative or non-finite numbers are ignored field by field. */
export function addUsage(totals: AiTokenTotals, usage: AiUsageLike | undefined | null): AiTokenTotals {
  if (!usage) return { ...totals };
  const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const prompt = number(usage.promptTokens);
  const completion = number(usage.completionTokens);
  const total = number(usage.totalTokens) || prompt + completion;
  const cached = Math.min(number(usage.cachedTokens), prompt);
  return {
    prompt: totals.prompt + prompt,
    completion: totals.completion + completion,
    total: totals.total + total,
    cached: totals.cached + cached,
  };
}

/** `cached / prompt`, or null when the provider reported no cache data at all. */
export function cacheHitRate(totals: AiTokenTotals): number | null {
  // No input tokens, or no cache report at all: the rate is unknown, not 0%.
  if (totals.prompt <= 0 || totals.cached <= 0) return null;
  return Math.min(1, totals.cached / totals.prompt);
}

export function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/** `940` stays exact; four digits and up become `1.2k` / `3.4M`, as token counts are read. */
export function formatTokenCount(value: number): string {
  const count = Math.max(0, Math.round(value));
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export interface AiComposerStats {
  /** Completed message pairs in the conversation. */
  rounds: number;
  /** Agent steps in the current run; 0 for plain chat. */
  steps: number;
  /** Usage of the current run. */
  run: AiTokenTotals;
  /** Usage of the whole conversation. */
  session: AiTokenTotals;
  /** Estimated cost of the current run, or null when the model is unpriced. */
  costUsd: number | null;
}

/**
 * One line: `3 轮  5 步  本次 1.2k  累计 8.4k  缓存 42%`.
 *
 * The cache segment is omitted rather than zeroed when the provider gave no
 * cache data, so its absence means "unknown" instead of "useless".
 */
export function formatComposerStats(stats: AiComposerStats): string {
  const parts: string[] = [`${Math.max(0, stats.rounds)} 轮`];
  if (stats.steps > 0) parts.push(`${stats.steps} 步`);
  parts.push(`本次 ${formatTokenCount(stats.run.total)} tokens`);
  parts.push(`累计 ${formatTokenCount(stats.session.total)} tokens`);
  const rate = cacheHitRate(stats.session);
  if (rate !== null) parts.push(`缓存 ${formatPercent(rate)}`);
  if (stats.costUsd !== null) parts.push(`$${stats.costUsd.toFixed(4)}（估算）`);
  return parts.join("  ");
}