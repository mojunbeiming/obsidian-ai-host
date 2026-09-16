/**
 * Text prompts, confirmations and small choosers, in Obsidian's own modals.
 *
 * ## Why this exists at all
 *
 * `window.prompt` does not exist in Obsidian's Electron renderer (Chromium
 * removed it there), and mobile WebViews are not obliged to implement it either.
 * The failure mode is the worst one for a UI bug: the call **throws**, the
 * handler rejects, and nothing happens at all -- a button that looks alive and
 * does nothing. That is how "complete this checkpoint" was reported: the
 * checkbox was wired correctly and the quality prompt underneath it was not.
 *
 * `confirm` is not portable either, and it cannot carry the warning styling a
 * destructive action needs, so it goes through the same modals.
 *
 * This lived in `sfc-ai` first, which meant `sfc-todo` and `sfc-flashcards`
 * could not use it and kept calling `window.prompt`. It is in the SDK now
 * because all three plugins ship together and must look the same while doing it.
 *
 * Every helper resolves exactly once: cancelling, pressing Escape, clicking the
 * backdrop and confirming all close the same promise, so a caller cannot hang
 * on a dismissed modal.
 *
 * ## Styling
 *
 * The classes used here -- `sfc-modal-actions`, `sfc-modal-message`,
 * `sfc-modal-choices`, `sfc-modal-choice-index` -- are declared in every
 * plugin's shared design-system block, because every plugin renders these
 * modals. A name that only one stylesheet declares is a name that renders
 * unstyled the moment a second plugin calls it.
 */

import { App, Modal, Setting } from "obsidian";

/** The one way a text prompt ends. */
export interface PromptOptions {
  title: string;
  value?: string;
  placeholder?: string;
  cta?: string;
  /** A larger box for message editing; a single line for names. */
  multiline?: boolean;
  /** Reject an empty submission (a rename to "" is never intended). */
  requireValue?: boolean;
}

export function promptText(app: App, options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText(options.title);
    let value = options.value ?? "";
    const requireValue = options.requireValue !== false;
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
      modal.close();
    };
    modal.onClose = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };

    new Setting(modal.contentEl).addTextArea((text) => {
      text.setValue(value).setPlaceholder(options.placeholder ?? "");
      text.inputEl.rows = options.multiline === false ? 1 : 4;
      text.onChange((next) => {
        value = next;
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          const trimmed = value.trim();
          if (!trimmed && requireValue) return;
          finish(requireValue ? trimmed : value);
        }
        if (event.key === "Escape") finish(null);
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    const actions = modal.contentEl.createDiv({ cls: "sfc-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.onclick = () => finish(null);
    const submit = actions.createEl("button", {
      cls: "mod-cta",
      text: options.cta ?? "确定",
      attr: { type: "button" },
    });
    submit.onclick = () => {
      const trimmed = value.trim();
      if (!trimmed && requireValue) return;
      finish(requireValue ? trimmed : value);
    };
    modal.open();
  });
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  cta?: string;
  /** Destructive actions get the warning colour, not the accent colour. */
  warning?: boolean;
  cancelLabel?: string;
}

export function confirmAction(app: App, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText(options.title);
    if (options.message) modal.contentEl.createEl("p", { cls: "sfc-modal-message", text: options.message });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(result);
      modal.close();
    };
    modal.onClose = () => {
      if (settled) return;
      settled = true;
      resolve(false);
    };
    const actions = modal.contentEl.createDiv({ cls: "sfc-modal-actions" });
    const cancel = actions.createEl("button", { text: options.cancelLabel ?? "取消", attr: { type: "button" } });
    cancel.onclick = () => finish(false);
    const submit = actions.createEl("button", {
      cls: options.warning ? "mod-warning" : "mod-cta",
      text: options.cta ?? "确定",
      attr: { type: "button" },
    });
    submit.onclick = () => finish(true);
    modal.open();
  });
}

export interface ChooseOption<T extends string> {
  value: T;
  label: string;
  /** One line after the label, for the option whose meaning is not obvious. */
  hint?: string;
}

export interface ChooseOptions<T extends string> {
  title: string;
  message?: string;
  options: readonly ChooseOption<T>[];
  /** Escape, the backdrop and this button all mean "no answer". */
  cancelLabel?: string;
}

/**
 * A short list of buttons, for the questions a text prompt was the wrong shape
 * for.
 *
 * A checkpoint's completion quality is three words and "skip": asking for it in
 * a text box meant reading the accepted spellings off the prompt and typing one
 * of them, and a typo silently recorded nothing. Number keys pick an option,
 * because the hand is already on the keyboard.
 *
 * Resolves `null` when the question was dismissed -- which callers must treat as
 * "leave everything alone", never as "the first option".
 */
export function chooseOption<T extends string>(app: App, options: ChooseOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText(options.title);
    if (options.message) modal.contentEl.createEl("p", { cls: "sfc-modal-message", text: options.message });
    let settled = false;
    const finish = (result: T | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
      modal.close();
    };
    modal.onClose = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
    modal.contentEl.addEventListener("keydown", (event) => {
      const index = Number.parseInt(event.key, 10);
      if (Number.isInteger(index) && index >= 1 && index <= options.options.length) {
        event.preventDefault();
        finish(options.options[index - 1]?.value ?? null);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    });

    const list = modal.contentEl.createDiv({ cls: "sfc-modal-choices" });
    const buttons: HTMLButtonElement[] = [];
    options.options.forEach((option, index) => {
      const button = list.createEl("button", {
        cls: "sfc-btn",
        attr: { type: "button", "aria-label": option.hint ? `${option.label}: ${option.hint}` : option.label },
      });
      button.createSpan({ cls: "sfc-modal-choice-index", text: String(index + 1) });
      button.createSpan({ text: option.label });
      if (option.hint) button.createSpan({ cls: "sfc-muted sfc-small", text: option.hint });
      button.onclick = () => finish(option.value);
      buttons.push(button);
    });

    const actions = modal.contentEl.createDiv({ cls: "sfc-modal-actions" });
    const cancel = actions.createEl("button", { text: options.cancelLabel ?? "取消", attr: { type: "button" } });
    cancel.onclick = () => finish(null);
    modal.open();
    window.setTimeout(() => buttons[0]?.focus(), 0);
  });
}