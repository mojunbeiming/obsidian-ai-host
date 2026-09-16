import assert from "node:assert/strict";
import { test } from "node:test";

import { buildQueue, emptyReason, isDue, isEligible } from "../.build/queue.js";
import { card, review } from "./_fs.mjs";

const DAY = "2026-03-04";
// 12:00 UTC on the test day, as an epoch.
const NOW = Date.UTC(2026, 2, 4, 12, 0, 0);
const opts = (overrides = {}) => ({ day: DAY, now: NOW, ...overrides });
const plan = (cards, reviews = [], options = {}, decks) =>
  buildQueue({ cards, reviews, options: opts(options), decks });

test("a day-level card is due for the whole of its day", () => {
  assert.equal(isDue(card({ due: "2026-03-04" }), NOW), true);
  assert.equal(isDue(card({ due: "2026-03-03" }), NOW), true); // overdue
  assert.equal(isDue(card({ due: "2026-03-05" }), NOW), false);
});

test("a sub-day card is due only once its instant has passed", () => {
  assert.equal(isDue(card({ due: "2026-03-04T11:00:00Z" }), NOW), true);
  assert.equal(isDue(card({ due: "2026-03-04T13:00:00Z" }), NOW), false);
});

test("suspended, orphaned and same-day-buried cards are ineligible", () => {
  assert.equal(isEligible(card(), DAY), true);
  assert.equal(isEligible(card({ suspended: true }), DAY), false);
  assert.equal(isEligible(card({ orphaned: true }), DAY), false);
  assert.equal(isEligible(card({ buriedDay: DAY }), DAY), false);
  // A bury only lasts for the day it was issued.
  assert.equal(isEligible(card({ buriedDay: "2026-03-03" }), DAY), true);
});

test("learning steps are served before reviews, and new cards last", () => {
  const cards = [
    card({ id: "new1", state: "new" }),
    card({ id: "rev1", state: "review", stability: 10, intervalDays: 10, lastReview: "2026-02-22T12:00:00Z" }),
    card({ id: "learn1", state: "learning", learningStep: 0, due: "2026-03-04T11:59:00Z", stability: 2 }),
  ];
  const result = plan(cards);
  assert.deepEqual(result.order, ["learn1", "rev1", "new1"]);
  assert.deepEqual(result.counts, { new: 1, learning: 1, review: 1, total: 3 });
});

test("reviews are ordered least-recalled first", () => {
  // The urgency key is elapsed/stability, and the queue serves the *smallest*
  // first: a card that has not yet decayed much is by definition the one whose
  // recall is still cheap to confirm. (4 vs 1 also proves the ordering is
  // actually applied rather than falling through to the id tiebreak.)
  //
  //   mild   : 10 days elapsed / stability 10 = 1
  //   severe : 20 days elapsed / stability  5 = 4
  const cards = [
    card({ id: "severe", state: "review", stability: 5, intervalDays: 5, lastReview: "2026-02-12T12:00:00Z" }),
    card({ id: "mild", state: "review", stability: 10, intervalDays: 10, lastReview: "2026-02-22T12:00:00Z" }),
  ];
  const result = plan(cards);
  assert.deepEqual(result.order, ["mild", "severe"]);
});

test("review ordering does not fall back to the id tiebreak when urgencies differ", () => {
  // Deliberately give the ids the *opposite* of the wanted order, so a broken
  // comparator would still produce a plausible-looking result.
  const cards = [
    card({ id: "a_low_urgency", state: "review", stability: 100, lastReview: "2026-03-03T12:00:00Z" }),
    card({ id: "z_high_urgency", state: "review", stability: 1, lastReview: "2026-01-01T12:00:00Z" }),
  ];
  assert.deepEqual(plan(cards).order, ["a_low_urgency", "z_high_urgency"]);
});

