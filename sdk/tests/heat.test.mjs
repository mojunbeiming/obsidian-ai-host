import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWeekGrid, buildYearGrid, daysInYear, levelFor, preferredYear, streakFrom } from "../.build/heat.js";

const TODAY = "2026-09-11";

test("levelFor gives zero plus four equal bands", () => {
  assert.equal(levelFor(0), 0);
  assert.equal(levelFor(-3), 0);
  assert.equal(levelFor(1), 1);
  assert.equal(levelFor(9), 1);
  assert.equal(levelFor(10), 2);
  assert.equal(levelFor(19), 2);
  assert.equal(levelFor(20), 3);
  assert.equal(levelFor(29), 3);
  assert.equal(levelFor(30), 4);
  assert.equal(levelFor(10_000), 4);
  assert.equal(levelFor(NaN), 0);
});

test("the grid starts on a Sunday and every column has exactly seven rows", () => {
  const values = {};
  for (let day = 1; day <= 31; day += 1) values[`2026-01-${String(day).padStart(2, "0")}`] = 1;
  const grid = buildYearGrid(values, 2026, TODAY);
  // 2026-01-01 is a Thursday, so the first column is padded with Sun..Wed.
  assert.equal(grid.weeks[0].cells.length, 7);
  assert.equal(grid.weeks[0].cells[0].pad, true);
  assert.equal(grid.weeks[0].cells[4].day, "2026-01-01");
  for (const week of grid.weeks) assert.equal(week.cells.length, 7, "ragged column");
});

/** The (week, row) of a given day, so assertions do not hardcode column indices. */
function locate(grid, day) {
  for (let w = 0; w < grid.weeks.length; w += 1) {
    const r = grid.weeks[w].cells.findIndex((cell) => cell.day === day);
    if (r >= 0) return { week: grid.weeks[w], weekIndex: w, row: r };
  }
  return null;
}

test("a day is placed at the row of its own weekday, and only gaps are padded", () => {
  // The property under test is *where* a day lands, not how much padding a
  // column happens to get. A mid-week day must sit at its own row with the
  // earlier weekdays padded -- that is the case a "pad until seven cells"
  // implementation gets wrong by floating the day up.
  const grid = buildYearGrid({ "2026-03-03": 1 }, 2026, TODAY);
  const found = locate(grid, "2026-03-03");
  assert.ok(found, "2026-03-03 is missing from the grid");
  // 2026-03-03 is a Tuesday: row 2, Sunday-first.
  assert.equal(found.row, 2);
  assert.equal(found.week.cells.length, 7);
  // The days before it in the column are real days from earlier in the year,
  // and none of them is padding -- padding is only ever used where the range
  // has no day for a weekday at all.
  assert.equal(found.week.cells[0].pad, false);
  assert.equal(found.week.cells[0].day, "2026-03-01"); // Sunday
  assert.equal(found.week.cells[1].day, "2026-03-02"); // Monday
  assert.equal(found.week.cells[2].day, "2026-03-03"); // Tuesday
  assert.equal(found.week.cells[2].pad, false);
  assert.equal(found.week.cells[6].day, "2026-03-07"); // Saturday
});

test("padding appears only at the start and end, where the range has no day", () => {
  // 2026-01-01 is a Thursday, so the first column is Sunday..Wednesday of
  // padding followed by four real days. 2026-12-31 is a Thursday, so the last
  // column is four real days followed by Friday..Saturday of padding. Those are
  // the only two places a heat grid legitimately has gaps.
  const grid = buildYearGrid({ "2026-01-01": 1, "2026-12-31": 1 }, 2026, TODAY);
  const first = grid.weeks[0];
  assert.equal(first.weekStart, "2026-01-01");
  for (let row = 0; row < 4; row += 1) {
    assert.equal(first.cells[row].pad, true, `leading row ${row} should be padding`);
    assert.equal(first.cells[row].day, "");
  }
  for (let row = 4; row < 7; row += 1) {
    assert.equal(first.cells[row].pad, false, `leading row ${row} should be a real day`);
  }

  const last = grid.weeks[grid.weeks.length - 1];
  // 2026-12-31 is the Thursday of that column, so Friday and Saturday are the
  // two trailing pads.
  assert.equal(last.cells[4].day, "2026-12-31");
  for (let row = 5; row < 7; row += 1) {
    assert.equal(last.cells[row].pad, true, `trailing row ${row} should be padding`);
  }

  // Every column in between is fully real: a day with no activity is a fact
  // about the year, not a gap in the range.
  for (const week of grid.weeks.slice(1, -1)) {
    assert.ok(week.cells.every((cell) => cell.pad === false), week.weekStart);
  }
});

