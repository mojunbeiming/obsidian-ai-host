/**
 * The diagnostics report: enough to debug, nothing to leak.
 *
 * Every field here is either a version, a state label, or a hostname. Never a
 * key, never a full URL (a base URL may carry `?token=`), never a note body.
 * `redactSecrets` is applied to free text because error messages from a gateway
 * sometimes echo the request -- including the credential -- back in the body.
 */

import type { AiSettings } from "../sdk/src/ai/aiSettingsSchema";

export interface AiDiagnosticsProvider {
  id: string;
  label: string;
  protocol: string;
  /** Already reduced to a hostname by the caller. */
  host: string;
  model: string;
  local: boolean;
  secretOrigin: "keychain" | "legacy" | "none";
}

export interface AiDiagnosticsInput {
  hostVersion: string;
  appVersion?: string;
  settings: AiSettings;
  providers: AiDiagnosticsProvider[];
  conversations?: number;
  indexRebuilt?: boolean;
  /** Recent run summaries, one line each; already redacted by the run store. */
  runLines?: string[];
  warnings?: string[];
  generatedAt?: string;
}

/**
 * Remove anything that looks like a credential from free text.
 *
 * Deliberately shape-based rather than exact: the values being defended against
 * are ones that arrive in provider error bodies, so there is no list to read
 * from. The three patterns cover the API-key prefixes users actually have, a
 * bearer header, and a `token=`/`key=` parameter anywhere it is not part of a longer word.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|xai|pk|api)[-_][A-Za-z0-9_-]{6,}\b/gi, "$1-***")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
    .replace(/(^|[^A-Za-z0-9_-])((?:token|key|api_key|apikey|access_token)=)[^&\s]+/gi, "$1$2***");
}

/** Build a Markdown report. The caller decides where to write or copy it. */
export function buildDiagnosticsReport(input: AiDiagnosticsInput): string {
  const lines: string[] = [];
  lines.push("# AI Host 诊断");
  lines.push("");
  lines.push(`- 生成时间：${input.generatedAt ?? new Date().toISOString()}`);
  lines.push(`- 宿主版本：${input.hostVersion}`);
  if (input.appVersion) lines.push(`- Obsidian：${input.appVersion}`);
  lines.push(`- 设置版本：${input.settings.version}`);
  lines.push("");
  lines.push("## 聊天");
  lines.push("");
  lines.push(`- 服务商：${input.settings.chat.providerId || "(默认)"}`);
  lines.push(`- 模型：${input.settings.chat.model || "(服务商默认)"}`);
  lines.push(`- 流式：${input.settings.chat.stream ? "开" : "关"}`);
  lines.push(`- 上下文条数：${input.settings.chat.maxContextMessages}`);
  lines.push("");
  lines.push("## 服务商");
  lines.push("");
  lines.push("| id | 协议 | 主机 | 模型 | 密钥位置 |");
  lines.push("|---|---|---|---|---|");
  for (const provider of input.providers) {
    lines.push(
      `| ${provider.id} | ${provider.protocol} | ${provider.host} | ${provider.model || "-"} | ${secretLabel(provider.secretOrigin)} |`,
    );
  }
  lines.push("");
  lines.push("## 索引与数据");
  lines.push("");
  lines.push(`- RAG：${input.settings.rag.enabled ? "开" : "关"}`);
  lines.push(`- 会话数：${input.conversations ?? "?"}`);
  lines.push(`- 索引重建：${input.indexRebuilt ? "是" : "否/未执行"}`);
  if (input.runLines?.length) {
    lines.push("");
    lines.push("## 运行记录（最近）");
    lines.push("");
    for (const line of input.runLines) lines.push(`- ${redactSecrets(line)}`);
  }
  if (input.warnings?.length) {
    lines.push("");
    lines.push("## 警告");
    lines.push("");
    for (const warning of input.warnings) lines.push(`- ${redactSecrets(warning)}`);
  }
  lines.push("");
  lines.push("> 本报告不含 API Key、完整端点地址或笔记正文。");
  return lines.join("\n");
}

function secretLabel(origin: AiDiagnosticsProvider["secretOrigin"]): string {
  if (origin === "keychain") return "钥匙串";
  if (origin === "legacy") return "旧版明文（建议重存）";
  return "无";
}