test("cards due in the future are excluded", () => {
  const cards = [card({ id: "later", due: "2026-04-01" }), card({ id: "today", due: DAY })];
  assert.deepEqual(plan(cards).order, ["today"]);
});

test("the learning count is never cut by the daily limits", () => {
  // Learning steps are minutes from being forgotten. Hiding them behind a
  // spent quota is what makes a scheduler feel broken.
  const cards = [
    card({ id: "l1", state: "learning", learningStep: 0, due: "2026-03-04T11:00:00Z", stability: 2 }),
    card({ id: "l2", state: "relearning", learningStep: 0, due: "2026-03-04T11:00:00Z", stability: 2 }),
    card({ id: "l3", state: "learning", learningStep: 1, due: "2026-03-04T11:30:00Z", stability: 2 }),
  ];
  const result = plan(cards, [], { newLimit: 0, reviewLimit: 0 });
  assert.equal(result.counts.learning, 3);
  assert.equal(result.counts.new, 0);
});

test("the new-card limit slices the new queue and reports today's headroom", () => {
  const cards = Array.from({ length: 5 }, (_, i) => card({ id: `n${i}` }));
  const result = plan(cards, [], { newLimit: 2, reviewLimit: 100 });
  assert.equal(result.counts.new, 2);
  // `remaining` is headroom for the rest of the day, so with nothing answered
  // yet it still reads 2 even though this plan serves exactly those 2. That is
  // the number the UI needs in order to say "2 new cards allowed today".
  assert.equal(result.remaining.new, 2);
  assert.deepEqual(result.order, ["n0", "n1"]);
});

test("a partly spent new-card quota reports the smaller headroom", () => {
  const cards = Array.from({ length: 5 }, (_, i) => card({ id: `n${i}` }));
  const reviews = [review({ id: "r1", cardId: "old", stateBefore: "new", day: DAY })];
  const result = plan(cards, reviews, { newLimit: 3, reviewLimit: 100 });
  assert.equal(result.progress.newDone, 1);
  assert.equal(result.counts.new, 2);
  assert.equal(result.remaining.new, 2);
});

test("today's new-card count comes from the log, not from a counter", () => {
  // A counter would drift after a crash or a second window. Deriving it from
  // the log means the limit stays correct however the day was spent -- and note
  // that the answered cards are no longer *new* at all, because answering a new
  // card moves it into the learning ladder. Only n2 is still waiting.
  const cards = [
    card({ id: "n0", state: "learning", reps: 1 }),
    card({ id: "n1", state: "learning", reps: 1 }),
    card({ id: "n2" }),
  ];
  const reviews = [
    review({ id: "r1", cardId: "n0", stateBefore: "new", day: DAY }),
    review({ id: "r2", cardId: "n1", stateBefore: "new", day: DAY }),
    // Yesterday's answers must not count against today.
    review({ id: "r3", cardId: "old", stateBefore: "new", day: "2026-03-03" }),
    // Neither must an undone one.
    review({ id: "r4", cardId: "old", stateBefore: "new", day: DAY, undone: true }),
  ];
  const result = plan(cards, reviews, { newLimit: 3, reviewLimit: 100 });
  assert.equal(result.progress.newDone, 2);
  assert.equal(result.remaining.new, 1);
  assert.equal(result.counts.new, 1);
  // The two in learning are waiting on a step, and are still served.
  assert.equal(result.counts.learning, 2);
});

test("a card already answered today is never served twice", () => {
  // The consistency guard: the card's state still says new even though the log
  // says it was answered, which is what a crash between the two writes leaves.
  const cards = [card({ id: "n0", state: "new" })];
  const reviews = [review({ id: "r1", cardId: "n0", stateBefore: "new", day: DAY })];
  const result = plan(cards, reviews, {
    newLimit: 5,
    reviewLimit: 5,
    answeredToday: ["n0"],
  });
  assert.ok(!result.order.includes("n0"), JSON.stringify(result.order));
  assert.equal(result.counts.total, 0);
});

