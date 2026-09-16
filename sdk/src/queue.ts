/**
 * The daily queue: what to study right now, and why nothing is left.
 *
 * Deliberate ordering. Learning steps come first because a card that is 40
 * seconds from being due is about to become available and should not be
 * behind a hundred reviews; reviews come next, hardest-to-recall first;
 * new cards come last so that a large review backlog never hides behind a
 * pile of unseen material.
 *
 * The daily limit is counted from the review log rather than from a mutable
 * counter, so the limit cannot drift when the same card is answered from two
 * windows or after a crash mid-session.
 */

import { dueInstant } from "./fsrs";
import { compareKeys, newSortKey, reviewSortKey, type AgentSorter } from "./sort";
import type { Card, Deck, QueueCounts, ReviewEntry } from "./types";

export type EmptyReason = "learning-soon" | "quota-reached" | "nothing-due";

export interface QueueOptions {
  /** The civil day the queue is being built for. */
  day: string;
  /** Current instant, as an epoch. */
  now: number;
  newLimit?: number;
  reviewLimit?: number;
  /** Restrict to these decks; empty or absent means every deck. */
  decks?: string[];
  /**
   * Card ids to hold back even though their state says they are waiting.
   *
   * This is a **consistency guard, not a daily filter**, and the distinction is
   * load-bearing. A card answered earlier today is normally *not* in this set:
   * answering a new card moves it into the learning ladder, so its state already
   * records that. The set exists for the case where the state and the log
   * disagree -- a crash between the two writes, a hand-edited `data.json`, a
   * second window with stale in-memory state.
   *
   * Passing *everything* answered today would be a bug rather than a stricter
   * version of this: a learning card whose 1-minute step has come back around,
   * and a review card that fell due again later the same day, both belong in the
   * queue. The learning ladder is same-day repetition by design, so suppressing
   * those would stop new cards from ever graduating.
   */
  answeredToday?: Iterable<string>;
  /**
   * Study only these card ids, ignoring the rest of the collection.
   *
   * Used by the wrong-answer sprint. It is a **set restriction and nothing
   * else**: a card outside the set is invisible, a card inside it still has to
   * pass every other rule (eligible, in scope, under the daily limit) unless
   * `allowNotDue` is also set. Keeping the two separate is what lets the sprint
   * be "these cards, right now" without quietly turning into "no limits at all".
   */
  onlyWrong?: Iterable<string>;
  /**
   * Admit cards that are not due yet.
   *
   * Off by default, and it has to be asked for explicitly: the whole point of
   * the scheduler is that a card comes back when it is about to be forgotten,
   * and a queue that ignores due dates by accident would destroy the intervals
   * it is supposed to be protecting. The sprint turns it on because drilling a
   * mistake before its interval elapses is a deliberate choice, not an
   * oversight.
   */
  allowNotDue?: boolean;
  /**
   * How to order the cards inside each bucket.
   *
   * Absent means the pre-ordering behaviour, byte for byte: new cards by id,
   * review cards by elapsed-over-stability. That default matters more than it
   * looks -- a plugin whose ordering changes on upgrade silently reshuffles
   * someone's study, and they have no way to tell that it was not their doing.
   *
   * **Ordering only happens inside a bucket.** Learning steps still come before
   * reviews, and reviews before new cards, whatever this says: the ladder is
   * minutes from being forgotten and cannot be deferred behind a preference.
   */
  sorter?: AgentSorter;
}

export interface QueuePlan {
  /** Ordered ids: learning first, then review, then new. */
  order: string[];
  counts: QueueCounts;
  limits: { new: number; review: number };
  progress: { reviewsDone: number; newDone: number };
  remaining: { new: number; review: number };
}

export function isDue(card: Card, now: number): boolean {
  const instant = dueInstant(card.due);
  if (instant !== null) return instant <= now;
  // A day-level card is available for the whole of its due day, which is why
  // the comparison is on the civil day and not on a midnight instant.
  return card.due <= currentDay(now);
}

