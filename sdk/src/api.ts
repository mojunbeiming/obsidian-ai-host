/**
 * The collaboration contract between the sfc-* plugins.
 *
 * Design constraints, in order of importance:
 *
 * 1. **Every plugin must work alone.** Any plugin may be enabled without the
 *    others, so every capability is optional and a missing one is a normal
 *    code path -- not an error case.
 * 2. **No load-order assumptions.** Obsidian enables plugins in whatever order
 *    the user's list happens to be in, and plugins can be disabled and
 *    re-enabled while the app is running. The registry is therefore consulted
 *    fresh on every call rather than cached at load time.
 * 3. **No dependency on Obsidian internals.** The registry is a plain property
 *    on the app object. Reaching into ``app.plugins`` would work today and
 *    break on an Obsidian refactor, and it is exactly the kind of coupling a
 *    user installing one of these plugins alone would pay for.
 * 4. **Versioned.** Interfaces carry a version; a caller states the minimum it
 *    understands, and a mismatch reads as "not available" rather than as a
 *    runtime error deep inside someone else's object.
 *
 * The types here are the single source of truth for the contract. This module
 * has no imports, so bundling it into all three plugins costs nothing and
 * guarantees the three never disagree.
 */

/**
 * The contract version every provider implements.
 *
 * It goes up when a reader that only understands N could be **misled** by a
 * provider at N+m, not merely when a method is added. Adding an optional field
 * is such a case in one direction only: a v1 reader of a v2 provider is fine,
 * which is why the check-in plugin can be the newest one in the set and still
 * read the other two.
 */
export const API_VERSION = 2;

/**
 * The contract version the check-in plugin needs from the other two.
 *
 * Separate from ``API_VERSION`` on purpose. The other plugins publish
 * ``API_VERSION``; only they are versioned by what *they* promise. A caller
 * states the minimum it can work with. Providers moved to v2 when
 * ``DayActivitySummary.goals`` became available; an older reader that requests v1
 * is still safe because the field is optional.
 */
export const CHECKIN_API_VERSION = 2;

/**
 * The AI Host's trace/log/agent API.
 *
 * Deliberately separate from \`API_VERSION\`: adding a run record must not force
 * every cross-plugin data call to renegotiate, and a domain plugin can require a
 * newer trace API while still reading v2 activity data.
 *
 * v2 adds the optional workspace/agent surface (`listWorkspaces`,
 * `currentWorkspace`, `setPermission`, `agentStart/Pause/Resume/Stop`,
 * `getAgentState`). All of it is optional on the provider object, so a v1 host
 * is still usable: a caller checks for the method and hides the entry point
 * instead of failing at the call.
 */
export const AI_HOST_API_VERSION = 2;

/** Where each plugin registers itself. Ids are stable; the display names change. */
export const PLUGIN_IDS = {
  flashcards: "sfc-flashcards",
  todo: "sfc-todo",
  checkin: "sfc-checkin",
  ai: "sfc-ai",
} as const;

/**
 * The plugins this repository currently ships.
 *
 * `PLUGIN_IDS` is the stable registry of every id that has ever been published, so
 * an archived plugin can be revived without changing the contract. This set is what
 * the build, install and contract checks use to decide what is part of the current
 * release.
 */
export const SHIPPED_PLUGIN_IDS = {
  flashcards: "sfc-flashcards",
  todo: "sfc-todo",
  ai: "sfc-ai",
} as const;

export type PluginId = (typeof PLUGIN_IDS)[keyof typeof PLUGIN_IDS];
export type ShippedPluginId = (typeof SHIPPED_PLUGIN_IDS)[keyof typeof SHIPPED_PLUGIN_IDS];

/** Anything carrying a version, so the gate is uniform. */
export interface VersionedApi {
  version: number;
}

export interface Registry {
  version: number;
  apis: Record<string, VersionedApi>;
  /** When each api was published, so a caller can explain a stale one. */
  publishedAt?: Record<string, number>;
}

/** Where the registry lives. A plain property, deliberately not namespaced
 * under any Obsidian private object. */
export const REGISTRY_KEY = "sfcRegistry";

interface RegistryHost {
  [key: string]: unknown;
}

