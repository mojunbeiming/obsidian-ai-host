import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDays,
  dayOfInstant,
  daysBetween,
  eachDay,
  isoWeekday,
  isDay,
  isoTimestamp,
  localDay,
  parseDay,
  startOfWeek,
  today,
  weekdayIndex,
} from "../.build/clock.js";

test("localDay pads to YYYY-MM-DD and uses local, not UTC, components", () => {
  // A date constructed in local time must render as that same local date, no
  // matter what the machine's offset is. Using toISOString here would shift a
  // late-evening review into the next day west of Greenwich.
  assert.equal(localDay(new Date(2026, 2, 4, 23, 30)), "2026-03-04");
  assert.equal(localDay(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
});

test("today defaults to the current local day", () => {
  assert.equal(today(new Date(2026, 8, 11, 12)), "2026-09-11");
});

test("dayOfInstant converts an epoch to a civil day", () => {
  const ms = new Date(2026, 2, 4, 9, 15).getTime();
  assert.equal(dayOfInstant(ms), "2026-03-04");
});

test("isDay rejects malformed and impossible days", () => {
  assert.equal(isDay("2026-03-04"), true);
  assert.equal(isDay("2028-02-29"), true); // leap year
  assert.equal(isDay("2026-02-29"), false); // not a leap year
  assert.equal(isDay("2026-13-01"), false);
  assert.equal(isDay("2026-04-31"), false);
  assert.equal(isDay("2026-3-04"), false);
  assert.equal(isDay(""), false);
  assert.equal(isDay(20260304), false);
});

test("parseDay round-trips and reports NaN for junk", () => {
  assert.equal(localDay(parseDay("2026-03-04")), "2026-03-04");
  assert.ok(Number.isNaN(parseDay("nonsense").getTime()));
});

test("addDays crosses month, year and leap boundaries", () => {
  assert.equal(addDays("2026-03-04", 1), "2026-03-05");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(addDays("2026-03-04", 0), "2026-03-04");
});

test("addDays is not tripped by daylight-saving transitions", () => {
  // Walking day by day over a DST boundary must not skip or repeat a day.
  let cursor = "2026-03-07";
  for (let i = 0; i < 4; i += 1) cursor = addDays(cursor, 1);
  assert.equal(cursor, "2026-03-11");
});

test("daysBetween is signed and whole", () => {
  assert.equal(daysBetween("2026-03-04", "2026-03-04"), 0);
  assert.equal(daysBetween("2026-03-04", "2026-03-06"), 2);
  assert.equal(daysBetween("2026-03-06", "2026-03-04"), -2);
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);
  assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2);
});

test("weekdayIndex is Sunday-first and isoWeekday is Monday-first", () => {
  assert.equal(weekdayIndex("2026-03-08"), 0); // Sunday
  assert.equal(weekdayIndex("2026-03-02"), 1); // Monday
  assert.equal(isoWeekday("2026-03-02"), 0); // Monday
  assert.equal(isoWeekday("2026-03-08"), 6); // Sunday
});

test("startOfWeek handles both conventions and is idempotent", () => {
  assert.equal(startOfWeek("2026-03-04", 0), "2026-03-01"); // Sunday-start
  assert.equal(startOfWeek("2026-03-04", 1), "2026-03-02"); // Monday-start
  assert.equal(startOfWeek("2026-03-01", 0), "2026-03-01");
  assert.equal(startOfWeek(startOfWeek("2026-03-04", 1), 1), "2026-03-02");
});

test("eachDay is inclusive at both ends", () => {
  assert.deepEqual([...eachDay("2026-03-01", "2026-03-04")], [
    "2026-03-01",
    "2026-03-02",
    "2026-03-03",
    "2026-03-04",
  ]);
  assert.deepEqual([...eachDay("2026-03-01", "2026-03-01")], ["2026-03-01"]);
  assert.deepEqual([...eachDay("2026-03-04", "2026-03-01")], []);
});

test("eachDay yields a whole leap year", () => {
  assert.equal([...eachDay("2028-01-01", "2028-12-31")].length, 366);
});

test("isoTimestamp keeps second precision", () => {
  const stamp = isoTimestamp(new Date(Date.UTC(2026, 2, 4, 1, 2, 3, 456)));
  assert.equal(stamp, "2026-03-04T01:02:03Z");
});