function currentDay(now: number): string {
  const date = new Date(now);
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/** Cards that can appear at all: not suspended, not orphaned, not buried today. */
export function isEligible(card: Card, day: string): boolean {
  if (card.suspended) return false;
  if (card.orphaned) return false;
  if (card.buriedDay && card.buriedDay === day) return false;
  return true;
}

function inDecks(card: Card, decks?: string[]): boolean {
  return !decks || decks.length === 0 || decks.includes(card.deck);
}

/**
 * Sort key for reviews: lowest recall probability first.
 *
 * The ratio ``elapsed / stability`` is used rather than a computed
 * retrievability because it is monotonic in the same direction, cheaper, and
 * -- unlike retrievability -- never collapses two cards onto the same value
 * when stability is tiny.
 *
 * A card with memory state but a broken or absent ``lastReview`` falls back to
 * its due instant rather than to the same-day floor. Sorting it alongside the
 * cards just answered would push it to the back of the queue, which is exactly
 * wrong for a card that is demonstrably waiting.
 */
function urgency(card: Card, now: number): number {
  const reference = card.lastReview ? Date.parse(card.lastReview) : NaN;
  if (Number.isFinite(reference) && card.stability > 0) {
    return Math.max(0, (now - reference) / 86400000) / card.stability;
  }
  const instant = dueInstant(card.due);
  if (instant !== null) return Math.max(0, (now - instant) / 86400000);
  return 0;
}

export interface QueueInput {
  cards: Card[];
  /** Full review history; only entries for ``day`` are counted. */
  reviews: ReviewEntry[];
  options: QueueOptions;
  /** Per-deck limits are overridden by explicit options when present. */
  decks?: Deck[];
}

export function buildQueue(input: QueueInput): QueuePlan {
  const { cards, reviews, options } = input;
  const decks = options.decks ?? [];
  const answeredToday = new Set(options.answeredToday ?? []);
  // `undefined` and an empty set mean different things: no restriction at all,
  // versus "restrict to nothing". `new Set(undefined)` is empty, so the
  // distinction has to be made here rather than by the filter below.
  const only = options.onlyWrong === undefined ? null : new Set(options.onlyWrong);
  const inScope = cards.filter(
    (card) =>
      isEligible(card, options.day) &&
      inDecks(card, decks) &&
      (only === null || only.has(card.id)) &&
      !answeredToday.has(card.id),
  );

  const learning: Card[] = [];
  const review: Card[] = [];
  const fresh: Card[] = [];
  for (const card of inScope) {
    if (!options.allowNotDue && !isDue(card, options.now)) continue;
    if (card.state === "learning" || card.state === "relearning") learning.push(card);
    else if (card.state === "review") review.push(card);
    else fresh.push(card);
  }

  const byDue = (a: Card, b: Card): number => {
    const left = dueInstant(a.due) ?? 0;
    const right = dueInstant(b.due) ?? 0;
    if (left !== right) return left - right;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  // Learning steps are ordered by when they are due, always: the step's timing is
  // the algorithm's business, and a preference about ordering must not be able to
  // push a card that is 40 seconds from being forgotten behind one that is 10
  // minutes out.
  learning.sort(byDue);

  const sorter = options.sorter;
  if (!sorter) {
    review.sort((a, b) => {
      const delta = urgency(a, options.now) - urgency(b, options.now);
      if (delta !== 0) return delta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    // New cards keep a stable, deliberate order: by id, so the same card is
    // always "next".
    fresh.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else {
    review.sort((a, b) =>
      compareKeys(
        reviewSortKey(a, sorter.reviewOrder, sorter.salt, options.now),
        reviewSortKey(b, sorter.reviewOrder, sorter.salt, options.now),
        a.id,
        b.id,
      ),
    );
    fresh.sort((a, b) =>
      compareKeys(
        newSortKey(a, sorter.newOrder, sorter.salt),
        newSortKey(b, sorter.newOrder, sorter.salt),
        a.id,
        b.id,
      ),
    );
  }

  const doneToday = reviews.filter((entry) => entry.day === options.day && !entry.undone);
  const reviewsDone = doneToday.length;
  const newDone = doneToday.filter((entry) => entry.stateBefore === "new").length;

  const newLimit = options.newLimit ?? sumLimits(input.decks, decks, "newPerDay");
  const reviewLimit = options.reviewLimit ?? sumLimits(input.decks, decks, "reviewsPerDay");

  // Learning steps are never cut off by the daily limits: they are minutes
  // away from being forgotten, and hiding them is what makes a scheduler feel
  // unresponsive.
  const reviewRoom = Math.max(0, reviewLimit - (reviewsDone - newDone));
  const newRoom = Math.max(0, newLimit - newDone);

  const admittedReviews = review.slice(0, reviewRoom);
  const admittedNew = fresh.slice(0, newRoom);

  const counts: QueueCounts = {
    new: admittedNew.length,
    learning: learning.length,
    review: admittedReviews.length,
    total: admittedNew.length + learning.length + admittedReviews.length,
  };

  return {
    order: [...learning, ...admittedReviews, ...admittedNew].map((card) => card.id),
    counts,
    limits: { new: newLimit, review: reviewLimit },
    progress: { reviewsDone: reviewsDone - newDone, newDone },
    // Remaining is the *headroom for the rest of the day*, not the size of
    // this plan. Conflating the two is how a UI ends up telling the user "0
    // left" while it is handing them cards, or promising cards it will not
    // serve: the answer must be "how many more are allowed today", measured
    // against what has already been answered.
    remaining: {
      new: newLimit - newDone,
      review: reviewLimit - (reviewsDone - newDone),
    },
  };
}

function sumLimits(decks: Deck[] | undefined, scope: string[], field: keyof Deck): number {
  if (!decks || decks.length === 0) return Number.POSITIVE_INFINITY;
  const selected = scope.length ? decks.filter((deck) => scope.includes(deck.id)) : decks;
  if (selected.length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (const deck of selected) {
    const value = deck[field];
    if (typeof value === "number") total += value;
    else return Number.POSITIVE_INFINITY;
  }
  return total;
}

/**
 * Why the queue is empty -- three states that look identical but mean
 * completely different things to the person waiting.
 */
export function emptyReason(plan: QueuePlan, now: number): EmptyReason {
  if (plan.counts.learning > 0) return "learning-soon";
  if (plan.remaining.new <= 0 && plan.counts.new === 0 && plan.remaining.review <= 0) {
    return "quota-reached";
  }
  void now;
  return "nothing-due";
}