import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVITY_GOAL,
  buildDays,
  daysForGoal,
  daysSince,
  goalIds,
  levelForTotal,
  mergeEvents,
  recentWindow,
  summarize,
  totalsByDay,
} from "../.build/checkin.js";

/** A valid event, so each test only states the field it is about. */
function event(day, goalId, count, source) {
  return { day, goalId, count, source };
}

test("events from several sources land on one day", () => {
  const merged = mergeEvents([
    event("2026-03-01", ACTIVITY_GOAL, 12, "review"),
    event("2026-03-01", "t1", 1, "task"),
    event("2026-03-01", ACTIVITY_GOAL, 2, "manual"),
  ]);
  const day = merged.get("2026-03-01");
  assert.equal(day?.reviews, 12);
  assert.equal(day?.tasks, 1);
  assert.equal(day?.manual, 2);
  assert.equal(day?.total, 15);
  assert.equal(day?.hit, true);
});

test("two events with the same goal on one day are not double-counted as goals", () => {
  // The count adds up (two reviews are two reviews) but the goal is listed once:
  // a goal is satisfied or it is not, and repeating it would inflate any
  // "how many goals did I hit" count built on top of this.
  const merged = mergeEvents([
    event("2026-03-01", "t1", 3, "task"),
    event("2026-03-01", "t1", 4, "task"),
  ]);
  const day = merged.get("2026-03-01");
  assert.equal(day?.tasks, 7);
  assert.deepEqual(day?.goals, ["t1"]);
});

test("goals come back deduplicated and sorted", () => {
  const merged = mergeEvents([
    event("2026-03-01", "zebra", 1, "task"),
    event("2026-03-01", "alpha", 1, "task"),
    event("2026-03-01", "zebra", 1, "review"),
  ]);
  assert.deepEqual(merged.get("2026-03-01")?.goals, ["alpha", "zebra"]);
});

test("a malformed day is dropped rather than inventing a column in the grid", () => {
  const merged = mergeEvents([
    event("2026-3-1", "t1", 1, "task"),
    event("", "t1", 1, "task"),
    event("not a day", "t1", 1, "task"),
    event("2026-03-02", "t1", 1, "task"),
  ]);
  assert.deepEqual([...merged.keys()], ["2026-03-02"]);
});

test("a zero or negative count is not an event", () => {
  // Otherwise a source that reports "0 reviews today" would count as a check-in
  // and every day of the year would be green.
  const merged = mergeEvents([
    event("2026-03-01", "t1", 0, "task"),
    event("2026-03-02", "t1", -5, "task"),
    event("2026-03-03", "t1", 1, "task"),
  ]);
  assert.deepEqual([...merged.keys()], ["2026-03-03"]);
});

test("a non-numeric count is not an event", () => {
  const bad = { day: "2026-03-01", goalId: "t1", count: "lots", source: "task" };
  assert.equal(mergeEvents([bad]).size, 0);
});

test("an empty goal id falls back to plain activity", () => {
  const merged = mergeEvents([event("2026-03-01", "", 1, "task")]);
  assert.deepEqual(merged.get("2026-03-01")?.goals, [ACTIVITY_GOAL]);
});

test("an unknown source is counted as manual rather than dropped", () => {
  // A future source name must not silently vanish from the totals: undercounting
  // is the failure that a user cannot see.
  const odd = { day: "2026-03-01", goalId: "t1", count: 2, source: "future" };
  const day = mergeEvents([odd]).get("2026-03-01");
  assert.equal(day?.total, 2);
  assert.equal(day?.manual, 2);
});

