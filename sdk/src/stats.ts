/**
 * Aggregates over the review log.
 *
 * The log is append-only and never rewritten, so every number here is derived
 * rather than stored. That removes a whole class of bug: there is no counter to
 * drift out of sync with reality after a crash or an undo.
 */

import { addDays, daysBetween, eachDay } from "./clock";
import type { Card, ReviewEntry } from "./types";

export type DayActivity = {
  day: string;
  /** Answers recorded that day. */
  cards: number;
  /** Of those, how many were on a card that was new. */
  newCards: number;
  /** Answers rated "again". */
  lapses: number;
  minutes: number;
  accuracy: number;
  /** Duration sum, capped per answer so an idle tab cannot skew the number. */
  seconds: number;
};

/** A single answer longer than this is treated as "walked away", not "thought
 * hard", because including it would make the minutes readout meaningless. */
export const MAX_ANSWER_SECONDS = 180;

export function dailyActivity(
  reviews: ReviewEntry[],
  start: string,
  end: string,
): DayActivity[] {
  const buckets = new Map<string, { cards: number; newCards: number; lapses: number; seconds: number }>();
  for (const entry of reviews) {
    if (entry.undone) continue;
    if (entry.day < start || entry.day > end) continue;
    const bucket = buckets.get(entry.day) ?? { cards: 0, newCards: 0, lapses: 0, seconds: 0 };
    bucket.cards += 1;
    if (entry.stateBefore === "new") bucket.newCards += 1;
    if (entry.rating === 1) bucket.lapses += 1;
    bucket.seconds += Math.min(MAX_ANSWER_SECONDS, Math.max(0, entry.durationMs / 1000));
    buckets.set(entry.day, bucket);
  }

  // Gaps are filled with explicit zero days so the caller never has to reason
  // about missing keys, which is where heat calendars usually go off by one.
  const out: DayActivity[] = [];
  for (const day of eachDay(start, end)) {
    const bucket = buckets.get(day);
    if (!bucket) {
      out.push({ day, cards: 0, newCards: 0, lapses: 0, minutes: 0, accuracy: 0, seconds: 0 });
      continue;
    }
    out.push({
      day,
      cards: bucket.cards,
      newCards: bucket.newCards,
      lapses: bucket.lapses,
      minutes: Math.round((bucket.seconds / 60) * 10) / 10,
      accuracy: bucket.cards ? 1 - bucket.lapses / bucket.cards : 0,
      seconds: Math.round(bucket.seconds),
    });
  }
  return out;
}

export type CollectionSummary = {
  total: number;
  new: number;
  learning: number;
  review: number;
  suspended: number;
  orphaned: number;
  due: number;
};

export function collectionSummary(cards: Card[], day: string, isDue: (card: Card) => boolean): CollectionSummary {
  const summary: CollectionSummary = {
    total: 0, new: 0, learning: 0, review: 0, suspended: 0, orphaned: 0, due: 0,
  };
  for (const card of cards) {
    summary.total += 1;
    if (card.suspended) summary.suspended += 1;
    if (card.orphaned) summary.orphaned += 1;
    switch (card.state) {
      case "new": summary.new += 1; break;
      case "learning":
      case "relearning": summary.learning += 1; break;
      case "review": summary.review += 1; break;
      default: break;
    }
    if (!card.suspended && !card.orphaned && isDue(card)) summary.due += 1;
  }
  void day;
  return summary;
}

/**
 * Retention over a window: the share of answers that were not "again".
 *
 * Undone answers are excluded, because including them would double-count a
 * mistake the user already corrected.
 */
export function retention(reviews: ReviewEntry[], days: number, today: string): {
  days: number;
  reviews: number;
  correct: number;
  retention: number;
} {
  const start = addDays(today, -(days - 1));
  let total = 0;
  let correct = 0;
  for (const entry of reviews) {
    if (entry.undone) continue;
    if (entry.day < start || entry.day > today) continue;
    if (entry.stateBefore === "new") continue;
    total += 1;
    if (entry.rating !== 1) correct += 1;
  }
  return {
    days,
    reviews: total,
    correct,
    retention: total ? correct / total : 0,
  };
}


/** Upcoming due counts per day, for the forecast strip. */
export function forecast(cards: Card[], today: string, horizonDays: number): { day: string; due: number }[] {
  const buckets = new Map<string, number>();
  for (const card of cards) {
    if (card.suspended || card.orphaned) continue;
    const day = card.due.slice(0, 10);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  const out: { day: string; due: number }[] = [];
  for (let offset = 0; offset < horizonDays; offset += 1) {
    const day = addDays(today, offset);
    const due = (buckets.get(day) ?? 0) + (offset === 0 ? overdueCount(cards, today) : 0);
    out.push({ day, due });
  }
  return out;
}

function overdueCount(cards: Card[], today: string): number {
  let count = 0;
  for (const card of cards) {
    if (card.suspended || card.orphaned) continue;
    if (card.due.slice(0, 10) < today) count += 1;
  }
  return count;
}

void daysBetween;