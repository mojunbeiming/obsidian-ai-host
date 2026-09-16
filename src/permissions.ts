/**
 * The runtime permission gate: the last thing between a model's tool call and a
 * write.
 *
 * `decidePermission` in the SDK answers "what does this tier say"; this class
 * answers "may *this* call run right now" and owns the two pieces of state a
 * pure function cannot: the per-run allow-list (`allow-run` on the approval
 * banner) and the user question itself. Every tool call goes through
 * `authorize`, so there is no path around it -- a new tool cannot forget to ask,
 * only choose to ask for the wrong effect.
 *
 * The gate never decides the sandbox: a path outside the workspace is refused
 * before `authorize` is consulted, because "the user said yes" must not be able
 * to open a folder the workspace does not contain.
 */

import {
  decidePermission,
  formatPermissionRemaining,
  permissionDescription,
  permissionLabel,
  permissionRemainingMs,
  resolvePermission,
  type AiPermissionDecision,
  type AiPermissionPolicy,
  type AiPermissionTier,
  type AiToolEffect,
  type AiWorkspace,
} from "../sdk/src/ai/aiWorkspace";
import type { AiSettings } from "../sdk/src/ai/aiSettingsSchema";

export interface ApprovalRequest {
  /** The tool call id, so the answer can be matched after a restart. */
  callId: string;
  tool: string;
  effect: AiToolEffect;
  /** The path the call touches, when it has one, for the banner's text. */
  path?: string;
  /** One sentence the user can decide on. */
  summary: string;
}

export type ApprovalAnswer = "allow" | "allow-run" | "reject";

export type ApprovalHandler = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalAnswer>;

/** The policy half of settings, in the shape the SDK's decide function takes. */
export function permissionPolicyOf(settings: AiSettings): AiPermissionPolicy {
  return {
    globalMax: settings.permission.globalMax,
    confirmDestructiveInFull: settings.permission.confirmDestructiveInFull,
  };
}

/** What the workspace may do *right now*: expiry and the global ceiling applied. */
export function resolveWorkspacePermission(
  workspace: AiWorkspace,
  settings: AiSettings,
  now = Date.now(),
): { tier: AiPermissionTier; expired: boolean; capped: boolean } {
  return resolvePermission(
    { permission: workspace.permission, permissionExpiresAt: workspace.permissionExpiresAt },
    { now, policy: permissionPolicyOf(settings) },
  );
}

export interface PermissionBanner {
  text: string;
  tone: "normal" | "danger";
  remainingMs: number;
}

/** The composer banner's content: empty for the two lower tiers. */
export function permissionBanner(
  workspace: AiWorkspace,
  settings: AiSettings,
  now = Date.now(),
): PermissionBanner | null {
  const resolved = resolveWorkspacePermission(workspace, settings, now);
  const remaining = permissionRemainingMs(
    { permission: workspace.permission, permissionExpiresAt: workspace.permissionExpiresAt },
    now,
  );
  if (resolved.tier === "full") {
    return {
      tone: "danger",
      remainingMs: remaining,
      text: remaining > 0
        ? `完全权限已开启：写入不再逐个确认，删除仍需确认；${formatPermissionRemaining(remaining)} 后自动降级。`
        : "完全权限已开启：写入不再逐个确认，删除仍需确认。",
    };
  }
  if (resolved.tier === "trusted") {
    return {
      tone: remaining > 0 ? "normal" : "danger",
      remainingMs: remaining,
      text: remaining > 0
        ? `受信权限：读写自动执行，删除仍需确认；${formatPermissionRemaining(remaining)} 后自动降级。`
        : "受信权限：读写自动执行，删除仍需确认。",
    };
  }
  if (resolved.expired) {
    return { tone: "normal", remainingMs: 0, text: `授权已过期，已自动降回${permissionLabel(resolved.tier)}。` };
  }
  if (resolved.capped) {
    return { tone: "normal", remainingMs: 0, text: `设置里的权限上限把工作区限制为${permissionLabel(resolved.tier)}。` };
  }
  return null;
}

/** Tier options, with an explanation, for the composer's picker. */
export function permissionChoices(settings: AiSettings): { tier: AiPermissionTier; label: string; description: string }[] {
  return (["manual", "standard", "trusted", "full"] as const).map((tier) => ({
    tier,
    label: permissionLabel(tier),
    description:
      tier === "full" && settings.permission.globalMax !== "full"
        ? `${permissionDescription(tier)}（当前被全局上限限制为${permissionLabel(settings.permission.globalMax)}）`
        : permissionDescription(tier),
  }));
}

export class PermissionGate {
  /** Tools allowed for the rest of this run by an `allow-run` answer. */
  private readonly runAllowed = new Set<string>();
  /** Calls answered by the user, so a resumed run does not ask twice. */
  private readonly answered = new Map<string, ApprovalAnswer>();

  constructor(
    private readonly getSettings: () => AiSettings,
    private approve?: ApprovalHandler,
  ) {}

  /** The runtime registers itself here; the gate never imports the runtime. */
  setApprover(handler: ApprovalHandler): void {
    this.approve = handler;
  }

  /** The tier in force right now, for callers that only need the label. */
  resolveTier(workspace: AiWorkspace): AiPermissionTier {
    return resolveWorkspacePermission(workspace, this.getSettings()).tier;
  }

  decide(workspace: AiWorkspace, effect: AiToolEffect): AiPermissionDecision {
    const resolved = resolveWorkspacePermission(workspace, this.getSettings());
    return decidePermission(resolved.tier, effect, permissionPolicyOf(this.getSettings()));
  }

  /**
   * Ask for one call.
   *
   * `reason` is set when the answer is no, so the caller can write a tool
   * message the model can react to instead of an empty failure.
   */
  async authorize(
    workspace: AiWorkspace,
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; answer?: ApprovalAnswer; reason?: string }> {
    const decision = this.decide(workspace, request.effect);
    if (decision === "allow" || this.runAllowed.has(request.tool)) return { allowed: true };
    if (decision === "deny") return { allowed: false, reason: "当前权限档位禁止这个操作。" };
    if (!this.approve) return { allowed: false, reason: "没有可用的审批界面，操作已拒绝。" };

    const remembered = this.answered.get(request.callId);
    const answer = remembered ?? (await this.approve(request, signal));
    this.answered.set(request.callId, answer);
    if (answer === "allow-run") this.runAllowed.add(request.tool);
    if (answer === "reject") return { allowed: false, answer, reason: "用户拒绝了这个操作。" };
    return { allowed: true, answer };
  }

  /** A resumed run can carry an answer that was given before the restart. */
  remember(callId: string, answer: ApprovalAnswer): void {
    this.answered.set(callId, answer);
    if (answer === "allow-run") this.runAllowed.add(callId);
  }
}