test("each week column starts on a Sunday", () => {
  const grid = buildYearGrid({ "2026-03-01": 5, "2026-03-02": 3 }, 2026, TODAY);
  for (const week of grid.weeks) {
    assert.equal(week.cells.length, 7, "ragged column");
    // Sunday is 0, so a column's weekStart must itself be a Sunday.
    assert.equal(new Date(`${week.weekStart}T00:00:00Z`).getUTCDay(), 0, week.weekStart);
  }
  const found = locate(grid, "2026-03-01");
  assert.equal(found.row, 0);
  assert.equal(locate(grid, "2026-03-02").row, 1);
  assert.equal(locate(grid, "2026-03-01").weekIndex, locate(grid, "2026-03-02").weekIndex);
});

test("gaps between recorded days become real zero cells, not holes", () => {
  const grid = buildYearGrid({ "2026-03-01": 3, "2026-03-07": 4 }, 2026, TODAY);
  assert.equal(grid.cells.length, 7);
  assert.equal(grid.cells[1].value, 0);
  assert.equal(grid.cells[1].pad, false);
  assert.equal(grid.cells[1].day, "2026-03-02");
});

test("days outside the requested year are ignored", () => {
  const grid = buildYearGrid(
    { "2025-12-31": 100, "2026-03-04": 2, "2027-01-01": 99 },
    2026,
    TODAY,
  );
  assert.equal(grid.total, 2);
  assert.ok(grid.cells.every((cell) => !cell.day || cell.day.slice(0, 4) === "2026"));
});

test("a leap year yields a 366th cell", () => {
  const grid = buildYearGrid({ "2028-01-01": 1, "2028-12-31": 1 }, 2028, "2028-12-31");
  assert.equal(grid.cells.length, 366);
  assert.ok(grid.cells.some((cell) => cell.day === "2028-02-29"));
  assert.equal(daysInYear(2028), 366);
  assert.equal(daysInYear(2026), 365);
});

test("an empty year produces an empty grid rather than throwing", () => {
  const grid = buildYearGrid({}, 2026, TODAY);
  assert.deepEqual(grid.weeks, []);
  assert.equal(grid.total, 0);
  assert.equal(grid.max, 0);
});

test("future days are marked and excluded from the total", () => {
  const grid = buildYearGrid({ "2026-09-10": 5, "2026-09-12": 7 }, 2026, TODAY);
  const future = grid.cells.find((cell) => cell.day === "2026-09-12");
  const past = grid.cells.find((cell) => cell.day === "2026-09-10");
  assert.equal(future.future, true);
  assert.equal(past.future, false);
  // A future day has not happened, so counting it would inflate the year.
  assert.equal(grid.total, 5);
});

test("totals, max and daysWithValue describe the year", () => {
  const grid = buildYearGrid(
    { "2026-01-05": 5, "2026-01-06": 40, "2026-01-07": 0 },
    2026,
    TODAY,
  );
  assert.equal(grid.total, 45);
  assert.equal(grid.max, 40);
  assert.equal(grid.daysWithValue, 2);
});