test("buildDays fills every day in the range, including the empty ones", () => {
  const days = buildDays([event("2026-03-01", "t1", 1, "task"), event("2026-03-03", "t1", 2, "task")], "2026-03-01", "2026-03-04");
  assert.deepEqual(days.map((day) => day.day), ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"]);
  assert.deepEqual(days.map((day) => day.total), [1, 0, 2, 0]);
  assert.deepEqual(days.map((day) => day.hit), [true, false, true, false]);
});

test("buildDays includes days before the first event, so a gap at the start is visible", () => {
  const days = buildDays([event("2026-03-05", "t1", 1, "task")], "2026-03-01", "2026-03-05");
  assert.equal(days.length, 5);
  assert.deepEqual(days.map((day) => day.hit), [false, false, false, false, true]);
});

test("buildDays yields nothing for an inverted or malformed range instead of throwing", () => {
  assert.deepEqual(buildDays([], "2026-03-05", "2026-03-01"), []);
  assert.deepEqual(buildDays([], "nope", "2026-03-01"), []);
  assert.deepEqual(buildDays([], "2026-03-01", "nope"), []);
});

test("buildDays survives a single-day range", () => {
  const days = buildDays([event("2026-03-01", "t1", 1, "task")], "2026-03-01", "2026-03-01");
  assert.equal(days.length, 1);
  assert.equal(days[0].hit, true);
});

test("buildDays crosses a month and a leap day without skipping", () => {
  const days = buildDays([], "2028-02-27", "2028-03-02");
  assert.deepEqual(days.map((day) => day.day), ["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02"]);
});

test("totalsByDay keys every day, including the zeroes", () => {
  const totals = totalsByDay(buildDays([event("2026-03-02", "t1", 4, "task")], "2026-03-01", "2026-03-03"));
  assert.deepEqual(totals, { "2026-03-01": 0, "2026-03-02": 4, "2026-03-03": 0 });
});

test("daysForGoal keeps only that goal's days", () => {
  const events = [
    event("2026-03-01", "words", 1, "task"),
    event("2026-03-02", "review", 30, "review"),
    event("2026-03-03", "words", 1, "task"),
  ];
  assert.deepEqual(daysForGoal(events, "words"), ["2026-03-01", "2026-03-03"]);
  assert.deepEqual(daysForGoal(events, "nothing"), []);
});

test("daysForGoal lists a day once even when it was hit several times", () => {
  const events = [
    event("2026-03-01", "words", 1, "task"),
    event("2026-03-01", "words", 2, "task"),
  ];
  assert.deepEqual(daysForGoal(events, "words"), ["2026-03-01"]);
});

test("goalIds are ordered by most recently active, not alphabetically", () => {
  const events = [
    event("2026-03-01", "old", 1, "task"),
    event("2026-03-09", "recent", 1, "task"),
    event("2026-03-05", "middle", 1, "task"),
  ];
  assert.deepEqual(goalIds(events), ["recent", "middle", "old"]);
});

test("goalIds ignores events that are not real contributions", () => {
  const events = [event("2026-03-01", "ghost", 0, "task"), event("2026-03-02", "real", 1, "task")];
  assert.deepEqual(goalIds(events), ["real"]);
});

test("levelForTotal is zero only when nothing happened", () => {
  assert.equal(levelForTotal(0, 1), 0);
  assert.equal(levelForTotal(-3, 1), 0);
  assert.equal(levelForTotal(Number.NaN, 1), 0);
});

test("with the default goal of 1, any activity is a full day", () => {
  // The default matters: a user who never opens the settings must see a met
  // goal as the darkest shade, not as the palest one.
  assert.equal(levelForTotal(1, 1), 4);
  assert.equal(levelForTotal(500, 1), 4);
});

test("a goal of 40 puts the agreed thresholds at 10/20/30/40", () => {
  assert.equal(levelForTotal(1, 40), 1);
  assert.equal(levelForTotal(10, 40), 1);
  assert.equal(levelForTotal(11, 40), 2);
  assert.equal(levelForTotal(20, 40), 2);
  assert.equal(levelForTotal(21, 40), 3);
  assert.equal(levelForTotal(30, 40), 3);
  assert.equal(levelForTotal(31, 40), 4);
  assert.equal(levelForTotal(40, 40), 4);
  assert.equal(levelForTotal(90, 40), 4);
});

test("the four filled shades are all reachable before the goal is met", () => {
  // Partial progress has to be visible, or a day at 90% of the goal would look
  // exactly like a day at 30%.
  const levels = new Set([1, 2, 3].map((n) => levelForTotal(n, 4)));
  assert.deepEqual([...levels].sort(), [1, 2, 3]);
});

test("a nonsense goal falls back to 1 rather than dividing by zero", () => {
  assert.equal(levelForTotal(1, 0), 4);
  assert.equal(levelForTotal(1, -5), 4);
  assert.equal(levelForTotal(1, Number.NaN), 4);
});

test("summarize counts hits over elapsed days only", () => {
  // 2026-03-05 is "today", so the two future days must not count against the
  // coverage: a grid covering the rest of the year would otherwise report a
  // success rate near zero to someone who has not missed a day.
  const days = buildDays(
    [event("2026-03-01", "t1", 1, "task"), event("2026-03-03", "t1", 1, "task")],
    "2026-03-01",
    "2026-03-07",
  );
  const summary = summarize(days, "2026-03-05", 1);
  assert.equal(summary.days, 7);
  assert.equal(summary.hitDays, 2);
  assert.equal(summary.total, 2);
  assert.equal(summary.goal, 1);
  assert.equal(summary.coverage, 2 / 5);
});

test("summarize reports zero coverage rather than NaN when nothing has elapsed", () => {
  const days = buildDays([], "2026-04-01", "2026-04-03");
  assert.equal(summarize(days, "2026-03-01", 1).coverage, 0);
});

test("recentWindow ends on today and has exactly the asked-for length", () => {
  const { start, end } = recentWindow("2026-03-15", 30);
  assert.equal(end, "2026-03-15");
  assert.equal(start, "2026-02-14");
  assert.equal(buildDays([], start, end).length, 30);
});

test("recentWindow of one day is just today", () => {
  assert.deepEqual(recentWindow("2026-03-15", 1), { start: "2026-03-15", end: "2026-03-15" });
});

test("recentWindow clamps a nonsense count instead of producing a broken range", () => {
  assert.deepEqual(recentWindow("2026-03-15", 0), { start: "2026-03-15", end: "2026-03-15" });
  assert.deepEqual(recentWindow("2026-03-15", Number.NaN), { start: "2026-03-15", end: "2026-03-15" });
});

test("recentWindow crosses a year boundary correctly", () => {
  assert.deepEqual(recentWindow("2026-01-02", 5), { start: "2025-12-29", end: "2026-01-02" });
});

test("daysSince measures the gap, not the date", () => {
  assert.equal(daysSince("2026-03-01", "2026-03-04"), 3);
  assert.equal(daysSince("2026-03-04", "2026-03-04"), 0);
});

test("daysSince is null for never rather than a large number", () => {
  // A null is what lets the pane say "not started yet" instead of "5200 days
  // ago", which the epoch would imply.
  assert.equal(daysSince(null, "2026-03-04"), null);
  assert.equal(daysSince("", "2026-03-04"), null);
  assert.equal(daysSince("nope", "2026-03-04"), null);
});
