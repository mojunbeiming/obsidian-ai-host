/**
 * The composer: chips, textarea, permission/model pickers, budget line.
 *
 * The Enter decision lives here because it is the one setting a user notices
 * immediately: `Enter 发送` is the default, `Shift+Enter` inserts a newline, and
 * the switch swaps them. The picker (`@`/`/`) is owned by the pane and gets the
 * keydown first, so Enter chooses the highlighted suggestion instead of sending
 * half a mention -- the bug the plan calls out by name.
 */

import { setIcon } from "obsidian";
import type { AiMention } from "../sdk/src/ai/aiChat";
import { mentionKey, mentionLabel } from "../sdk/src/ai/aiChat";
import type { AiPermissionTier } from "../sdk/src/ai/aiWorkspace";
import type { PermissionBanner } from "./permissions";

export interface ComposerCallbacks {
  onSend(): void;
  onStop(): void;
  onPermission(tier: AiPermissionTier): void;
  onProvider(value: string): void;
  onToggle(kind: "current-file" | "rag" | "agent"): void;
  onRemoveMention(mention: AiMention): void;
  onTemplate(): void;
  /** Returns true when the pane consumed the key (picker navigation, Escape). */
  onKeydown(event: KeyboardEvent): boolean;
}

export interface ComposerState {
  mentions: AiMention[];
  includeCurrentFile: boolean;
  useVaultSearch: boolean;
  agentMode: boolean;
  permission: AiPermissionTier;
  permissionHint: string;
  providerValue: string;
  providers: { value: string; label: string }[];
  busy: boolean;
  stats: string;
  banner: PermissionBanner | null;
  sendOnEnter: boolean;
}

export class Composer {
  readonly inputEl: HTMLTextAreaElement;
  private readonly chipsEl: HTMLElement;
  private readonly currentFileEl: HTMLButtonElement;
  private readonly ragEl: HTMLButtonElement;
  private readonly agentEl: HTMLButtonElement;
  private readonly permissionEl: HTMLSelectElement;
  private readonly providerEl: HTMLSelectElement;
  private readonly statsEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly sendEl: HTMLButtonElement;
  private readonly stopEl: HTMLButtonElement;
  private sendOnEnter = true;
  private busy = false;
  private canSend = true;

