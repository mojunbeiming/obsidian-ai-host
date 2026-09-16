/**
 * Templates: Markdown files in a vault folder, not a hidden JSON store.
 *
 * The plan sketched a one-record-per-file repository; a vault folder satisfies
 * the same properties (persisted, searchable, one file per template) and is
 * editable in Obsidian like any note, which is what users of `/` templates
 * expect. The folder is configurable (`templatesFolder`).
 */

import { App, SuggestModal, TFile } from "obsidian";

export interface AiTemplate {
  path: string;
  name: string;
  content: string;
}

export class TemplateStore {
  constructor(private readonly app: App, private folder: () => string) {}

  private prefix(): string {
    return this.folder().trim().replace(/^\/+|\/+$/g, "");
  }

  list(): AiTemplate[] {
    const prefix = this.prefix();
    if (!prefix) return [];
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${prefix}/`))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ path: file.path, name: file.basename, content: "" }));
  }

  async read(template: AiTemplate): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(template.path);
    if (!(file instanceof TFile)) return "";
    return await this.app.vault.cachedRead(file);
  }

  async ensureFolder(): Promise<void> {
    const prefix = this.prefix();
    if (!prefix) return;
    const folder = this.app.vault.getAbstractFileByPath(prefix);
    if (!folder) await this.app.vault.createFolder(prefix);
  }
}

/** The `/` picker. */
export class TemplateSuggestModal extends SuggestModal<AiTemplate> {
  constructor(
    app: App,
    private readonly store: TemplateStore,
    private readonly onChoose: (template: AiTemplate) => void,
    private readonly onDismiss?: () => void,
  ) {
    super(app);
    this.setPlaceholder("选择模板");
  }

  onClose(): void {
    super.onClose();
    this.onDismiss?.();
  }

  getSuggestions(query: string): AiTemplate[] {
    const needle = query.trim().toLowerCase();
    return this.store.list().filter((template) => !needle || template.name.toLowerCase().includes(needle));
  }

  renderSuggestion(template: AiTemplate, el: HTMLElement): void {
    el.createDiv({ text: template.name });
    el.createDiv({ cls: "sfc-ai-diff-head", text: template.path });
  }

  onChooseSuggestion(template: AiTemplate): void {
    this.onChoose(template);
  }
}