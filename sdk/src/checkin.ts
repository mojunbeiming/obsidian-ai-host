/**
 * Check-ins: the one number this project is actually about.
 *
 * A check-in answers "did I do the thing that day?", and the interesting
 * quantity is not the total but the *run* -- how many consecutive days it has
 * been true. Everything in this module exists to make that number honest.
 *
 * ## Why sources are events, not day/count pairs
 *
 * The tempting model is ``Record<day, count>``, merged by summing. It throws away
 * the one thing the second feature needs: **which** thing was done. A user who
 * sets a daily task wants a heat grid and a streak for *that* task, and a merged
 * total cannot reconstruct it. So each source produces ``CheckinEvent``s tagged
 * with a goal, and the per-day view is derived from them. Merging is then
 * additive in the only direction that is safe: it can always recover the
 * per-goal answer, and never the other way round.
 *
 * ## Why a day with no events is a real day
 *
 * ``buildDays`` fills every day in the range, including the ones with nothing.
 * A heat calendar that skips empty days compresses the gap that *is* the
 * information -- and one that leaves the gaps out entirely would report a
 * 40-day streak for someone who studied in March and September.
 *
 * Nothing here imports Obsidian, so every rule above is unit tested directly.
 */

import { addDays, daysBetween, isDay } from "./clock";

/** The three things that can make a day count. */
export type CheckinSource = "review" | "task" | "manual";

/** The goal id used for events that belong to no named goal. */
export const ACTIVITY_GOAL = "activity";

/** One contribution to one day, from one source. */
export interface CheckinEvent {
  /** ``YYYY-MM-DD``, in the user's own time zone. */
  day: string;
  /**
   * Which goal this counted for, or ``ACTIVITY_GOAL`` for plain activity.
   *
   * The todo plugin uses its own todo id, so a recurring task *is* the goal --
   * no second registry of "habits" to keep in step with the tasks that embody
   * them.
   */
  goalId: string;
  /** How many times it happened that day; always >= 1 for a real event. */
  count: number;
  source: CheckinSource;
}

/** One day, after merging every source. */
export interface DayCheckin {
  day: string;
  reviews: number;
  tasks: number;
  manual: number;
  /** ``reviews + tasks + manual``. */
  total: number;
  /** Goal ids that were satisfied that day, deduplicated and sorted. */
  goals: string[];
  /** ``total > 0``: the day counts towards a streak. */
  hit: boolean;
}

function positiveCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count;
}

function goalOf(event: CheckinEvent): string {
  return typeof event.goalId === "string" && event.goalId ? event.goalId : ACTIVITY_GOAL;
}

/** True when this event is a real contribution and not a malformed record. */
function counts(event: CheckinEvent | null | undefined): boolean {
  return !!event && isDay(event.day) && positiveCount(event.count) > 0;
}

/**
 * Fold events into one record per day, keeping goal attribution.
 *
 * An event whose day is not a civil day is dropped: a malformed record must not
 * be allowed to invent a day that the grid would then draw as a real column.
 *
 * Days with no events are **not** included -- this is the sparse merge. Use
 * ``buildDays`` when a dense, gap-filled range is what is wanted.
 */
export function mergeEvents(events: CheckinEvent[]): Map<string, DayCheckin> {
  const byDay = new Map<string, DayCheckin>();
  for (const event of events) {
    if (!counts(event)) continue;
    if (event === null || event === undefined) continue;
    const count = positiveCount(event.count);
    let entry = byDay.get(event.day);
    if (!entry) {
      entry = { day: event.day, reviews: 0, tasks: 0, manual: 0, total: 0, goals: [], hit: false };
      byDay.set(event.day, entry);
    }
    if (event.source === "review") entry.reviews += count;
    else if (event.source === "task") entry.tasks += count;
    else entry.manual += count;
    entry.total += count;
    const goalId = goalOf(event);
    if (!entry.goals.includes(goalId)) entry.goals.push(goalId);
  }
  for (const entry of byDay.values()) {
    entry.goals.sort();
    entry.hit = entry.total > 0;
  }
  return byDay;
}

/**
 * Every day from ``start`` to ``end``, gaps filled with zeroes.
 *
 * Gaps are filled here rather than by the caller so the streak and the grid can
 * never disagree about which days exist: both are derived from this same array.
 * An inverted or malformed range yields an empty array rather than a throw,
 * because "nothing to show yet" is a normal state for a fresh vault.
 */
