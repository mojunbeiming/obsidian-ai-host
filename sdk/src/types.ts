/**
 * Domain types shared by the queue, the statistics and the plugins.
 *
 * Kept in one small module with no imports so every other core module can
 * depend on it without risking a cycle.
 */

import type { CardState } from "./fsrs";

/** A card's scheduling state. Card *content* lives in a note, not here. */
export interface Card {
  id: string;
  /** Vault-relative path of the note this card was extracted from. */
  file: string;
  /** ``^block-id`` when the card carries one; that, not the line number, is
   * what makes the card survive edits above it. */
  block?: string;
  /** The legacy parser's shape: a `basic` line or a `{{c1::}}` cloze. Kept
   * because the legacy reader still fills it in, and because cards written by
   * v0.1 are migrated rather than discarded. New cards use `questionKind`. */
  kind: "basic" | "cloze";
  deck: string;
  tags: string[];
  state: CardState;
  /** ``YYYY-MM-DD`` for day-level cards, ISO UTC instant for sub-day ones. */
  due: string;
  learningStep: number | null;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  intervalDays: number;
  lastReview: string | null;
  suspended: boolean;
  /** Day this card was buried for; a card is buried only for that day. */
  buriedDay?: string | null;
  /** The source text no longer contains this card. Kept so history survives. */
  orphaned?: boolean;
  /** Cloze ordinal, for ``{{c1::...}}`` renders. */
  clozeOrd?: number;
  /** First field preview, for list views. Only a cache; safe to recompute. */
  preview?: string;
  addedAt?: string;

  // -- v0.2 ---------------------------------------------------------------
  /**
   * What kind of question this is, which is what decides how it is answered
   * and graded. Redundant with `content.kind` on purpose: the queue groups by
   * it and the badge shows it, and neither should have to unpack `content`.
   */
  questionKind?: QuestionKind;
  /** The structured payload. Absent for a card migrated from v0.1 until it is edited. */
  content?: CardContent;
  /** Where the material lives. Empty for a card authored entirely in the studio. */
  links?: CardLink[];
  /** Result of the last link check, so the UI can say "the source moved". */
  linkState?: LinkState;
  /** Which question kinds have been answered here, for the library filters. */
  updatedAt?: string;
  /** Consecutive correct answers, used to retire a card from the wrong list. */
  correctStreak?: number;
  wrongCount?: number;
  /** Manually taken off the wrong list. History is never rewritten to do this. */
  dismissed?: boolean;
  /**
   * The manual study order within a deck, small numbers first.
   *
   * Only new cards get one, and only the "by position" order reads it: a review
   * card's place in the queue is decided by when it is due, so dragging one
   * around would be fighting the scheduler rather than arranging it. A card with
   * no position is one the user has not placed yet, and sorts **after**
   * everything they have -- moving it to the front would silently undo the
   * arrangement they made.
   */
  position?: number;
}

/** How a card's material is found right now. */
export type LinkState = "linked" | "moved" | "missing";

export type QuestionKind =
  /** Prompt, then answer. The `question :: answer` feel. */
  | "recall"
  /** One or more correct options out of a list. */
  | "choice"
  /** Typed answers, one card per blank. */
  | "blank"
  /** A statement is true or false. */
  | "truefalse"
  /** Typed answer compared loosely against the accepted ones. */
  | "short"
  /** Reading, worked solution, essay. Self-assessed, optionally against key points. */
  | "essay"
  /** Escape hatch: a body, plus either self-assessment or an accept list. */
  | "custom";

/**
 * Where the question text comes from.
 *
 * This is the field that makes "a card is not a copy of the passage" true: the
 * marker only links a card to material, and the card decides what it shows.
 */
export type PromptSource =
  /** Read the linked block as it currently reads in the note. */
  | "live"
  /** Use only what was typed in the studio. */
  | "inline"
  /** Linked block as material, plus typed text as the question. */
  | "mixed";

/** One note position a card is linked to. The marker is its visible handle. */
export interface CardLink {
  /** Vault-relative path. */
  file: string;
  /** The block id without its caret -- literally the marker text. */
  blockId: string;
  /** The passage as selected when the card was made; used to re-anchor. */
  quote: string;
  contentHash?: string;
  /** The block the card is filed under; `context` blocks are extra material. */
  role: "primary" | "context";
  /**
   * Where the marker was when the link was last written, 1-based.
   *
   * A **hint, never a truth**: editing above the passage moves the marker and
   * nothing rewrites this number until the next scan. It exists to narrow the
   * search window when re-anchoring, and a stale value only costs a wider
   * search -- which is why it is safe to keep and safe to be wrong.
   */
  line?: number;
}

