/**
 * One error taxonomy for every plugin.
 *
 * Before this, a failure was a Chinese sentence in a Notice: perfect for the
 * moment, useless for "did this fail yesterday too, and always on the same
 * provider?". The record below keeps the user-facing sentence and adds the
 * stable parts -- code, category, retryable, HTTP status, a repair hint -- so
 * runs can be aggregated, deduplicated and exported without parsing prose.
 *
 * Classification is duck-typed rather than instanceof: a transport error, an
 * adapter error and a plain `Error` can all arrive here, and importing the
 * classes would drag `node:http` into every consumer's test build.
 *
 * Pure: error in, record out.
 */

export type AiErrorCategory =
  | "config"
  | "auth"
  | "network"
  | "rate_limit"
  | "provider"
  | "parse"
  | "tool"
  | "apply"
  | "rag"
  | "internal";

export type AiErrorSeverity = "warning" | "error" | "fatal";

export interface AiRunError {
  /** Stable code: `AI_AUTH_401`, `AI_TIMEOUT`, `AI_PARSE`,  */
  code: string;
  category: AiErrorCategory;
  severity: AiErrorSeverity;
  /** What the user sees. Already phrased as the change that would fix it. */
  userMessage: string;
  /** The original error/status/endpoint, redacted before it is stored. */
  technical: string;
  /** One line telling the user where to go, when there is such a place. */
  hint?: string;
  retryable: boolean;
  status?: number;
  at: number;
  /** Where in the run it happened, for the timeline. */
  stepId?: string;
  /** How many times the same failure repeated inside the merge window. */
  occurrences?: number;
}

export interface AiErrorContext {
  /** `transport`, `adapter`, `tool:vault.search`, `apply.write`, `rag.embed` */
  where?: string;
  status?: number;
  stepId?: string;
  /** Defaults by category when absent. */
  retryable?: boolean;
  at?: number;
}

interface ErrorShape {
  name?: unknown;
  code?: unknown;
  kind?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
}

function shapeOf(error: unknown): ErrorShape {
  return error && typeof error === "object" ? (error as ErrorShape) : {};
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  const shape = shapeOf(error);
  if (typeof shape.message === "string" && shape.message) return shape.message;
  return String(error);
}

function statusOf(error: unknown, context: AiErrorContext): number | undefined {
  if (typeof context.status === "number") return context.status;
  const shape = shapeOf(error);
  if (typeof shape.status === "number") return shape.status;
  if (typeof shape.statusCode === "number") return shape.statusCode;
  const match = /\b(4\d\d|5\d\d)\b/.exec(messageOf(error));
  return match ? Number(match[1]) : undefined;
}

function withWhere(message: string, where: string | undefined): string {
  return where ? `${where}：${message}` : message;
}

/** A record for an HTTP status that arrived without an Error object. */
export function errorFromStatus(status: number, body: string, context: AiErrorContext = {}): AiRunError {
  return classifyError({ status, message: body }, { ...context, status: context.status ?? status });
}

/**
 * Turn anything thrown into the one record shape the log stores.
 *
 * The wording deliberately mirrors the existing `httpFailureMessage` text: the
 * trace must not become a second, differently-phrased explanation of the same
 * failure.
 */
