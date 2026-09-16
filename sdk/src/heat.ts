/**
 * Heat grids: one column per week, seven rows Sunday..Saturday.
 *
 * The grid is built here, not in the renderer, for one reason: it is the part
 * that goes wrong. A heat calendar that pads a column merely "until it has
 * seven weeks of cells" floats a Sunday up into row two whenever the range
 * starts mid-week, and an off-by-one row is invisible on screen but wrong for a
 * year. So every day is placed at the row of **its own weekday**, gaps are
 * filled explicitly, and the whole thing is unit tested.
 *
 * Two ranges are built from the same machinery: a full calendar year, and a
 * rolling window of whole weeks ending today. Sunday-first is used for both
 * because the layout is the one people already read at a glance.
 */

import { addDays, daysBetween, isDay, startOfWeek, weekdayIndex } from "./clock";

export const MAX_LEVEL = 4;

/**
 * Default bucketing: zero, then four equal bands.
 *
 * A default rather than a rule -- `buildYearGrid` and `buildWeekGrid` both
 * take a `levelOf` so the check-in grid can scale to the user's own daily goal
 * instead (see `checkin.ts`). Kept here because a plain count grid still needs
 * *some* monotone scale, and an even one is the least surprising.
 */
export function levelFor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value <= 9) return 1;
  if (value <= 19) return 2;
  if (value <= 29) return 3;
  return MAX_LEVEL;
}

export interface HeatCell {
  /** ``YYYY-MM-DD``; empty for a padding cell. */
  day: string;
  value: number;
  level: number;
  /** True when this cell is a placeholder rather than a real day. */
  pad: boolean;
  /** True when the day is in the future relative to ``today``. */
  future: boolean;
  /** Optional second measurement, shown on hover when present. */
  detail?: string;
}

export interface HeatWeek {
  weekStart: string;
  cells: HeatCell[];
}

export interface HeatGrid {
  weeks: HeatWeek[];
  months: { month: string; weekIndex: number }[];
  cells: HeatCell[];
  total: number;
  max: number;
  daysWithValue: number;
}

/**
 * A placeholder for a weekday that has no day in range.
 *
 * Marked ``pad`` so a renderer can leave it empty rather than painting a
 * zero-value cell -- a gap in the range is not the same fact as "no activity
 * that day", and drawing them identically misreads the year.
 */
function padCell(future: boolean): HeatCell {
  return { day: "", value: 0, level: 0, pad: true, future };
}

/** Later of two civil days, compared as strings (which is chronological). */
function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * One real day's cell.
 *
 * Extracted so the year grid and the rolling week grid cannot drift apart: both
 * call this, so a change to how a cell is levelled or marked as future lands in
 * both places or in neither.
 */
function makeCell(
  day: string,
  value: number,
  today: string,
  details: Record<string, string> | undefined,
  levelOf: (value: number) => number,
): HeatCell {
  const cell: HeatCell = {
    day,
    value,
    level: levelOf(value),
    pad: false,
    future: day > today,
  };
  const detail = details?.[day];
  if (detail) cell.detail = detail;
  return cell;
}

interface AssembleOptions {
  /** Label for a padding cell, when the grid pads with a visible zero day. */
  padLabel?: string;
  /** Fold padding cells into the totals, as the rolling week grid must. */
  countPads?: boolean;
}

/**
 * Turn a flat run of cells into a rectangular grid.
 *
 * Every day sits at the row of **its own weekday**, and a column is padded out to
 * seven rows. The alternative -- pushing cells into a column until it has seven
 * of them -- floats a Sunday up into row two whenever the range starts
 * mid-week, which is invisible on screen and wrong for a year.
 */
function assemble(
  cells: HeatCell[],
  cellByDay: Map<string, HeatCell>,
  options: AssembleOptions = {},
): HeatGrid {
  const weeks: HeatWeek[] = [];
  const pad = (): HeatCell =>
    options.padLabel ? { day: options.padLabel, value: 0, level: 0, pad: true, future: true } : padCell(true);
  let current: HeatWeek | null = null;
  for (const cell of cells) {
    const row = weekdayIndex(cell.day);
    if (!current || row === 0) {
      current = { weekStart: cell.day, cells: [] };
      weeks.push(current);
    }
    while (current.cells.length < row) current.cells.push(pad());
    current.cells.push(cell);
  }
  if (current) while (current.cells.length < 7) current.cells.push(pad());

  const months = monthLabels(weeks);

  let total = 0;
  let max = 0;
  let daysWithValue = 0;
  for (const cell of cells) {
    if (cell.future && !options.countPads) continue;
    total += cell.value;
    if (cell.value > max) max = cell.value;
    if (cell.value > 0) daysWithValue += 1;
  }

  void cellByDay;
  return { weeks, months, cells, total, max, daysWithValue };
}

/**
 * One label per month, at the column that contains its first day.
 *
 * The label is placed by the month of the column's own start day, so it can
 * never land mid-month. A month with no column of its own start (a very short
 * window) simply gets no label -- which is correct for a rolling grid, where the
 * first column may begin in the previous month.
 *
 * ``padLabel`` columns are labelled too, because they carry a real ``day``; the
 * falling-back-to-previous-column behaviour the year grid used to have is what
 * this fixes.
 */
function monthLabels(weeks: HeatWeek[], padLabel = ""): { month: string; weekIndex: number }[] {
  const months: { month: string; weekIndex: number }[] = [];
  let seen = "";
  weeks.forEach((week, index) => {
    const day = padLabel && week.weekStart === padLabel ? week.cells[0]?.day ?? "" : week.weekStart;
    const month = day.slice(0, 7);
    if (!month || month === seen) return;
    seen = month;
    months.push({ month, weekIndex: index });
  });
  return months;
}