export interface ChoiceOption {
  text: string;
  correct: boolean;
}

export interface BlankSpec {
  /** Any one of these counts as correct. */
  answers: string[];
  /** Shown inside the empty box, like Anki's `::hint`. */
  cue?: string;
  caseSensitive?: boolean;
  /**
   * The ordinal of this blank in `content.template`, 0-based.
   *
   * `undefined` means "not written explicitly", and the reader falls back to
   * the blank's position in the array. Storing it means deleting a middle blank
   * does not silently shift every answer after it.
   */
  slot?: number;
}

export interface KeyPoint {
  text: string;
  required: boolean;
}

export interface CardContent {
  kind: QuestionKind;
  /* -- the question side -- */
  promptSource: PromptSource;
  /** Markdown typed in the studio; used by `inline` and `mixed`. */
  promptInline?: string;
  /**
   * A cloze question body with `0 1 ` marking the holes.
   *
   * Present only on blank cards authored with the cut-a-hole tool; a blank card
   * without it is the legacy single-input shape and stays gradeable exactly as
   * it was. `template` is the question; `blanks` is the answer key.
   */
  template?: string;
  /**
   * Ask every blank on one card instead of one card per blank.
   *
   * Off by default so existing decks keep their card count and behaviour; it is
   * an explicit choice in the studio.
   */
  allBlanks?: boolean;
  /*
   * `promptSource` and `template` interact like this:
   * - `inline` / `mixed`: `template` is the whole question and depends on no
   *   note at all;
   * - `live`: `template` is a snapshot taken when the card was made. The review
   *   pane still reads the linked passage live for the question text, but the
   *   holes render from the snapshot, and a broken link is shown as
   *   "定位已漂移（用快照）" rather than silently rendering empty holes;
   * - a blank card that never had a linked passage is `inline`.
   */
  /* -- per-kind payload; only some apply -- */
  answer?: string;
  options?: ChoiceOption[];
  /** Choice: more than one option may be marked correct. */
  multi?: boolean;
  /** Choice: shuffle the options each time. Off by default, because
   * "all of the above" must not move. */
  shuffle?: boolean;
  blanks?: BlankSpec[];
  tf?: boolean;
  keyPoints?: KeyPoint[];
  /** Shown after grading, for every kind. */
  explanation?: string;
  /** The card's own Markdown: media embeds and extra material live here. */
  body?: string;
  /** The escape hatch, shaped like Anki's `cards.data`. */
  custom?: {
    grader?: "self" | "accept";
    accept?: string[];
    template?: string;
  };
}

/**
 * A user-made list of cards to review together.
 *
 * Distinct from a deck: a deck is where a card lives, a card list is what you
 * want to see together. One card can be in several lists; deleting a list never
 * deletes a card.
 */
export interface CardList {
  id: string;
  name: string;
  cardIds: string[];
  order: "manual" | "due" | "random";
  scope: "due" | "all";
  /** Practice mode: answers are logged, but FSRS is not updated. */
  practice: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The editable part of today's automatic queue.
 *
 * Only valid for `day`; at the next civil day the whole object is discarded and
 * the queue is built fresh. `added` bypasses the due check and daily limits --
 * clicking "add to today" is an explicit request to see that card now.
 */
export interface QueueEdits {
  day: string;
  added: string[];
  removed: string[];
  /** Full manual order for today; absent means the automatic order. */
  order?: string[];
}

export interface DeckLimits {
  newPerDay: number;
  reviewsPerDay: number;
}

export interface Deck extends DeckLimits {
  id: string;
  name: string;
  desiredRetention?: number;
  learningSteps?: number[];
  relearningSteps?: number[];
}

/** One answered card. Append-only; the source of truth for all history. */
export interface ReviewEntry {
  id: string;
  cardId: string;
  deck: string;
  rating: 1 | 2 | 3 | 4;
  stateBefore: CardState;
  stateAfter: CardState;
  intervalDays: number;
  scheduledDays: number;
  elapsedDays: number;
  durationMs: number;
  /** ISO-8601 UTC instant of the answer. */
  reviewedAt: string;
  /** Civil day in the user's own time zone. */
  day: string;
  stability: number;
  difficulty: number;
  /**
   * The state the card was put into, recorded so an undo can restore it exactly.
   *
   * Without these the log knows what a card *was* but not what it *became*, and
   * an undo has to guess -- which loses a learning step, or resurrects a due
   * date that a later answer already superseded.
   */
  dueAfter?: string;
  learningStepAfter?: number | null;
  /** Set when the answer was undone, so history stays honest without
   * rewriting the log. */
  undone?: boolean;