export function classifyError(error: unknown, context: AiErrorContext = {}): AiRunError {
  const at = context.at ?? Date.now();
  const shape = shapeOf(error);
  const message = messageOf(error);
  const status = statusOf(error, context);
  const code = typeof shape.code === "string" ? shape.code : "";
  const kind = typeof shape.kind === "string" ? shape.kind : "";
  const name = typeof shape.name === "string" ? shape.name : "";
  const where = context.where;

  const build = (
    record: Omit<AiRunError, "at" | "technical"> & { technical?: string },
  ): AiRunError => ({
    ...record,
    at,
    ...(status !== undefined ? { status } : {}),
    technical: `${withWhere(message, where)}${status !== undefined ? `（HTTP ${status}）` : ""}${record.technical ? ` ${record.technical}` : ""}`,
    ...(context.stepId ? { stepId: context.stepId } : {}),
  });

  // Transport codes first: they are the most specific.
  if (code === "aborted" || name === "AbortError") {
    return build({
      code: "AI_ABORT",
      category: "network",
      severity: "warning",
      userMessage: "请求已取消。",
      retryable: false,
    });
  }
  if (code === "timeout") {
    return build({
      code: "AI_TIMEOUT",
      category: "network",
      severity: "error",
      userMessage: "等待模型响应超时。可以重试，或到设置里把超时调长。",
      hint: "检查网络或本机服务是否在运行；重试通常有效。",
      retryable: context.retryable ?? true,
    });
  }
  if (code === "invalid-url" || code === "unsupported-protocol") {
    return build({
      code: "AI_CONFIG_ENDPOINT",
      category: "config",
      severity: "error",
      userMessage: "端点地址不可用。到 AI Host 设置里检查服务商与地址。",
      hint: "地址写到服务商根或 /v1 为止，不要带 /chat/completions。",
      retryable: false,
    });
  }
  if (code === "network") {
    return build({
      code: "AI_NETWORK",
      category: "network",
      severity: "error",
      userMessage: "连接模型服务失败。检查网络，或本机服务是否已启动。",
      hint: "本机服务用 127.0.0.1；服务没起来时任何重试都不会成功。",
      retryable: context.retryable ?? true,
    });
  }

  // Adapter shape problems.
  if (kind === "invalid-json" || kind === "shape") {
    return build({
      code: "AI_PARSE",
      category: "parse",
      severity: "error",
      userMessage: "模型回复的格式无法解析。可以重试；连续失败请换一个更稳定的模型。",
      hint: "轨迹里的原始回复能看出是截断、跑题还是围栏格式。",
      retryable: context.retryable ?? true,
    });
  }
  if (kind === "provider-error") {
    return build({
      code: status ? `AI_PROVIDER_${status}` : "AI_PROVIDER",
      category: "provider",
      severity: "error",
      userMessage: "服务商返回了错误。详情见轨迹中的原始信息。",
      hint: "额度、模型名、内容审核都可能走这个错误。",
      retryable: context.retryable ?? (status === 429 || (status ?? 0) >= 500),
    });
  }

  // HTTP status, whether it arrived as an Error or as a response.
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return build({
        code: "AI_AUTH_401",
        category: "auth",
        severity: "error",
        userMessage: "API Key 被拒绝了。到 AI Host 设置里检查 Key 是否属于当前服务商。",
        hint: "换过服务商后忘了换 Key 是最常见的原因。",
        retryable: false,
      });
    }
    if (status === 404) {
      return build({
        code: "AI_ENDPOINT_404",
        category: "config",
        severity: "error",
        userMessage: "端点没有这个路径（404）。地址应写到服务商根或 /v1 为止。",
        retryable: false,
      });
    }
    if (status === 405) {
      return build({
        code: "AI_ENDPOINT_405",
        category: "config",
        severity: "error",
        userMessage: "这个地址不接受这种请求（405）。检查服务商协议与地址是否匹配。",
        retryable: false,
      });
    }
    if (status === 413) {
      return build({
        code: "AI_PAYLOAD_413",
        category: "provider",
        severity: "error",
        userMessage: "请求体太大（413）。减少图片张数或缩短上下文。",
        retryable: false,
      });
    }
    if (status === 429) {
      return build({
        code: "AI_RATE_LIMIT",
        category: "rate_limit",
        severity: "warning",
        userMessage: "触发限流或额度用尽（429）。稍后重试。",
        retryable: context.retryable ?? true,
      });
    }
    if (status >= 500) {
      return build({
        code: `AI_PROVIDER_${status}`,
        category: "provider",
        severity: "error",
        userMessage: `服务端错误（${status}）。服务可能没起来或模型没加载。`,
        retryable: context.retryable ?? true,
      });
    }
    return build({
      code: `AI_HTTP_${status}`,
      category: "provider",
      severity: "error",
      userMessage: `请求失败（${status}）。`,
      retryable: context.retryable ?? false,
    });
  }

  return build({
    code: "AI_INTERNAL",
    category: "internal",
    severity: "error",
    userMessage: "AI 运行失败。轨迹里有技术细节。",
    hint: "如果是第一次出现，重试一次；持续出现请导出诊断。",
    retryable: context.retryable ?? false,
  });
}

/** Stable key for merging repeats within a short window. */
export function errorDedupKey(error: AiRunError): string {
  return `${error.code}|${error.userMessage.slice(0, 80)}`;
}

/** One copyable line for the error block. */
export function formatRunError(error: AiRunError): string {
  return [
    `[${error.code}] ${error.userMessage}`,
    error.hint ? `提示：${error.hint}` : "",
    `技术：${error.technical}`,
    error.retryable ? "可重试" : "不可重试",
  ]
    .filter(Boolean)
    .join("\n");
}