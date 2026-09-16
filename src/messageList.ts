/**
 * The conversation transcript: bubbles, hover actions, and the one live bubble.
 *
 * Retraction is a *display* state, not a deletion: a retracted message stays in
 * the DOM (greyed, with 恢复) so "I hid that from the model" is visible and
 * reversible. The context builder in the SDK skips it; this file only shows it.
 */

import { textOf, type AiChatMessage } from "../sdk/src/ai/aiChat";
import type { AiToolCallState } from "../sdk/src/ai/aiTools";
import { formatRunError, type AiRunError } from "../sdk/src/ai/aiErrors";

export interface MessageActions {
  onRetract(id: string): void;
  onRestore(id: string): void;
  onEdit(id: string): void;
  onRegenerate(id: string): void;
  onDelete(id: string): void;
  onApply(): void;
  onCopy(text: string): void;
  onTrace(runId: string): void;
}

export class MessageList {
  private readonly root: HTMLElement;
  private streamBody: HTMLElement | null = null;
  private streamMeta: HTMLElement | null = null;
  private streamCard: HTMLElement | null = null;

  constructor(container: HTMLElement, private readonly actions: MessageActions) {
    this.root = container.createDiv({ cls: "sfc-ai-messages" });
  }

  empty(): void {
    this.root.empty();
    this.streamBody = null;
    this.streamMeta = null;
    this.streamCard = null;
  }

  /** The empty conversation: a hero with three concrete entry points. */
  renderHero(onExample: (text: string) => void): void {
    this.empty();
    const hero = this.root.createDiv({ cls: "sfc-ai-hero" });
    hero.createDiv({ cls: "sfc-ai-hero-title", text: "在 Obsidian 里干活" });
    hero.createDiv({
      cls: "sfc-ai-hero-sub",
      text: "引用笔记提问、让模型整理草稿，或开启 Agent 在工作区里多步读写。",
    });
    const examples = [
      "总结我选中的这篇笔记，给出三条要点",
      "在工作区里找出所有提到「复盘」的笔记，列一个清单",
      "把今天的任务整理成一份周计划草稿",
    ];
    const list = hero.createDiv({ cls: "sfc-ai-hero-examples" });
    for (const example of examples) {
      const item = list.createEl("button", { cls: "sfc-ai-hero-example", text: example });
      item.onclick = () => onExample(example);
    }
  }

  render(messages: readonly AiChatMessage[]): void {
    this.empty();
    const visible = messages.filter((message) => message.role !== "system");
    if (!visible.length) {
      this.renderHero(() => undefined);
      return;
    }
    visible.forEach((message, index) => this.renderMessage(message, index));
    this.scrollToBottom();
  }

  private renderMessage(message: AiChatMessage, index: number): void {
    const id = message.id ?? `legacy-${index}`;
    const status = message.status ?? "active";
    const card = this.root.createDiv({ cls: "sfc-ai-msg" });
    card.addClass(message.role === "user" ? "sfc-ai-msg-user" : message.role === "tool" ? "sfc-ai-msg-tool" : "sfc-ai-msg-assistant");
    if (status === "retracted") card.addClass("sfc-ai-msg-retracted");
    if (status === "superseded") card.addClass("sfc-ai-msg-superseded");
    card.dataset.messageId = id;

    const role = card.createDiv({ cls: "sfc-ai-msg-role" });
    role.createSpan({ text: roleLabel(message) });
    if (status === "retracted") role.createSpan({ cls: "sfc-ai-msg-badge", text: "已撤回" });
    if (status === "superseded") role.createSpan({ cls: "sfc-ai-msg-badge", text: "已被后续编辑取代" });
    if (message.editedAt) role.createSpan({ cls: "sfc-ai-msg-badge", text: "已编辑" });

    if (message.mentionables?.length) {
      const mentions = card.createDiv({ cls: "sfc-ai-msg-mentions" });
      for (const mention of message.mentionables) mentions.createSpan({ cls: "sfc-ai-msg-mention", text: `@${mention.path ?? mention.type}` });
    }
    if (message.reasoning) {
      const details = card.createEl("details", { cls: "sfc-ai-reasoning" });
      details.createEl("summary", { text: "推理过程" });
      details.createDiv({ cls: "sfc-ai-reasoning-body", text: message.reasoning });
    }

    const text = textOf(message.content);
    if (message.role === "tool") {
      const details = card.createEl("details", { cls: "sfc-ai-tool-inline" });
      details.createEl("summary", { text: `${message.name ?? "工具"} 的结果（${text.length} 字）` });
      details.createEl("pre", { cls: "sfc-ai-tool-result", text: text.slice(0, 4000) });
    } else {
      card.createDiv({ cls: "sfc-ai-msg-body", text: text || (message.toolCalls?.length ? "（请求使用工具）" : "") });
    }

    const actions = card.createDiv({ cls: "sfc-ai-msg-actions" });
    if (status === "retracted") {
      this.actionButton(actions, "恢复", () => this.actions.onRestore(id));
    } else if (message.role === "user") {
      this.actionButton(actions, "编辑并重跑", () => this.actions.onEdit(id));
      this.actionButton(actions, "撤回", () => this.actions.onRetract(id));
    } else if (message.role === "assistant") {
      this.actionButton(actions, "重新生成", () => this.actions.onRegenerate(id));
      this.actionButton(actions, "复制", () => this.actions.onCopy(text));
      this.actionButton(actions, "撤回", () => this.actions.onRetract(id));
    }
    if (message.role !== "tool" && status !== "retracted") {
      this.actionButton(actions, "删除", () => this.actions.onDelete(id));
    }
  }

