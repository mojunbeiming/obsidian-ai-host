/**
 * The apply dialog: per-block Accept Incoming / Current / Both, then one write.
 *
 * Nothing touches the vault until the footer button is pressed, and the write
 * itself goes through the host's backup path so a wrong acceptance is one
 * command away from undone.
 */

import { App, Modal, Notice } from "obsidian";
import type { AiApplySession } from "../sdk/src/ai/aiApply";
import { applyDiffBlocks } from "../sdk/src/ai/aiDiff";
import type { AiDiffBlock } from "../sdk/src/ai/aiDiff";

type Choice = "incoming" | "current" | "both";

export interface ApplyModalHost {
  onAccept(content: string): Promise<void>;
}

export class ApplyDiffModal extends Modal {
  private readonly choices = new Map<number, Choice>();

  constructor(app: App, private readonly session: AiApplySession, private readonly host: ApplyModalHost) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sfc-ai-diff");
    contentEl.createEl("h3", { text: `AI 修改：${this.session.file}` });
    contentEl.createDiv({
      cls: "sfc-ai-diff-head",
      text: this.session.coarse
        ? "文件较大，按整份文件处理：只能全部接受或取消。"
        : `共 ${this.session.blocks.filter((block) => block.type === "modified").length} 处修改，逐块选择后点「应用」。`,
    });

    let changedIndex = 0;
    this.session.blocks.forEach((block, index) => {
      if (block.type === "unchanged") return;
      changedIndex += 1;
      this.choices.set(index, "incoming");
      this.renderBlock(contentEl, block, index, changedIndex);
    });

    const actions = contentEl.createDiv({ cls: "sfc-ai-diff-actions" });
    const apply = actions.createEl("button", { cls: "mod-cta", text: "应用" });
    apply.addEventListener("click", () => {
      void this.accept();
    });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderBlock(container: HTMLElement, block: AiDiffBlock, index: number, ordinal: number): void {
    if (block.type !== "modified") return;
    const card = container.createDiv({ cls: "sfc-ai-diff-block" });
    card.createDiv({ cls: "sfc-ai-diff-title", text: `#${ordinal}` });
    if (block.originalValue !== undefined) {
      card.createEl("pre", { cls: "sfc-ai-diff-original", text: block.originalValue });
    }
    if (block.modifiedValue !== undefined) {
      card.createEl("pre", { cls: "sfc-ai-diff-incoming", text: block.modifiedValue });
    }
    const actions = card.createDiv({ cls: "sfc-ai-diff-actions" });
    const options: { choice: Choice; label: string }[] = [
      { choice: "incoming", label: "用新内容" },
      { choice: "current", label: "保留原文" },
      { choice: "both", label: "两者都要" },
    ];
    const buttons: { button: HTMLButtonElement; choice: Choice }[] = [];
    for (const option of options) {
      const button = actions.createEl("button", { text: option.label });
      button.addEventListener("click", () => {
        this.choices.set(index, option.choice);
        for (const entry of buttons) entry.button.toggleClass("sfc-ai-diff-chosen", entry.choice === option.choice);
      });
      buttons.push({ button, choice: option.choice });
    }
    buttons[0].button.addClass("sfc-ai-diff-chosen");
  }

  private async accept(): Promise<void> {
    const content = applyDiffBlocks(this.session.originalContent, this.session.blocks, (block, index) => {
      if (block.type !== "modified") return "current";
      return this.choices.get(index) ?? "incoming";
    });
    try {
      await this.host.onAccept(content);
      new Notice(`已写入 ${this.session.file}，可用「撤销上次 AI 写入」恢复。`);
      this.close();
    } catch (error) {
      new Notice(`写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}