/**
 * How the queue is ordered inside its three buckets.
 *
 * Anki's design, narrowed to what this plugin actually has. The parts worth
 * copying, and the parts worth refusing:
 *
 * * **Random is a hash, not a shuffle.** `sorting.rs` in Anki hashes the card id
 *   with the day number as salt, with the comment that this keeps "remaining
 *   cards in the same approximate order" when the queue is rebuilt. A real
 *   shuffle would reshuffle on every rebuild, which happens after every answer --
 *   so the card you were about to see next would jump away, and finishing a
 *   session would become luck. Same idea here: stable within a day, different
 *   across days.
 * * **Most of Anki's review axes do not exist here.** It sorts by `ease` and by
 *   interval; this plugin's memory model is FSRS, which has no ease factor, and
 *   interval is not the signal that decides what is worth reviewing. Those
 *   options are left out rather than offered with nothing behind them.
 * * **Only new cards get a manual order.** In Anki, repositioning is a new-card
 *   operation: a review card's place in the queue is decided by when it is due,
 *   and dragging one around would be fighting the scheduler. Same rule here.
 *
 * Pure: no Obsidian, no clock, no store.
 */

import { hash32 } from "./ids";
import type { Card, QuestionKind } from "./types";

/** Order within the new-card bucket. */
export type NewOrder =
  /** By the manual position, smallest first. The default once arranged. */
  | "position"
  /** The same, backwards -- "I want the ones I queued last". */
  | "position-desc"
  /** By when the card was added, which is what an unarranged collection does. */
  | "created"
  /** Grouped by question kind, so a session does not alternate wildly. */
  | "kind"
  /** Hashed with the day as salt: stable today, different tomorrow. */
  | "random";

/** Order within the review bucket. */
export type ReviewOrder =
  /**
   * The ratio of elapsed time to stability, largest first.
   *
   * This is what the plugin already did before it was configurable, and it is
   * Anki's `RELATIVE_OVERDUENESS` in effect: the card furthest past its own
   * forgetting curve comes first.
   */
  | "relative-overdueness"
  /** Earliest due date first: the plainest reading of "what is most overdue". */
  | "due"
  /** Shortest interval first -- "clear the thin ones before the month-long ones". */
  | "interval"
  | "random";

export interface AgentSorter {
  newOrder: NewOrder;
  reviewOrder: ReviewOrder;
  /**
   * The salt for the random orders.
   *
   * Derived from the day, plus the session's reshuffle count. Passed in rather
   * than read from a clock so the ordering is a pure function of its inputs and
   * therefore testable -- and so "the same day, the same order" is a property
   * the tests can assert rather than a hope.
   */
  salt: number;
}

/** The part of a card the comparators need. */
export type SortableCard = Pick<
  Card,
  "id" | "position" | "questionKind" | "kind" | "due" | "intervalDays" | "stability" | "lastReview" | "addedAt"
>;

/** A sort key: a number or a string, both comparable within one mode. */
export type SortKey = number | string;

/**
 * The day number used as the random salt.
 *
 * `YYYY-MM-DD` folded to an integer, so two days produce different hashes and
 * the same day always produces the same one. Multiplying keeps neighbouring days
 * far apart in hash space: without it, "2026-03-04" and "2026-03-05" differ by
 * one character and the hashes of nearby ids come out correlated.
 */
export function daySalt(day: string): number {
  const digits = day.replace(/\D/g, "");
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value * 100003 : 1;
}

/** The hash a card gets in a random order. Exported so tests can pin it. */
export function randomKey(id: string, salt: number): string {
  return hash32(`${id}:${salt}`);
}

/**
 * A usable manual position, or null when the card has none.
 *
 * Guards against a hand-edited `data.json`: a `NaN` or negative position would
 * otherwise sort a card to the very front, which looks like the ordering is
 * broken rather than like one field is wrong.
 */
export function positionOf(card: SortableCard): number | null {
  const value = card.position;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** True when at least one card has a manual position. */
export function isArranged(cards: SortableCard[]): boolean {
  return cards.some((card) => positionOf(card) !== null);
}

/**
 * The fixed order of question kinds, for "grouped by kind".
 *
 * Deliberately the studio's order (recall first, then the objective kinds, then
 * the free-form ones) rather than alphabetical: it is the order a session should
 * build up in, from simple recall to written answers.
 */
const KIND_RANK: Record<QuestionKind, number> = {
  recall: 0,
  choice: 1,
  blank: 2,
  truefalse: 3,
  short: 4,
  essay: 5,
  custom: 6,
};

/** The rank of a card's question kind, for sorting. */
export function kindRank(card: SortableCard): number {
  const kind = card.questionKind ?? (card.kind === "cloze" ? "blank" : "recall");
  return KIND_RANK[kind] ?? KIND_RANK.custom;
}

/** Milliseconds for a due value, whether it is a day or an instant. */
function dueValue(due: string, dayEnd = false): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    // A day-level due date is available for the *whole* of that day, so the
    // comparable instant is the end of it rather than midnight. Comparing
    // midnight would put every day-level card a day "earlier" than the
    // sub-day ones beside it.
    return Date.parse(`${due}T${dayEnd ? "23:59:59" : "00:00:00"}Z`);
  }
  const parsed = Date.parse(due);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * The key a new card sorts by.
 *
 * Unarranged cards sort to the **end** under `position`, not the front: a card
 * added after the user arranged a deck is one they have not placed yet, and
 * pushing it ahead of everything they *did* place would silently undo their
 * arrangement.
 */