export function buildDays(events: CheckinEvent[], start: string, end: string): DayCheckin[] {
  if (!isDay(start) || !isDay(end) || start > end) return [];
  const byDay = mergeEvents(events);
  const out: DayCheckin[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    out.push(
      byDay.get(day) ?? { day, reviews: 0, tasks: 0, manual: 0, total: 0, goals: [], hit: false },
    );
  }
  return out;
}

/** ``YYYY-MM-DD`` -> total, for a grid. Days that missed are present as 0. */
export function totalsByDay(days: DayCheckin[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const day of days) out[day.day] = day.total;
  return out;
}

/** The days a single goal was satisfied. Feed this to ``streakFrom``. */
export function daysForGoal(events: CheckinEvent[], goalId: string): string[] {
  const days: string[] = [];
  for (const event of events) {
    if (!counts(event)) continue;
    if (goalOf(event) !== goalId) continue;
    if (!days.includes(event.day)) days.push(event.day);
  }
  return days;
}

/** Goal ids seen in the events, most recently active first. */
export function goalIds(events: CheckinEvent[]): string[] {
  const lastSeen = new Map<string, string>();
  for (const event of events) {
    if (!counts(event)) continue;
    const goalId = goalOf(event);
    const previous = lastSeen.get(goalId);
    if (previous === undefined || event.day > previous) lastSeen.set(goalId, event.day);
  }
  return [...lastSeen.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([id]) => id);
}

/**
 * Bucket a day's total into one of the five shades.
 *
 * Deliberately **not** GitHub's fixed ``1-9 / 10-19 / 20-29 / 30+`` scale.
 * Those buckets answer "how much public contribution did you make", and that is
 * the wrong question here: someone whose whole goal is one review a day would
 * sit in the palest shade forever, and a day that met the goal would look
 * identical to a day that barely started. So the scale is relative to *your*
 * daily goal, and ``goal = 1`` (the default) means "any activity at all is a
 * full day".
 *
 * The four filled shades are reachable at 1/4, 1/2, 3/4 and all of the goal, so
 * partial progress is visible rather than being rounded away.
 */
export function levelForTotal(total: number, goal: number): number {
  const count = positiveCount(total);
  if (!count) return 0;
  const target = Number.isFinite(goal) && goal > 0 ? goal : 1;
  if (count >= target) return 4;
  return Math.max(1, Math.min(4, Math.ceil((count / target) * 4)));
}

/** The headline numbers for a range, for the summary row above a grid. */
export interface CheckinSummary {
  days: number;
  hitDays: number;
  total: number;
  goal: number;
  /** Hits as a fraction of the days that have already happened; 0 when none. */
  coverage: number;
}

/**
 * Hits, and hits as a share of the days that have already happened.
 *
 * Future days are excluded from the denominator: a grid for the current year
 * contains 300-odd days that have not arrived, and counting them would report a
 * 5% success rate to someone who has not missed a day yet.
 */
export function summarize(days: DayCheckin[], today: string, goal: number): CheckinSummary {
  let hitDays = 0;
  let total = 0;
  let elapsed = 0;
  for (const day of days) {
    total += day.total;
    if (day.hit) hitDays += 1;
    if (day.day <= today) elapsed += 1;
  }
  return {
    days: days.length,
    hitDays,
    total,
    goal,
    coverage: elapsed > 0 ? hitDays / elapsed : 0,
  };
}

/**
 * The most recent ``count`` days ending at ``today``, inclusive.
 *
 * The window includes today on purpose: a "last 30 days" strip that ended
 * yesterday would hide the day the user just finished, which is the one they
 * opened the pane to check.
 */
export function recentWindow(today: string, count: number): { start: string; end: string } {
  const span = Number.isFinite(count) && count > 1 ? Math.floor(count) : 1;
  return { start: addDays(today, -(span - 1)), end: today };
}

/**
 * How many days ago a goal was last satisfied, or null when never.
 *
 * Feeds the "last time was N days ago" note next to a broken streak, which is
 * the part a user can act on: a zero streak reads as failure, while a concrete
 * date reads as recoverable.
 */
export function daysSince(day: string | null, today: string): number | null {
  if (!day || !isDay(day) || !isDay(today)) return null;
  return daysBetween(day, today);
}