function host(app: unknown): RegistryHost | null {
  if (!app || typeof app !== "object") return null;
  return app as RegistryHost;
}

function ensureRegistry(target: RegistryHost): Registry {
  const existing = target[REGISTRY_KEY] as Registry | undefined;
  if (existing && typeof existing === "object" && existing.apis) return existing;
  const created: Registry = { version: API_VERSION, apis: {}, publishedAt: {} };
  // A plain assignment, not defineProperty: it must be visible to another
  // bundle that is looking for the same key, and enumerable for debugging.
  target[REGISTRY_KEY] = created;
  return created;
}

/**
 * Publish an api. Republishing from the same id replaces it, which is what
 * makes a plugin reload work without the old object lingering.
 */
export function publishApi(app: unknown, id: PluginId | string, api: VersionedApi): void {
  const target = host(app);
  if (!target) return;
  const registry = ensureRegistry(target);
  registry.apis[id] = api;
  registry.publishedAt = registry.publishedAt ?? {};
  registry.publishedAt[id] = Date.now();
}

export function unpublishApi(app: unknown, id: PluginId | string): void {
  const target = host(app);
  if (!target) return;
  const registry = target[REGISTRY_KEY] as Registry | undefined;
  if (!registry || !registry.apis) return;
  // Removed unconditionally, because the ordering that matters is guaranteed by
  // Obsidian rather than by anything here: a reload calls `onunload` before the
  // next `onload`, and this plugin's `register(() => unpublishApi(...))` runs
  // during that unload -- before the reloaded instance publishes. So the entry
  // being deleted is always this instance's own.
  //
  // (An earlier version of this comment claimed the code checked ownership
  // before deleting. It never did, and a comment describing a safeguard the code
  // does not have is worse than no comment: the next reader stops looking for
  // the real reason.)
  delete registry.apis[id];
  if (registry.publishedAt) delete registry.publishedAt[id];
}

/**
 * Look up an api, or ``null`` when it is absent or too old.
 *
 * Returning null rather than throwing is the point: callers then have exactly
 * one branch for "that plugin is not here right now", whether it was never
 * installed, is currently disabled, or is an older version.
 */
export function getApi<T extends VersionedApi>(
  app: unknown,
  id: PluginId | string,
  minVersion = API_VERSION,
): T | null {
  const target = host(app);
  if (!target) return null;
  const registry = target[REGISTRY_KEY] as Registry | undefined;
  const api = registry?.apis?.[id] as T | undefined;
  if (!api) return null;
  const version = Number((api as { version?: unknown }).version);
  if (!Number.isFinite(version) || version < minVersion) return null;
  return api;
}

/** True when the api exists and is new enough -- for enabling commands. */
export function hasApi(app: unknown, id: PluginId | string, minVersion = API_VERSION): boolean {
  return getApi(app, id, minVersion) !== null;
}

// ---------------------------------------------------------------------------
// The three interfaces
// ---------------------------------------------------------------------------

export interface StreakSummary {
  current: number;
  longest: number;
  totalDays: number;
  lastDay: string | null;
  checkedInToday: boolean;
}

/**
 * One goal a provider knows about.
 *
 * The todo plugin's goals **are** its recurring tasks: a task named "背 50 个
 * 单词" with ``daily`` recurrence is exactly what a user means by a goal, and
 * inventing a second entity for it would only create something to keep in step.
 */
export interface GoalSummary {
  id: string;
  title: string;
  /** Human-readable cadence, e.g. ``每天``; empty for a one-off task. */
  cadence: string;
  /** True when the goal repeats, so a per-goal grid is meaningful. */
  recurring: boolean;
}