export function newSortKey(card: SortableCard, order: NewOrder, salt: number): SortKey {
  switch (order) {
    case "position": {
      const position = positionOf(card);
      return position === null ? Number.POSITIVE_INFINITY : position;
    }
    case "position-desc": {
      const position = positionOf(card);
      // The *opposite* of the ascending order, so the largest number comes first.
      // Unarranged cards are still last: this mode reverses the order the user
      // set up, it does not start with the cards they never placed.
      return position === null ? Number.POSITIVE_INFINITY : -position;
    }
    case "kind":
      return kindRank(card);
    case "random":
      return randomKey(card.id, salt);
    case "created":
    default:
      return card.addedAt ?? "";
  }
}

/**
 * The key a review card sorts by.
 *
 * `relative-overdueness` is the ratio of elapsed days to stability -- the same
 * measure the queue used before it was configurable, kept as the default so
 * nothing reorders itself on upgrade.
 */
export function reviewSortKey(card: SortableCard, order: ReviewOrder, salt: number, now: number): SortKey {
  switch (order) {
    case "due":
      return dueValue(card.due);
    case "interval":
      return card.intervalDays;
    case "random":
      return randomKey(card.id, salt);
    case "relative-overdueness":
    default: {
      const reference = card.lastReview ? Date.parse(card.lastReview) : Number.NaN;
      // A card with stability but no `lastReview` has memory state and no
      // reference point to measure it against, so it falls through to the due
      // date -- the same answer as a card with no memory state at all, and the
      // honest one either way: the ratio cannot be computed, and inventing one
      // would order the card by a number nobody can see.
      if (Number.isFinite(reference) && card.stability > 0) {
        // Elapsed days over stability, negated because the comparator sorts
        // ascending.
        //
        // This is Anki's `REVIEW_CARD_ORDER_RELATIVE_OVERDUENESS` under FSRS
        // with the two constant factors cancelled out (see
        // `sdk/tests/sort.test.mjs`, which re-derives the long form and asserts
        // the same ranking for two different curve decays): the FSRS exponent
        // appears on both the retrievability and the desired retention, and the
        // curve's base factor cancels inside the ratio, leaving `t / S`.
        //
        // It only holds while every card shares one desired retention. A
        // per-card retention would make that term stop cancelling *between*
        // cards, and this key would have to compute the curve instead.
        return -((now - reference) / 86400000) / card.stability;
      }
      // Overdue by *days*, also negated. The obvious implementation -- returning
      // the due instant -- gets this mode exactly backwards: a card due three
      // weeks ago would have the largest key and come last, in the one mode whose
      // whole purpose is "most overdue first".
      return -(now - dueValue(card.due)) / 86400000;
    }
  }
}

/**
 * Compare two keys, breaking ties by id.
 *
 * The tie-break is not decoration: without it the order of two equal keys would
 * depend on the sort implementation and the input order, so the queue could
 * differ between two rebuilds of the same data. `id` is unique and stable, which
 * makes the whole ordering a function of the collection.
 */
export function compareKeys(a: SortKey, b: SortKey, aId: string, bId: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** The Chinese label for an ordering, shared by the settings pane and the modal. */
export function orderLabel(order: NewOrder | ReviewOrder): string {
  switch (order) {
    case "position":
      return "按手动位置";
    case "position-desc":
      return "位置从大到小";
    case "created":
      return "按加入时间";
    case "kind":
      return "按题型分组";
    case "relative-overdueness":
      return "逾期最多优先";
    case "due":
      return "到期日早者优先";
    case "interval":
      return "间隔短者优先";
    case "random":
      return "随机";
    default:
      return String(order);
  }
}

/** Every new-card ordering, in the order the interface offers them. */
export const NEW_ORDERS: NewOrder[] = ["position", "position-desc", "created", "kind", "random"];

/** Every review ordering, in the order the interface offers them. */
export const REVIEW_ORDERS: ReviewOrder[] = ["relative-overdueness", "due", "interval", "random"];

/** Sort a copy of the cards, so a caller's array is never reordered in place. */
export function sortCards<T extends SortableCard>(
  cards: T[],
  key: (card: T) => SortKey,
): T[] {
  return [...cards].sort((a, b) => compareKeys(key(a), key(b), a.id, b.id));
}