/**
 * Build a year grid from sparse day records.
 *
 * ``values`` may be missing days entirely -- gaps become zero cells, because a
 * day with no activity is a real fact about the year and not a hole in the
 * data.
 */
export function buildYearGrid(
  values: Record<string, number>,
  year: number,
  today: string,
  details?: Record<string, string>,
  /**
   * Bucketing function, defaulting to `levelFor`'s four equal bands.
   *
   * Injectable because the check-in grid measures something different: a day is
   * "full" when it reached a number the user chooses, and forcing a fixed scale
   * on it would make a met goal look identical to a barely-started day.
   */
  levelOf: (value: number) => number = levelFor,
): HeatGrid {
  const realDays: string[] = [];
  for (const key of Object.keys(values)) {
    if (!isDay(key) || Number(key.slice(0, 4)) !== year) continue;
    realDays.push(key);
  }
  realDays.sort();

  const cells: HeatCell[] = [];
  const cellByDay = new Map<string, HeatCell>();
  if (realDays.length > 0) {
    const first = realDays[0];
    const last = realDays[realDays.length - 1];
    // Extend to whole weeks so the grid is rectangular and every column has
    // seven rows -- but never past the year being drawn. Clamping matters
    // because a first column that starts in December, or a last column that
    // runs into January, would put days from the *neighbouring* year inside
    // this year's grid; the cells are drawn either way, so the only symptom
    // would be a quietly inflated total.
    const rangeStart = `${year}-01-01`;
    const rangeEnd = `${year}-12-31`;
    const from = maxDay(startOfWeek(first, 0), rangeStart);
    const to = minDay(addDays(startOfWeek(last, 0), 6), rangeEnd);
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const cell = makeCell(day, values[day] ?? 0, today, details, levelOf);
      cells.push(cell);
      cellByDay.set(day, cell);
    }
  }

  return assemble(cells, cellByDay);
}

/**
 * A rolling window of whole weeks ending at ``today``.
 *
 * The year grid answers "how did this year go"; this answers "how are the last
 * few weeks going", which is the question a user actually opens a check-in pane
 * with. Two differences from the year grid, both deliberate:
 *
 * * the window is **today-centred** rather than bounded by the calendar, so the
 *   most recent day is always the last real cell;
 * * cells **after today are included as padding**, so the grid is a rectangle
 *   and today is always in the same column position -- a grid that shrank to
 *   today would shift every row each day.
 *
 * Because those trailing cells are padding rather than future days, they are
 * counted in the totals as zeroes. They add nothing, and *not* counting them
 * would make the totals disagree with the grid for no visible reason.
 */
export function buildWeekGrid(
  values: Record<string, number>,
  today: string,
  weekCount: number,
  details?: Record<string, string>,
  levelOf: (value: number) => number = levelFor,
): HeatGrid {
  const weeks = Number.isFinite(weekCount) && weekCount > 0 ? Math.floor(weekCount) : 12;
  const cells: HeatCell[] = [];
  const cellByDay = new Map<string, HeatCell>();
  if (!isDay(today)) return assemble(cells, cellByDay);

  const end = addDays(startOfWeek(today, 0), 6);
  const start = addDays(end, -(weeks * 7 - 1));
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const inWindow = day <= today;
    const cell = makeCell(day, inWindow ? values[day] ?? 0 : 0, today, details, levelOf);
    // Mark the trailing cells as padding, but keep their real ``day``: the
    // renderer uses it to label the column, and the totals fold them in above.
    if (!inWindow) {
      cell.pad = true;
      cell.future = true;
    }
    cells.push(cell);
    cellByDay.set(day, cell);
  }

  return assemble(cells, cellByDay, { countPads: true });
}

/** Inclusive day count of a year, 366 for a leap year. */
export function daysInYear(year: number): number {
  return daysBetween(`${year}-01-01`, `${year}-12-31`) + 1;
}

/** Most recent full year that has data, falling back to the given one. */
export function preferredYear(available: string[], fallback: number): number {
  const years = available
    .map((day) => Number(day.slice(0, 4)))
    .filter((year) => Number.isFinite(year) && year > 1900);
  if (!years.length) return fallback;
  return Math.max(...years);
}

export interface StreakInfo {
  current: number;
  longest: number;
  totalDays: number;
  lastDay: string | null;
  daysSinceLast: number | null;
  checkedInToday: boolean;
}

/**
 * Current and longest streak of days with any activity.
 *
 * Two rules worth stating, because they decide what the number *means*:
 *
 * * a gap of up to ``maxGapDays`` days is tolerated, so one missed day does
 *   not reset a long run;
 * * today does not have to be active yet -- a streak is reported as current
 *   when the last active day was today or within the tolerated gap, so opening
 *   the app in the morning does not show a zeroed streak before studying.
 */
export function streakFrom(activeDays: string[], today: string, maxGapDays = 1): StreakInfo {
  const sorted = [...new Set(activeDays)].filter(isDay).sort();
  const tolerance = maxGapDays + 1;

  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    if (previous !== null && daysBetween(previous, day) <= tolerance) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    previous = day;
  }

  let current = 0;
  if (sorted.length) {
    const last = sorted[sorted.length - 1];
    if (daysBetween(last, today) <= tolerance) {
      current = 1;
      for (let index = sorted.length - 1; index > 0; index -= 1) {
        if (daysBetween(sorted[index - 1], sorted[index]) <= tolerance) current += 1;
        else break;
      }
    }
  }

  const lastDay = sorted.length ? sorted[sorted.length - 1] : null;
  return {
    current,
    longest,
    totalDays: sorted.length,
    lastDay,
    daysSinceLast: lastDay ? daysBetween(lastDay, today) : null,
    checkedInToday: lastDay === today,
  };
}
