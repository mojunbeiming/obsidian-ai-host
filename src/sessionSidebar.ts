/**
 * The conversation sidebar: brand, search, workspace-grouped conversations,
 * hover actions, settings.
 *
 * ## Expanded and collapsed share one tree
 *
 * Every control exists exactly once, with an icon span and a label span. The
 * collapsed rail (48px) hides labels through CSS, so a control cannot work in
 * one state and silently stop working in the other. This is the rule the DSH
 * collapsed-sidebar note arrived at the hard way: a rail that is a second,
 * separately built tree is a rail whose buttons drift from the real ones.
 *
 * The rail keeps, top-down: expand toggle, new session, search, new workspace,
 * settings. Search expands first and focuses after the transition, and the
 * query survives the round trip because it lives in the pane, not the DOM.
 *
 * It renders a snapshot and reports events; it never reads the store or the
 * vault. That keeps "delete a conversation" a menu item the pane can confirm
 * instead of a DOM handler that already deleted something by the time the
 * store hears about it.
 */

import { setIcon } from "obsidian";
import type { AiConversationSummary } from "../sdk/src/ai/aiConversationStore";
import type { AiWorkspace } from "../sdk/src/ai/aiWorkspace";
import { iconName } from "../sdk/src/icons";
import { groupConversations, relativeTime, type ConversationSection } from "./workspaces";

export interface SidebarCallbacks {
  onSelect(id: string): void;
  onNew(): void;
  onRename(id: string): void;
  onDelete(id: string): void;
  onPin(id: string, pinned: boolean): void;
  onSearch(query: string): void;
  onNewWorkspace(): void;
  onRenameWorkspace(id: string): void;
  onSettings(): void;
  onToggleCollapse(): void;
  /** The rail's search icon: expand is a precondition for focusing. */
  onRequestExpand(): void;
}

export interface SidebarSnapshot {
  summaries: AiConversationSummary[];
  workspaces: AiWorkspace[];
  activeId: string | null;
  query: string;
  collapsed: boolean;
  /** True while a page-local new-session intent is open (no record yet). */
  blank: boolean;
}

/** One icon+label control. `label` may be empty for icon-only rows. */
function control(
  parent: HTMLElement,
  input: { cls: string; icon: string; label: string; title: string; onClick: () => void },
): HTMLButtonElement {
  const button = parent.createEl("button", { cls: input.cls });
  button.setAttr("aria-label", input.title);
  button.setAttr("title", input.title);
  // An empty name is not a smaller icon, it is *no* icon: the button stays, stays
  // clickable, and renders blank. Every control here has a name, and `iconName`
  // maps the few that Obsidian renames onto names we register ourselves.
  setIcon(button.createSpan({ cls: "sfc-ai-icon" }), iconName(input.icon));
  if (input.label) button.createSpan({ cls: "sfc-ai-label", text: input.label });
  button.onclick = (event) => {
    event.stopPropagation();
    input.onClick();
  };
  return button;
}

export class SessionSidebar {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly searchEl: HTMLInputElement;
  private readonly brandButton: HTMLButtonElement;

  constructor(container: HTMLElement, private readonly callbacks: SidebarCallbacks) {
    this.root = container.createDiv({ cls: "sfc-ai-sidebar" });

    const brand = this.root.createDiv({ cls: "sfc-ai-side-brand" });
    this.brandButton = brand.createEl("button", { cls: "sfc-ai-ghost sfc-ai-side-logo", text: "AI" });
    this.brandButton.setAttr("aria-label", "展开/折叠侧栏");
    this.brandButton.setAttr("title", "展开/折叠侧栏");
    this.brandButton.onclick = () => this.callbacks.onToggleCollapse();
    brand.createSpan({ cls: "sfc-ai-side-name", text: "AI Host" });
    control(brand, {
      cls: "sfc-ai-ghost sfc-ai-side-collapse",
      icon: "panel-left",
      label: "",
      title: "折叠侧栏",
      onClick: () => this.callbacks.onToggleCollapse(),
    });

    control(this.root, {
      cls: "sfc-ai-new",
      icon: "plus",
      label: "新会话",
      title: "新建会话",
      onClick: () => this.callbacks.onNew(),
    });

    const searchRow = this.root.createDiv({ cls: "sfc-ai-side-search-row" });
    const searchIcon = searchRow.createEl("button", { cls: "sfc-ai-ghost sfc-ai-side-search-icon" });
    searchIcon.setAttr("aria-label", "搜索会话");
    searchIcon.setAttr("title", "搜索会话");
    setIcon(searchIcon, iconName("search"));
    searchIcon.onclick = () => {
      this.callbacks.onRequestExpand();
      this.searchEl.focus();
    };
    this.searchEl = searchRow.createEl("input", { cls: "sfc-ai-side-search", type: "search", placeholder: "搜索会话" });
    this.searchEl.oninput = () => this.callbacks.onSearch(this.searchEl.value);

    this.listEl = this.root.createDiv({ cls: "sfc-ai-side-list" });

    const footer = this.root.createDiv({ cls: "sfc-ai-side-footer" });
    control(footer, {
      cls: "sfc-ai-ghost",
      icon: "folder-plus",
      label: "新建工作区",
      title: "新建工作区",
      onClick: () => this.callbacks.onNewWorkspace(),
    });
    control(footer, {
      cls: "sfc-ai-ghost",
      icon: "settings",
      label: "设置",
      title: "AI 设置",
      onClick: () => this.callbacks.onSettings(),
    });
  }