test("a learning card whose step came back is served even though it was answered today", () => {
  // The trap in the guard above. The learning ladder is same-day repetition by
  // design: a card answered 10 minutes ago and due again now MUST come back, or
  // no new card ever graduates. Passing every card answered today -- rather than
  // only those still marked new -- silently breaks that.
  const cards = [
    card({
      id: "l0",
      state: "learning",
      learningStep: 0,
      reps: 1,
      stability: 2,
      due: "2026-03-04T11:00:00Z", // already past
    }),
  ];
  const reviews = [review({ id: "r1", cardId: "l0", stateBefore: "new", day: DAY })];
  // The caller passes only "still new" ids, so l0 is absent and stays queued.
  const result = plan(cards, reviews, { newLimit: 5, reviewLimit: 5, answeredToday: [] });
  assert.deepEqual(result.order, ["l0"]);
  assert.equal(result.counts.learning, 1);
});

test("a review card that fell due again today is still served", () => {
  // Same-day re-reviews happen when an interval rounds down to hours, and when
  // a card is answered Again and graduates back out the same day.
  const cards = [
    card({
      id: "rv0",
      state: "review",
      stability: 1,
      intervalDays: 1,
      due: "2026-03-04T09:00:00Z",
      lastReview: "2026-03-04T08:00:00Z",
      reps: 2,
    }),
  ];
  const reviews = [review({ id: "r1", cardId: "rv0", stateBefore: "review", day: DAY })];
  const result = plan(cards, reviews, { newLimit: 0, reviewLimit: 5, answeredToday: [] });
  assert.deepEqual(result.order, ["rv0"]);
});

test("omitting answeredToday leaves the queue driven purely by card state", () => {
  // The filter is a safety net, not a second source of truth: a card whose
  // state says it is waiting is served, log or no log.
  const cards = [card({ id: "n0", state: "learning", reps: 1, due: "2026-03-04T11:00:00Z", stability: 2 })];
  const result = plan(cards, [], { newLimit: 5, reviewLimit: 5 });
  assert.deepEqual(result.order, ["n0"]);
});

test("the review limit accounts for reviews already done today", () => {
  const cards = [
    card({ id: "r1", state: "review", stability: 10, intervalDays: 10, lastReview: "2026-02-22T12:00:00Z" }),
    card({ id: "r2", state: "review", stability: 10, intervalDays: 10, lastReview: "2026-02-22T12:00:00Z" }),
    card({ id: "r3", state: "review", stability: 10, intervalDays: 10, lastReview: "2026-02-22T12:00:00Z" }),
  ];
  const reviews = [review({ id: "x", cardId: "old", stateBefore: "review", day: DAY })];
  const result = plan(cards, reviews, { newLimit: 0, reviewLimit: 2 });
  assert.equal(result.progress.reviewsDone, 1);
  assert.equal(result.counts.review, 1);
});

test("an explicit deck scope filters the queue", () => {
  const cards = [card({ id: "a", deck: "d1" }), card({ id: "b", deck: "d2" })];
  assert.deepEqual(plan(cards, [], { decks: ["d1"] }).order, ["a"]);
  // An empty scope means every deck, not no deck.
  assert.deepEqual(plan(cards, [], { decks: [] }).order, ["a", "b"]);
});

test("with no decks configured the limits are unlimited rather than zero", () => {
  const cards = Array.from({ length: 50 }, (_, i) => card({ id: `n${i}` }));
  const result = plan(cards);
  assert.equal(result.counts.new, 50);
  assert.ok(!Number.isFinite(result.limits.new), "limit should be unbounded");
});

test("per-deck limits are summed across the scope", () => {
  const cards = [card({ id: "a", deck: "d1" }), card({ id: "b", deck: "d2" })];
  const decks = [
    { id: "d1", name: "One", newPerDay: 1, reviewsPerDay: 10 },
    { id: "d2", name: "Two", newPerDay: 2, reviewsPerDay: 10 },
  ];
  const result = plan(cards, [], {}, decks);
  assert.equal(result.limits.new, 3);
  assert.equal(result.counts.new, 2);
});