  constructor(container: HTMLElement, private readonly callbacks: ComposerCallbacks) {
    const root = container.createDiv({ cls: "sfc-ai-composer" });

    this.chipsEl = root.createDiv({ cls: "sfc-ai-chips" });
    const toggles = root.createDiv({ cls: "sfc-ai-toggles" });
    this.currentFileEl = toggles.createEl("button", { cls: "sfc-ai-toggle", text: "当前文件" });
    this.currentFileEl.onclick = () => this.callbacks.onToggle("current-file");
    this.ragEl = toggles.createEl("button", { cls: "sfc-ai-toggle", text: "库检索" });
    this.ragEl.onclick = () => this.callbacks.onToggle("rag");
    this.agentEl = toggles.createEl("button", { cls: "sfc-ai-toggle", text: "Agent" });
    this.agentEl.onclick = () => this.callbacks.onToggle("agent");

    const row = root.createDiv({ cls: "sfc-ai-input-row" });
    this.inputEl = row.createEl("textarea", {
      cls: "sfc-ai-input",
      placeholder: "Enter 发送  Shift+Enter 换行  @ 引用笔记  / 插入模板",
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (this.callbacks.onKeydown(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.callbacks.onStop();
        return;
      }
      if (event.key !== "Enter" || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const wantsSend = this.sendOnEnter ? !event.shiftKey : event.shiftKey;
      if (!wantsSend) return;
      event.preventDefault();
      this.callbacks.onSend();
    });

    const actions = root.createDiv({ cls: "sfc-ai-composer-actions" });
    const templates = actions.createEl("button", { cls: "sfc-ai-ghost sfc-ai-plus" });
    templates.setAttr("aria-label", "插入模板或图片");
    templates.setAttr("title", "插入模板或图片");
    setIcon(templates, "plus");
    templates.onclick = () => this.callbacks.onTemplate();
    this.permissionEl = actions.createEl("select", { cls: "dropdown sfc-ai-permission" });
    for (const tier of ["manual", "standard", "trusted", "full"] as const) {
      this.permissionEl.createEl("option", { value: tier, text: tier });
    }
    this.permissionEl.onchange = () => this.callbacks.onPermission(this.permissionEl.value as AiPermissionTier);
    this.providerEl = actions.createEl("select", { cls: "dropdown sfc-ai-provider" });
    this.providerEl.onchange = () => this.callbacks.onProvider(this.providerEl.value);
    this.sendEl = actions.createEl("button", { cls: "sfc-ai-send mod-cta", text: "发送" });
    this.sendEl.onclick = () => this.callbacks.onSend();
    this.stopEl = actions.createEl("button", { cls: "sfc-ai-stop", text: "停止" });
    this.stopEl.onclick = () => this.callbacks.onStop();

    this.bannerEl = root.createDiv({ cls: "sfc-ai-banner" });
    this.statsEl = root.createDiv({ cls: "sfc-ai-stats" });
  }

  /** Update everything except the textarea's value, so typing is never interrupted. */
  update(state: ComposerState): void {
    this.sendOnEnter = state.sendOnEnter;
    this.inputEl.setAttr("placeholder", state.sendOnEnter ? "Enter 发送  Shift+Enter 换行  @ 引用笔记  / 插入模板" : "Shift+Enter 发送  Enter 换行  @ 引用笔记  / 插入模板");
    this.chipsEl.empty();
    for (const mention of state.mentions) {
      const chip = this.chipsEl.createDiv({ cls: "sfc-ai-chip" });
      chip.createSpan({ text: mentionLabel(mention) });
      const remove = chip.createEl("button", { cls: "sfc-ai-chip-x" });
      remove.setAttr("aria-label", `移除 ${mentionLabel(mention)}`);
      remove.setAttr("title", `移除 ${mentionLabel(mention)}`);
      setIcon(remove, "x");
      remove.onclick = () => this.callbacks.onRemoveMention(mention);
      void mentionKey;
    }
    this.currentFileEl.toggleClass("sfc-ai-toggle-on", state.includeCurrentFile);
    this.ragEl.toggleClass("sfc-ai-toggle-on", state.useVaultSearch);
    this.agentEl.toggleClass("sfc-ai-toggle-on", state.agentMode);
    this.agentEl.setAttr("title", state.agentMode ? "Agent 模式：多步执行，受预算与权限约束" : "聊天模式");
    this.permissionEl.value = state.permission;
    this.permissionEl.title = state.permissionHint;
    for (const tier of Array.from(this.permissionEl.options)) {
      tier.text = `${permissionOptionLabel(tier.value as AiPermissionTier)}${tier.value === "full" ? " " : ""}`;
    }
    this.providerEl.empty();
    for (const provider of state.providers) this.providerEl.createEl("option", { value: provider.value, text: provider.label });
    if (state.providers.some((provider) => provider.value === state.providerValue)) this.providerEl.value = state.providerValue;

    this.bannerEl.setText(state.banner?.text ?? "");
    this.bannerEl.toggleClass("sfc-ai-banner-danger", state.banner?.tone === "danger");
    this.bannerEl.toggleClass("sfc-ai-banner-visible", Boolean(state.banner?.text));
    this.statsEl.setText(state.stats);
    this.setBusy(state.busy);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.stopEl.disabled = !busy;
    this.sendEl.setText(busy ? "生成中" : "发送");
    this.inputEl.toggleClass("sfc-ai-input-busy", busy);
    this.applySendState();
  }

  /** The text, with only a trailing trim: interior newlines are the user's. */
  value(): string {
    return this.inputEl.value;
  }

  clear(): void {
    this.inputEl.value = "";
  }

  focus(): void {
    this.inputEl.focus();
  }

  /** Replace a range; used by the template picker to consume the `/query`. */
  replaceRange(from: number, to: number, text: string): void {
    const value = this.inputEl.value;
    this.inputEl.value = `${value.slice(0, from)}${text}${value.slice(to)}`;
    const caret = from + text.length;
    this.inputEl.selectionStart = caret;
    this.inputEl.selectionEnd = caret;
    this.inputEl.focus();
  }

  caret(): number {
    return this.inputEl.selectionStart ?? this.inputEl.value.length;
  }

  /** The empty-state arrow: a disabled send button must actually be disabled. */
  setSendEnabled(enabled: boolean): void {
    this.canSend = enabled;
    this.applySendState();
  }

  private applySendState(): void {
    this.sendEl.disabled = this.busy || !this.canSend;
    this.sendEl.toggleClass("sfc-ai-send-disabled", !this.busy && !this.canSend);
  }
}

function permissionOptionLabel(tier: AiPermissionTier): string {
  switch (tier) {
    case "manual":
      return "手动";
    case "standard":
      return "标准";
    case "trusted":
      return "受信";
    case "full":
      return "完全权限";
  }
}