  /** Repaint from a fresh snapshot. Cheap enough to call on every change. */
  render(snapshot: SidebarSnapshot): void {
    if (this.searchEl.value !== snapshot.query) this.searchEl.value = snapshot.query;
    this.listEl.empty();
    const needle = snapshot.query.trim().toLowerCase();
    const summaries = needle
      ? snapshot.summaries.filter((summary) => summary.title.toLowerCase().includes(needle))
      : snapshot.summaries;
    if (snapshot.blank && !needle) {
      const blankRow = this.listEl.createDiv({ cls: "sfc-ai-side-item sfc-ai-side-item-active sfc-ai-side-blank" });
      blankRow.createSpan({ cls: "sfc-ai-side-title", text: "新会话" });
      blankRow.createSpan({ cls: "sfc-ai-side-meta", text: "尚未发送" });
    }
    const sections = groupConversations(summaries, snapshot.workspaces);
    if (!sections.length) {
      if (!snapshot.blank || needle) {
        this.listEl.createDiv({ cls: "sfc-ai-side-empty", text: summaryEmptyText(snapshot, needle) });
      }
      return;
    }
    for (const section of sections) this.renderSection(section, snapshot);
  }

  /** Focus the search box after the pane has expanded. */
  focusSearch(): void {
    this.searchEl.focus();
  }

  private renderSection(section: ConversationSection, snapshot: SidebarSnapshot): void {
    const head = this.listEl.createDiv({ cls: "sfc-ai-side-head" });
    head.createSpan({ cls: "sfc-ai-side-head-title", text: section.title });
    head.createSpan({ cls: "sfc-ai-side-count", text: String(section.items.length) });
    if (section.kind === "workspace") {
      control(head, {
        cls: "sfc-ai-ghost sfc-ai-side-head-action",
        icon: "pencil",
        label: "",
        title: "重命名工作区",
        onClick: () => this.callbacks.onRenameWorkspace(section.id.replace(/^ws-/, "")),
      });
    }
    for (const summary of section.items) this.renderItem(summary, snapshot);
  }

  private renderItem(summary: AiConversationSummary, snapshot: SidebarSnapshot): void {
    const row = this.listEl.createDiv({ cls: "sfc-ai-side-item" });
    row.toggleClass("sfc-ai-side-item-active", summary.id === snapshot.activeId);
    row.setAttr("title", summary.title);
    const main = row.createDiv({ cls: "sfc-ai-side-main" });
    main.createDiv({ cls: "sfc-ai-side-title", text: summary.title });
    const meta = main.createDiv({ cls: "sfc-ai-side-meta" });
    meta.createSpan({ text: relativeTime(summary.updatedAt || summary.createdAt) });
    if (summary.messageCount) meta.createSpan({ text: `  ${summary.messageCount} 条` });
    if (summary.pinned) meta.createSpan({ cls: "sfc-ai-side-pin", text: "  " });
    main.onclick = () => this.callbacks.onSelect(summary.id);

    const actions = row.createDiv({ cls: "sfc-ai-side-actions" });
    control(actions, {
      cls: "sfc-ai-ghost",
      icon: summary.pinned ? "pin-off" : "pin",
      label: "",
      title: summary.pinned ? "取消置顶" : "置顶",
      onClick: () => this.callbacks.onPin(summary.id, !summary.pinned),
    });
    control(actions, {
      cls: "sfc-ai-ghost",
      icon: "pencil",
      label: "",
      title: "重命名",
      onClick: () => this.callbacks.onRename(summary.id),
    });
    control(actions, {
      cls: "sfc-ai-ghost",
      icon: "trash-2",
      label: "",
      title: "删除会话",
      onClick: () => this.callbacks.onDelete(summary.id),
    });
    row.oncontextmenu = (event) => {
      event.preventDefault();
      this.callbacks.onRename(summary.id);
    };
  }
}

function summaryEmptyText(snapshot: SidebarSnapshot, needle: string): string {
  if (needle) return `没有匹配「${snapshot.query.trim()}」的会话。`;
  return "还没有会话。点「新会话」开始。";
}