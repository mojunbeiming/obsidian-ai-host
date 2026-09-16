/**
 * Prompt fragments and reply extraction that do not know about providers.
 *
 * These used to live in `ai.ts`, which imports the provider table -- so a domain
 * plugin importing `joinPrompt` pulled every remote hostname into its bundle.
 * Moving them here unchanged is what lets a domain bundle stay hostname-free.
 *
 * Pure: strings in, strings out.
 */

/** The house rule every structured-extraction prompt repeats. */
export const AI_JSON_ONLY_RULE =
  "只输出一个 JSON 对象，不要输出 markdown 代码块、不要解释、不要在 JSON 前后写任何文字。";

/** The one rule that matters most, in both features. */
export const AI_NO_INVENTION_RULE =
  "只能用材料里明确看得到、读得懂的内容。看不清或读不懂的地方，不要猜、不要补全、不要用常识替代，按各自格式说明的「读不懂」方式标注。";

export function joinPrompt(...parts: (string | undefined | null)[]): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Pull a JSON object out of a model reply.
 *
 * Models wrap JSON in ``` fences, prepend "好的，这是结果：", or both, no matter
 * how the prompt is phrased. Refusing those replies would be refusing the
 * common case, so the outermost `{...}` is located and parsed; what is *not*
 * done is repairing malformed JSON -- a truncated reply must reach the user as
 * "the model's answer was cut off", not as a half-built card.
 */
export function extractJsonObject(
  text: string,
): { ok: true; value: unknown } | { ok: false; reason: string; excerpt: string } {
  const excerpt = text.trim().slice(0, 400);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, reason: "回复里没有找到 JSON 对象。", excerpt };
  }
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch (error) {
    return {
      ok: false,
      reason: `回复里的 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      excerpt,
    };
  }
}