  /** The live bubble: created before the first token, filled by the stream. */
  appendStreaming(): { card: HTMLElement; body: HTMLElement; meta: HTMLElement } {
    const card = this.root.createDiv({ cls: "sfc-ai-msg sfc-ai-msg-assistant" });
    card.createDiv({ cls: "sfc-ai-msg-role", text: "助手" });
    const body = card.createDiv({ cls: "sfc-ai-msg-body" });
    const meta = card.createDiv({ cls: "sfc-ai-msg-meta", text: "生成中" });
    this.streamCard = card;
    this.streamBody = body;
    this.streamMeta = meta;
    this.scrollToBottom();
    return { card, body, meta };
  }

  setStreamText(text: string): void {
    this.streamBody?.setText(text);
    this.scrollToBottom();
  }

  setStreamMeta(text: string): void {
    this.streamMeta?.setText(text);
  }

  /** Finish the live bubble; returns it so an Apply/Trace button can be attached. */
  finishStream(error?: AiRunError): HTMLElement | null {
    const card = this.streamCard;
    this.streamBody = null;
    this.streamMeta = null;
    this.streamCard = null;
    if (!card) return null;
    if (error) {
      card.addClass("sfc-ai-msg-error");
      card.createDiv({ cls: "sfc-ai-msg-error-text", text: formatRunError(error) });
    }
    return card;
  }

  /** A tool call awaiting the user's answer, rendered inline in the transcript. */
  addToolState(state: AiToolCallState, handlers: { allow(): void; allowRun(): void; reject(): void }): void {
    const card = this.root.createDiv({ cls: "sfc-ai-tool" });
    card.createDiv({ cls: "sfc-ai-tool-head", text: `${state.call.name}  等待确认` });
    card.createEl("pre", { cls: "sfc-ai-tool-args", text: state.call.arguments ?? "{}" });
    const actions = card.createDiv({ cls: "sfc-ai-tool-actions" });
    const run = actions.createEl("button", { cls: "mod-cta", text: "运行一次" });
    run.onclick = () => handlers.allow();
    const allow = actions.createEl("button", { text: "本次运行都允许" });
    allow.onclick = () => handlers.allowRun();
    const reject = actions.createEl("button", { text: "拒绝" });
    reject.onclick = () => handlers.reject();
    this.scrollToBottom();
  }

  scrollToBottom(): void {
    this.root.scrollTop = this.root.scrollHeight;
  }

  private actionButton(parent: HTMLElement, label: string, run: () => void): void {
    const button = parent.createEl("button", { cls: "sfc-ai-ghost", text: label });
    button.onclick = (event) => {
      event.stopPropagation();
      run();
    };
  }
}

function roleLabel(message: AiChatMessage): string {
  if (message.role === "user") return "你";
  if (message.role === "tool") return "工具";
  return "助手";
}