  // -- v0.2 ---------------------------------------------------------------
  /**
   * How the rating was arrived at.
   *
   * `auto` means the question type graded it and the user accepted the default;
   * `self` means the user pressed one of the four buttons on a card that has no
   * automatic grading at all. Absent on entries written before v0.2, which
   * means `self` -- that is what answering was.
   */
  judgedBy?: "auto" | "self";
  /**
   * What the user typed or picked, trimmed to a readable length.
   *
   * This is the field the wrong-answer list is actually useful for: "you never
   * recall this" is not actionable, "you picked C twice" is.
   */
  response?: string;
  /** The automatic grade said wrong and the user disagreed. */
  override?: boolean;
  /** Written during a wrong-answer sprint rather than a due review. */
  sprint?: boolean;
  /** Which self-made card list this answer came from; empty for the due queue. */
  listId?: string;
  /** Practice mode: the answer is logged, but the schedule was not written. */
  practice?: boolean;
  /** Key points the user ticked, for essay cards. Never affects the rating. */
  keyPointsHit?: number;
}

export type Priority = 0 | 1 | 2 | 3;

export type Recurrence =
  | { kind: "none" }
  | { kind: "daily"; interval: number }
  | { kind: "weekdays" }
  | { kind: "weekly"; interval: number; weekday: number }
  | { kind: "monthly"; interval: number; day: number };

export interface Todo {
  id: string;
  title: string;
  notes: string;
  /** ``YYYY-MM-DD`` or null for "someday". */
  due: string | null;
  priority: Priority;
  tags: string[];
  done: boolean;
  doneAt: string | null;
  recurrence: Recurrence;
  estimateMinutes: number | null;
  /** Optional engine deck id; a plain string so this type stays standalone. */
  linkedDeckId: string | null;
  createdAt: string;
  position: number;
}

/**
 * One line of `todos.jsonl`: the append-only history, and the authority on *when*
 * something was done.
 *
 * `todoId` is the task's stable key (`todo-<8 chars>` from its block id, or a derived line
 * key), not a record in a store -- the notes hold the tasks, this file holds what happened
 * to them.
 *
 * `count` and `mode` are additive and optional so an existing log keeps its exact meaning:
 * an entry without them is one completion, which is what every entry used to be. A goal
 * with a `🎯` target needs them, because "读了 40 页" is not the same claim as "读完了".
 */
export interface TodoLogEntry {
  todoId: string;
  day: string;
  action: "complete" | "reopen";
  at: string;
  /** How much this entry added, or set. Defaults to one. */
  count?: number;
  /** `delta` adds to the day's total, `set` replaces it. Defaults to `delta`. */
  mode?: "delta" | "set";
  /** Where the entry came from, for the progress pane's provenance line. */
  source?: "manual" | "command" | "api" | "flashcards";
  /** A free-form note about the entry, e.g. which deck a study goal was logged from. */
  via?: string;
  /**
   * A checkpoint completion is attached to its parent, not a top-level task completion.
   *
   * `activityByDay` deliberately ignores checkpoint entries so the check-in grid does not count
   * one piece of work twice; the progress pane reads them separately.
   */
  kind?: "task" | "checkpoint";
  /** The parent row key, for a `kind: "checkpoint"` entry. */
  parentId?: string | null;
  /** Optional quality feedback given when a checkpoint was completed. */
  quality?: "good" | "ok" | "bad";
}


export interface CheckIn {
  day: string;
  note: string;
  mood: string;
  minutesPlanned: number | null;
  updatedAt: string;
}

export interface QueueCounts {
  new: number;
  learning: number;
  review: number;
  total: number;
}