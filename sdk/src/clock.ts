/**
 * Time handling.
 *
 * Every quantity in this project is derived from a "civil day" -- the date the
 * user perceives -- rather than from a UTC instant. Mixing the two is the
 * single richest source of off-by-one-day bugs in a study tracker: a review at
 * 23:30 local time is a different day from the same review at 00:30, and a
 * heat grid built on UTC day boundaries silently shifts by one column for
 * anyone east or west of Greenwich.
 *
 * So the rules are:
 *
 * * a day is always a ``YYYY-MM-DD`` string, never a Date;
 * * a sub-day moment is always a full ISO-8601 UTC instant;
 * * the two never get converted into each other implicitly.
 *
 * ``clock.ts`` is intentionally free of any Obsidian import so it can be unit
 * tested with plain ``node --test``.
 */

const MS_PER_DAY = 86400000;

/** Local (not UTC) ``YYYY-MM-DD`` for a Date. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Today's civil day in the machine's local time zone. */
export function today(now: Date = new Date()): string {
  return localDay(now);
}

/** Local civil day for a millisecond epoch. */
export function dayOfInstant(ms: number): string {
  return localDay(new Date(ms));
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDay(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = DAY_RE.exec(value);
  if (!match) return false;
  return isValidYmd(Number(match[1]), Number(match[2]), Number(match[3]));
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

/** ``YYYY-MM-DD`` to a **local** midnight Date. */
export function parseDay(day: string): Date {
  const match = DAY_RE.exec(day);
  if (!match) return new Date(NaN);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function addDays(day: string, count: number): string {
  const date = parseDay(day);
  if (Number.isNaN(date.getTime())) return day;
  date.setDate(date.getDate() + count);
  return localDay(date);
}

/** Whole days from ``a`` to ``b`` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  const start = parseDay(a);
  const end = parseDay(b);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

/** 0 = Sunday .. 6 = Saturday: the heat grids put each day at its own row. */
export function weekdayIndex(day: string): number {
  const date = parseDay(day);
  if (Number.isNaN(date.getTime())) return 0;
  return date.getDay();
}

/** 0 = Monday .. 6 = Sunday, the ISO convention used for study-week math. */
export function isoWeekday(day: string): number {
  return (weekdayIndex(day) + 6) % 7;
}

export function* eachDay(start: string, end: string): Generator<string> {
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 40000) {
    yield cursor;
    cursor = addDays(cursor, 1);
    guard += 1;
  }
}

/** Day of the week that starts the week containing ``day``. */
export function startOfWeek(day: string, weekStart: 0 | 1 = 0): string {
  const index = weekdayIndex(day);
  const delta = weekStart === 0 ? index : (index + 6) % 7;
  return addDays(day, -delta);
}


/** ISO-8601 UTC instant with second precision (learning-step due times). */
export function isoTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A timestamp's moment as an epoch value, accepting both the second-precision
 * strings this project writes and full-millisecond ISO strings from elsewhere.
 */
export function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export const MS_PER_MINUTE = 60000;
export const MS_PER_HOUR = 3600000;
export const MINUTES_PER_DAY = 1440;
export const DAY_MS = MS_PER_DAY;