test("month labels appear once per month, in week order", () => {
  const values = {};
  for (let month = 1; month <= 3; month += 1) {
    values[`2026-0${month}-10`] = 1;
  }
  const grid = buildYearGrid(values, 2026, TODAY);
  const months = grid.months.map((entry) => entry.month);
  assert.deepEqual(months, ["2026-01", "2026-02", "2026-03"]);
  // Indices must increase, otherwise a label is drawn over an earlier column.
  for (let i = 1; i < grid.months.length; i += 1) {
    assert.ok(grid.months[i].weekIndex > grid.months[i - 1].weekIndex);
  }
});

test("a full year fits in 53 or 54 columns and never loses a day", () => {
  const values = {};
  for (let day = 1; day <= 31; day += 1) values[`2026-01-${String(day).padStart(2, "0")}`] = 1;
  values["2026-12-31"] = 1;
  const grid = buildYearGrid(values, 2026, TODAY);
  assert.ok(grid.weeks.length >= 53 && grid.weeks.length <= 54, `${grid.weeks.length} columns`);
  const real = grid.cells.filter((cell) => !cell.pad);
  assert.equal(real.length, 365);
});

test("the detail map is attached per day", () => {
  const grid = buildYearGrid({ "2026-03-04": 1 }, 2026, TODAY, { "2026-03-04": "12 contributions" });
  const cell = grid.cells.find((entry) => entry.day === "2026-03-04");
  assert.equal(cell.detail, "12 contributions");
});

test("preferredYear picks the newest year present", () => {
  assert.equal(preferredYear(["2024-01-01", "2026-05-05", "2025-12-31"], 2020), 2026);
  assert.equal(preferredYear([], 2026), 2026);
  assert.equal(preferredYear(["garbage"], 2026), 2026);
});

// --- streaks ---------------------------------------------------------------

test("streakFrom counts consecutive days and tolerates one missed day", () => {
  const info = streakFrom(["2026-03-01", "2026-03-02", "2026-03-04"], "2026-03-04");
  assert.equal(info.current, 3);
  assert.equal(info.checkedInToday, true);
  assert.equal(info.lastDay, "2026-03-04");
});

test("a streak is current even before today's work is done", () => {
  // Opening the app in the morning must not show a zeroed streak.
  const info = streakFrom(["2026-03-02", "2026-03-03"], "2026-03-04");
  assert.equal(info.current, 2);
  assert.equal(info.checkedInToday, false);
});

test("a longer gap resets the current streak but not the longest", () => {
  const days = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-03-04"];
  const info = streakFrom(days, "2026-03-04");
  assert.equal(info.longest, 4);
  assert.equal(info.current, 1);
  assert.equal(info.totalDays, 5);
});

test("maxGapDays 0 restores a strict every-day requirement", () => {
  const strict = streakFrom(["2026-03-01", "2026-03-03"], "2026-03-03", 0);
  assert.equal(strict.current, 1);
  const loose = streakFrom(["2026-03-01", "2026-03-03"], "2026-03-03", 1);
  assert.equal(loose.current, 2);
});

test("duplicate days do not inflate a streak", () => {
  const info = streakFrom(["2026-03-04", "2026-03-04", "2026-03-03"], "2026-03-04");
  assert.equal(info.current, 2);
  assert.equal(info.totalDays, 2);
});

test("an empty history is a zero streak, not an error", () => {
  const info = streakFrom([], "2026-03-04");
  assert.deepEqual(
    { current: info.current, longest: info.longest, totalDays: info.totalDays, lastDay: info.lastDay },
    { current: 0, longest: 0, totalDays: 0, lastDay: null },
  );
  assert.equal(info.daysSinceLast, null);
});

// ---------------------------------------------------------------------------
// The rolling week grid
// ---------------------------------------------------------------------------

test("a week grid is exactly the requested number of columns", () => {
  const grid = buildWeekGrid({}, TODAY, 12);
  assert.equal(grid.weeks.length, 12);
  for (const week of grid.weeks) assert.equal(week.cells.length, 7);
});