test("a suspended card never enters the queue", () => {
  const cards = [card({ id: "s", suspended: true }), card({ id: "a" })];
  assert.deepEqual(plan(cards).order, ["a"]);
});

test("an empty result is reported as nothing-due", () => {
  const result = plan([]);
  assert.equal(result.counts.total, 0);
  assert.equal(emptyReason(result, NOW), "nothing-due");
});

test("nothing due while new cards remain inside their quota is nothing-due, not quota-reached", () => {
  // The distinction matters on screen: "you are done" and "you have spent
  // today's new cards" are different messages and only one is reassuring.
  const result = plan([card({ id: "a", due: "2026-04-01" })], [], { newLimit: 5, reviewLimit: 5 });
  assert.equal(emptyReason(result, NOW), "nothing-due");
});

test("a spent new-card quota with new cards waiting is reported as quota-reached", () => {
  const cards = [card({ id: "n0" }), card({ id: "n1" })];
  const reviews = [
    review({ id: "r1", cardId: "n0", stateBefore: "new", day: DAY }),
    review({ id: "r2", cardId: "n1", stateBefore: "new", day: DAY }),
  ];
  const result = plan(cards, reviews, { newLimit: 2, reviewLimit: 10 });
  assert.equal(result.counts.new, 0);
  assert.ok(result.remaining.new <= 0);
  // The two new cards are now in learning, so the reason is "they come back".
  assert.equal(emptyReason(result, NOW), "nothing-due");
});

test("a learning step waiting to return is reported as learning-soon", () => {
  const cards = [card({ id: "l", state: "learning", learningStep: 0, due: "2026-03-04T11:59:00Z", stability: 2 })];
  const result = plan(cards);
  assert.equal(result.counts.learning, 1);
  assert.equal(emptyReason(result, NOW), "learning-soon");
});

// -- v0.2: the two options the wrong-answer sprint is built from -------------

test("without onlyWrong, every card is still a candidate", () => {
  const cards = [card({ id: "a" }), card({ id: "b" })];
  assert.deepEqual(plan(cards).order, ["a", "b"]);
});

test("onlyWrong restricts the candidate set and nothing else", () => {
  const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
  assert.deepEqual(plan(cards, [], { onlyWrong: ["a", "c"] }).order, ["a", "c"]);
});

test("an empty onlyWrong set means no cards, not every card", () => {
  // The distinction between "undefined" (no restriction) and "empty" (restrict
  // to nothing) is the whole reason this option is not a plain array.
  const cards = [card({ id: "a" }), card({ id: "b" })];
  assert.deepEqual(plan(cards, [], { onlyWrong: [] }).order, []);
});

test("onlyWrong accepts any iterable, including a Set", () => {
  const cards = [card({ id: "a" }), card({ id: "b" })];
  assert.deepEqual(plan(cards, [], { onlyWrong: new Set(["b"]) }).order, ["b"]);
});

test("a card excluded by onlyWrong does not consume a daily slot", () => {
  // The sprint must not spend the day's new-card quota on cards the user did
  // not ask to see. Two cards are in the collection; only one is in the sprint.
  const cards = [card({ id: "drill" }), card({ id: "other" })];
  const result = plan(cards, [], { onlyWrong: ["drill"], newLimit: 1 });
  assert.equal(result.counts.new, 1);
  assert.deepEqual(result.order, ["drill"]);
});

test("onlyWrong still respects the other eligibility rules", () => {
  // Being a wrong answer does not make a suspended or buried card servable.
  const cards = [
    card({ id: "suspended", suspended: true }),
    card({ id: "buried", buriedDay: DAY }),
    card({ id: "learning-now", state: "learning", learningStep: 0, due: "2026-03-04T11:00:00Z", stability: 2 }),
  ];
  const result = plan(cards, [], { onlyWrong: ["suspended", "buried", "learning-now"] });
  assert.deepEqual(result.order, ["learning-now"]);
});

