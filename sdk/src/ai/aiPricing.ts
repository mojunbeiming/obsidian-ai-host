/**
 * Model prices, for the one thing a user can act on: "this chat cost money".
 *
 * Prices are USD per million tokens, copied from the providers' published
 * pricing at the time of writing. They are *estimates*: a gateway can charge
 * differently, cached input is cheaper, and a subscription plan is not
 * metered at all. The report therefore says "估算" and an unknown model says so
 * rather than guessing -- a wrong cost is worse than no cost, because it is
 * believed.
 *
 * Prices live in code rather than a remote table because a request for prices
 * would be a second network path for a number that changes rarely.
 */

export interface AiModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** For the settings note: where the number came from. */
  note?: string;
}

export const AI_MODEL_PRICES: Readonly<Record<string, AiModelPrice>> = {
  "deepseek-flash": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "deepseek-v4-pro": { input: 0.55, output: 2.19 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4 },
  "claude-3-5-sonnet-latest": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "qwen2.5-vl": { input: 0, output: 0, note: "本机模型，无 API 费用" },
};

export interface AiPricingUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AiCostEstimate {
  usd: number;
  known: true;
  note?: string;
}

/** Estimate a turn's cost, or null when the model is not in the table. */
export function estimateCostUsd(model: string, usage: AiPricingUsage): AiCostEstimate | null {
  const key = normalizeModel(model);
  const price = AI_MODEL_PRICES[key];
  if (!price) return null;
  const prompt = Math.max(0, usage.promptTokens) / 1_000_000;
  const completion = Math.max(0, usage.completionTokens) / 1_000_000;
  const usd = prompt * price.input + completion * price.output;
  return { usd, known: true, ...(price.note ? { note: price.note } : {}) };
}

/** `provider/model` is the stored form; the price table is keyed on the model. */
export function normalizeModel(model: string): string {
  const at = model.lastIndexOf("/");
  return (at < 0 ? model : model.slice(at + 1)).trim().toLowerCase();
}

export function formatCost(estimate: AiCostEstimate | null): string {
  if (!estimate) return "费用未知（模型不在价格表里）";
  if (estimate.usd === 0) return estimate.note ?? "无费用";
  if (estimate.usd < 0.0001) return "<$0.0001（估算）";
  return `$${estimate.usd.toFixed(4)}（估算）`;
}