export interface DayActivitySummary {
  /** ``YYYY-MM-DD``. */
  day: string;
  cards: number;
  newCards: number;
  lapses: number;
  minutes: number;
  /**
   * How many tasks were satisfied on this day.
   *
   * Counts **tasks, not actions**: ticking the same habit twice in a day is one task done.
   * A task with a ``🎯`` target is satisfied only when the day reaches the target, so a
   * goal at 40 of 50 is not "done" -- the alternative would draw a filled cell for a day
   * the work was not finished.
   */
  todosDone: number;
  /**
   * Goal ids satisfied on this day, or absent when the provider cannot say.
   *
   * "Satisfied", not "touched": a task with no target is satisfied by a completion for
   * that day, one with a target only when the day's total reaches it, and a day whose
   * completion was undone satisfies nothing. ``todosDone`` is exactly the length of this
   * array, so a reader may use either.
   *
   * Optional because this is what separates v2 from v1, and an absent field must
   * read as "no per-goal breakdown available" rather than as "no goals were met"
   * -- the two would otherwise collapse into the same empty array and silently
   * blank the per-goal grids.
   */
  goals?: string[];
}

export interface DeckSummary {
  id: string;
  name: string;
  counts: { new: number; learning: number; review: number; total: number };
}

export interface NewCardInput {
  front: string;
  back: string;
  deck?: string;
  tags?: string[];
  /**
   * Where the card came from, as ``{ path }`` or ``{ context }``.
   *
   * Both are advisory. A caller that is itself a plugin does not need to know
   * the vault layout, and the flashcards plugin does not need to know which
   * plugin asked -- which is the whole reason this is a string pair rather
   * than a file handle.
   */
  sourceNote?: { path?: string; context?: string };
}

export interface FlashcardsApi extends VersionedApi {
  /** Open the study pane, optionally scoped to one deck. */
  openStudy(deckId?: string): Promise<void>;
  /** Feed the study pane a single card right now, bypassing the queue. */
  studyCard(cardId: string): Promise<void>;
  listDecks(): Promise<DeckSummary[]>;
  addCard(input: NewCardInput): Promise<{ id: string }>;
  /**
   * Per-day review activity, gaps filled. The check-in plugin's data source.
   *
   * Version 2 adds ``goals``: the decks studied that day. It is optional, so a
   * version-1 provider still satisfies this call and simply yields no deck-level
   * breakdown.
   */
  reviewActivity(range: { start: string; end: string }): Promise<DayActivitySummary[]>;
  streak(): Promise<StreakSummary>;
  /** Decks that have ever been studied, as goals a grid can be drawn for. */
  goals(): Promise<GoalSummary[]>;
  /** A card id for a note position, so another plugin can link to it. */
  cardIdFor(path: string, text: string, blockId?: string | null): string | null;
}

export interface TodoApi extends VersionedApi {
  openTodos(): Promise<void>;
  /**
   * Create a task. ``due`` may be a civil day or one of the relative words the
   * todo plugin already understands, so a caller can say "tomorrow" without
   * owning a date library.
   */
  addTodo(input: {
    title: string;
    due?: string;
    notes?: string;
    tags?: string[];
    priority?: 0 | 1 | 2 | 3;
    linkedDeckId?: string | null;
  }): Promise<{ id: string }>;
  /** Open the todo pane focused on one task. */
  focusTodo(id: string): Promise<void>;
  /**
   * Per-day completion activity, gaps filled.
   *
   * Separate from ``listTodos`` rather than derived from it, because the log is
   * the authority on *when* something was done: a task that was completed and
   * then deleted still happened, and a caller reconstructing history from the
   * live task list would lose it.
   */
  activity(range: { start: string; end: string }): Promise<DayActivitySummary[]>;
  /** Recurring tasks, which are what a per-goal heat grid is drawn for. */
  goals(): Promise<GoalSummary[]>;
}

export interface CheckinApi extends VersionedApi {
  /** Open the check-in pane, optionally on one goal and year. */
  openCheckins(options?: { year?: number; goalId?: string }): Promise<void>;
  /**
   * Re-read every source and resolve with what the grid now covers.
   *
   * Resolves to counts rather than to the data: a caller across a plugin
   * boundary wants to know that the refresh worked, and handing out the merged
   * day map would make this plugin's internals part of its contract.
   */
  refresh(year?: number): Promise<{ days: number; hitDays: number; sources: string[] }>;
  /** Record today's manual check-in. Resolves false when it was already set. */
  checkInToday(): Promise<boolean>;
}

/** Human-readable requirement string for a degradation notice. */
export function requirement(plugin: string, minVersion = API_VERSION): string {
  return `${plugin} >= v${minVersion}`;
}