test("a card that is not due is excluded by default", () => {
  const cards = [card({ id: "later", due: "2026-04-01" })];
  assert.deepEqual(plan(cards).order, []);
});

test("allowNotDue admits a card that is not due yet", () => {
  const cards = [card({ id: "later", due: "2026-04-01" })];
  assert.deepEqual(plan(cards, [], { allowNotDue: true }).order, ["later"]);
});

test("allowNotDue does not override the daily limits", () => {
  // The sprint drops the due-date rule because drilling early is deliberate.
  // It must not also drop the quota: that would turn a drill into an unbounded
  // new-card firehose, which is a different feature nobody asked for.
  const cards = [card({ id: "n1", due: "2026-04-01" }), card({ id: "n2", due: "2026-04-01" })];
  const result = plan(cards, [], { allowNotDue: true, newLimit: 1 });
  assert.equal(result.counts.new, 1);
  assert.equal(result.order.length, 1);
});

test("allowNotDue does not override the answered-today guard", () => {
  const cards = [card({ id: "a" })];
  const result = plan(cards, [], { allowNotDue: true, answeredToday: ["a"] });
  assert.deepEqual(result.order, []);
});

test("the sprint combination is expressible in one call", () => {
  // What the plugin actually passes: these ids, right now, ignoring due dates
  // and the answered-today guard (the sprint logs its answers, so a card
  // drilled twice in a row must not be locked out by its own first answer).
  const cards = [
    card({ id: "wrong", due: "2026-06-01", state: "review", stability: 30, lastReview: "2026-03-01T12:00:00Z" }),
    card({ id: "fine", due: DAY }),
  ];
  const result = plan(cards, [], {
    onlyWrong: ["wrong"],
    allowNotDue: true,
    answeredToday: [],
  });
  assert.deepEqual(result.order, ["wrong"]);
});
// -- v0.3: ordering inside the buckets --------------------------------------

const sorter = (overrides = {}) => ({
  newOrder: "created",
  reviewOrder: "relative-overdueness",
  salt: 1,
  ...overrides,
});

test("a sorter changes the order inside a bucket and nothing else", () => {
  const cards = [
    card({ id: "b", position: 2 }),
    card({ id: "a", position: 1 }),
    card({ id: "c" }),
  ];
  // Without a sorter: by id, which is what the plugin did before ordering existed.
  assert.deepEqual(plan(cards).order, ["a", "b", "c"]);
  // With one: by position, and the ids with no position still come last.
  assert.deepEqual(plan(cards, [], { sorter: sorter({ newOrder: "position" }) }).order, ["a", "b", "c"]);
  const moved = [
    card({ id: "b", position: 1 }),
    card({ id: "a", position: 2 }),
  ];
  assert.deepEqual(plan(moved).order, ["a", "b"], "no sorter still ignores position");
  assert.deepEqual(plan(moved, [], { sorter: sorter({ newOrder: "position" }) }).order, ["b", "a"]);
});

test("a sorter cannot move learning steps out of first place", () => {
  // The ladder is minutes from being forgotten. An ordering preference is about
  // what to study next among equals, not a licence to defer a card that is about
  // to lapse.
  const cards = [
    card({ id: "new1" }),
    card({ id: "learn1", state: "learning", learningStep: 0, due: "2026-03-04T11:59:00Z", stability: 2 }),
    card({ id: "rev1", state: "review", stability: 10, lastReview: "2026-02-22T12:00:00Z" }),
  ];
  for (const order of ["position", "position-desc", "created", "kind", "random"]) {
    const result = plan(cards, [], { sorter: sorter({ newOrder: order }) });
    assert.deepEqual(result.order, ["learn1", "rev1", "new1"], `order ${order}`);
  }
});

