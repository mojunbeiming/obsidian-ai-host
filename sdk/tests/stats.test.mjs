import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_ANSWER_SECONDS,
  collectionSummary,
  dailyActivity,
  forecast,
  retention,
} from "../.build/stats.js";
import { card, review } from "./_fs.mjs";

test("dailyActivity fills gaps with explicit zero days", () => {
  // Callers must never have to reason about missing keys; that is where heat
  // calendars develop off-by-one bugs.
  const rows = dailyActivity([review({ day: "2026-03-04" })], "2026-03-02", "2026-03-05");
  assert.deepEqual(rows.map((row) => row.day), ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
  assert.equal(rows[0].cards, 0);
  assert.equal(rows[2].cards, 1);
});

test("dailyActivity counts new cards and lapses", () => {
  const rows = dailyActivity(
    [
      review({ id: "a", day: "2026-03-04", stateBefore: "new", rating: 3 }),
      review({ id: "b", day: "2026-03-04", stateBefore: "review", rating: 1 }),
    ],
    "2026-03-04",
    "2026-03-04",
  );
  assert.equal(rows[0].cards, 2);
  assert.equal(rows[0].newCards, 1);
  assert.equal(rows[0].lapses, 1);
  assert.equal(rows[0].accuracy, 0.5);
});

test("undone answers are excluded from activity", () => {
  const rows = dailyActivity(
    [review({ id: "a", day: "2026-03-04" }), review({ id: "b", day: "2026-03-04", undone: true })],
    "2026-03-04",
    "2026-03-04",
  );
  assert.equal(rows[0].cards, 1);
});

test("a single answer longer than the cap is treated as an interruption", () => {
  // Otherwise one tab left open overnight turns "12 minutes today" into
  // "nine hours today" and the number stops meaning anything.
  const rows = dailyActivity(
    [review({ day: "2026-03-04", durationMs: 9 * 3600 * 1000 })],
    "2026-03-04",
    "2026-03-04",
  );
  assert.equal(rows[0].seconds, MAX_ANSWER_SECONDS);
  assert.equal(rows[0].minutes, MAX_ANSWER_SECONDS / 60);
});

test("negative durations cannot subtract from the total", () => {
  const rows = dailyActivity(
    [review({ day: "2026-03-04", durationMs: -5000 })],
    "2026-03-04",
    "2026-03-04",
  );
  assert.equal(rows[0].seconds, 0);
});

test("collectionSummary buckets card states and counts what is due", () => {
  const cards = [
    card({ id: "a", state: "new" }),
    card({ id: "b", state: "learning" }),
    card({ id: "c", state: "relearning" }),
    card({ id: "d", state: "review" }),
    card({ id: "e", state: "new", suspended: true }),
    card({ id: "f", state: "new", orphaned: true }),
  ];
  // The predicate mirrors what the queue would actually offer, so this also
  // exercises that suspended and orphaned cards are filtered out.
  const due = (entry) => !entry.suspended && !entry.orphaned && entry.due <= "2026-03-04";
  const summary = collectionSummary(cards, "2026-03-04", due);
  assert.equal(summary.total, 6);
  // Suspended and orphaned cards are still counted by state: the summary
  // describes the collection, while `due` describes what is offered.
  assert.equal(summary.new, 3);
  assert.equal(summary.learning, 2);
  assert.equal(summary.review, 1);
  assert.equal(summary.suspended, 1);
  assert.equal(summary.orphaned, 1);
  // Suspended and orphaned cards are not offered.
  assert.equal(summary.due, 4);
});

test("retention ignores new cards, because they cannot be 'retained' yet", () => {
  const reviews = [
    review({ id: "a", stateBefore: "new", rating: 1, day: "2026-03-04" }),
    review({ id: "b", stateBefore: "review", rating: 3, day: "2026-03-04" }),
    review({ id: "c", stateBefore: "review", rating: 1, day: "2026-03-04" }),
  ];
  const result = retention(reviews, 30, "2026-03-04");
  assert.equal(result.reviews, 2);
  assert.equal(result.correct, 1);
  assert.equal(result.retention, 0.5);
});

test("retention excludes undone answers and respects the window", () => {
  const reviews = [
    review({ id: "a", stateBefore: "review", rating: 1, day: "2026-03-04", undone: true }),
    review({ id: "b", stateBefore: "review", rating: 3, day: "2026-01-01" }),
  ];
  const result = retention(reviews, 7, "2026-03-04");
  assert.equal(result.reviews, 0);
  assert.equal(result.retention, 0);
});

test("forecast covers the horizon and folds overdue cards into today", () => {
  const cards = [
    card({ id: "overdue", due: "2026-03-01" }),
    card({ id: "today", due: "2026-03-04" }),
    card({ id: "tomorrow", due: "2026-03-05" }),
  ];
  const rows = forecast(cards, "2026-03-04", 3);
  assert.deepEqual(rows.map((row) => row.day), ["2026-03-04", "2026-03-05", "2026-03-06"]);
  assert.equal(rows[0].due, 2);
  assert.equal(rows[1].due, 1);
  assert.equal(rows[2].due, 0);
});

test("forecast ignores suspended and orphaned cards", () => {
  const cards = [card({ id: "s", suspended: true }), card({ id: "o", orphaned: true })];
  assert.equal(forecast(cards, "2026-03-04", 1)[0].due, 0);
});