test("the last column contains today, and its trailing days are marked padding", () => {
  // 2026-09-11 is a Friday, so the column runs Sun..Sat and only Sun..Fri are
  // real. Those trailing cells exist so the grid stays a rectangle; if they were
  // dropped, every row would shift by one each day.
  const grid = buildWeekGrid({}, TODAY, 4);
  const last = grid.weeks[grid.weeks.length - 1];
  assert.deepEqual(
    last.cells.map((cell) => cell.day),
    ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"],
  );
  assert.deepEqual(last.cells.map((cell) => cell.pad), [false, false, false, false, false, false, true]);
  // The pad cell keeps its real day, so a renderer can still label the column.
  assert.equal(last.cells[6].future, true);
});

test("the first column starts on a Sunday and is whole", () => {
  const grid = buildWeekGrid({}, TODAY, 2);
  assert.equal(grid.weeks[0].weekStart, "2026-08-30");
  assert.equal(grid.weeks[1].weekStart, "2026-09-06");
});

test("today is always in the same cell position whatever the weekday", () => {
  // The whole point of including the trailing pad cells: a Sunday today and a
  // Saturday today must both land in the last column, so the grid does not
  // change shape during the week.
  for (const day of ["2026-09-06", "2026-09-09", "2026-09-12"]) {
    const grid = buildWeekGrid({}, day, 3);
    const last = grid.weeks[grid.weeks.length - 1];
    const index = last.cells.findIndex((cell) => cell.day === day);
    assert.equal(index, last.cells.findIndex((cell) => cell.day === day), `${day} should be found`);
    assert.ok(index >= 0 && index <= 6, `${day} index ${index} out of range`);
  }
});

test("week grid totals count the real days and ignore the trailing padding", () => {
  const grid = buildWeekGrid({ "2026-09-10": 5, "2026-09-11": 3, "2026-09-12": 99 }, TODAY, 2);
  assert.equal(grid.total, 8);
  assert.equal(grid.max, 5);
  assert.equal(grid.daysWithValue, 2);
});

test("week grid marks a future day inside the window as future", () => {
  // There is no future day inside a window that ends today, but the trailing
  // pads must not be mistaken for real days with value 0 either.
  // One column for the week of 2026-09-06 (a Sunday) through 2026-09-12: real days
  // are Sun 06 .. Fri 11, and Saturday 12 is the single trailing pad.
  const grid = buildWeekGrid({}, TODAY, 1);
  const real = grid.cells.filter((cell) => !cell.pad);
  assert.equal(real.length, 6);
  assert.equal(real[real.length - 1].day, TODAY);
  assert.ok(real.every((cell) => !cell.future));
});

test("week grid uses the injected scale", () => {
  const grid = buildWeekGrid({ "2026-09-10": 7 }, TODAY, 1, undefined, () => 4);
  const cell = grid.cells.find((entry) => entry.day === "2026-09-10");
  assert.equal(cell?.level, 4);
});

test("week grid clamps a nonsense week count instead of producing an empty grid", () => {
  assert.equal(buildWeekGrid({}, TODAY, 0).weeks.length, 12);
  assert.equal(buildWeekGrid({}, TODAY, Number.NaN).weeks.length, 12);
  assert.equal(buildWeekGrid({}, TODAY, -4).weeks.length, 12);
});

test("week grid returns an empty grid for a malformed today", () => {
  const grid = buildWeekGrid({}, "not-a-day", 4);
  assert.deepEqual(grid.weeks, []);
  assert.equal(grid.total, 0);
});

test("week grid crosses a year boundary without losing a column", () => {
  const grid = buildWeekGrid({ "2025-12-31": 4 }, "2026-01-02", 2);
  assert.equal(grid.total, 4);
  const days = grid.cells.filter((cell) => !cell.pad).map((cell) => cell.day);
  assert.ok(days.includes("2025-12-31"));
  assert.ok(days.includes("2026-01-02"));
});