test("a sorter cannot move reviews ahead of nothing or new ahead of reviews", () => {
  const cards = [
    card({ id: "new1" }),
    card({ id: "rev1", state: "review", stability: 10, lastReview: "2026-02-22T12:00:00Z" }),
  ];
  for (const order of ["relative-overdueness", "due", "interval", "random"]) {
    const result = plan(cards, [], { sorter: sorter({ reviewOrder: order }) });
    assert.deepEqual(result.order, ["rev1", "new1"], `order ${order}`);
  }
});

test("a sorter does not change the daily limits", () => {
  const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
  const result = plan(cards, [], { newLimit: 2, sorter: sorter({ newOrder: "random" }) });
  assert.equal(result.counts.new, 2);
  assert.equal(result.order.length, 2);
});

test("the three review orders genuinely disagree", () => {
  // Both cards are due today, so all three modes admit them -- they differ only
  // in sequence, which is the point. The ids are chosen so that the id tie-break
  // has to be used in one of the cases rather than coincidentally agreeing with
  // the wanted answer.
  //
  //   severe: due 2026-02-03, interval 5, 30 days elapsed / stability 5 = 6.0
  //   mild:   due 2026-03-03, interval 5,  1 day elapsed / stability 5 = 0.2
  const cards = [
    card({ id: "severe", state: "review", due: "2026-02-03", intervalDays: 5, stability: 5, lastReview: "2026-02-02T12:00:00Z" }),
    card({ id: "mild", state: "review", due: "2026-03-03", intervalDays: 5, stability: 5, lastReview: "2026-03-03T12:00:00Z" }),
  ];
  const orderWith = (reviewOrder) => plan(cards, [], { sorter: sorter({ reviewOrder }) }).order;

  // Furthest past its own curve first.
  assert.deepEqual(orderWith("relative-overdueness"), ["severe", "mild"]);
  // Earliest due date first -- same answer here, because it is the same card that
  // is both more overdue and due earlier.
  assert.deepEqual(orderWith("due"), ["severe", "mild"]);
  // Equal intervals, so this one has nothing to go on and falls to the id
  // tie-break: "mild" before "severe". That disagreement is what proves the modes
  // are actually consulted rather than all funneling into one comparator.
  assert.deepEqual(orderWith("interval"), ["mild", "severe"]);
});

test("by interval orders unequal intervals short first", () => {
  const cards = [
    card({ id: "long", state: "review", due: "2026-03-03", intervalDays: 90, stability: 90, lastReview: "2026-03-02T12:00:00Z" }),
    card({ id: "short", state: "review", due: "2026-03-03", intervalDays: 2, stability: 2, lastReview: "2026-03-02T12:00:00Z" }),
  ];
  assert.deepEqual(plan(cards, [], { sorter: sorter({ reviewOrder: "interval" }) }).order, ["short", "long"]);
});

test("a sorter works together with onlyWrong and allowNotDue", () => {
  // The sprint passes both; ordering must not fight either of them.
  const cards = [
    card({ id: "a", position: 3, due: "2026-06-01" }),
    card({ id: "b", position: 1, due: "2026-06-01" }),
    card({ id: "c", position: 2, due: "2026-06-01" }),
  ];
  const result = plan(cards, [], {
    onlyWrong: ["a", "b"],
    allowNotDue: true,
    sorter: sorter({ newOrder: "position" }),
  });
  assert.deepEqual(result.order, ["b", "a"]);
});

test("a random sorter is stable for one build and one salt", () => {
  const cards = Array.from({ length: 8 }, (_, index) => card({ id: `c${index}` }));
  const first = plan(cards, [], { sorter: sorter({ newOrder: "random", salt: 42 }) });
  const second = plan([...cards].reverse(), [], { sorter: sorter({ newOrder: "random", salt: 42 }) });
  assert.deepEqual(first.order, second.order);
});