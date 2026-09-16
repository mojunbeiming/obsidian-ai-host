/**
 * Card ordering.
 *
 * Two properties matter more than any individual mode:
 *
 * 1. **The default equals what the plugin did before ordering existed.** The
 *    same collection must produce the same queue as it did in v0.2.2, or an
 *    upgrade silently reshuffles someone's study. That is asserted against the
 *    queue's own `urgency` behaviour in `queue.test.mjs`; here it is asserted on
 *    the keys.
 * 2. **Random is stable within a day.** Anki hashes the card id with the day as
 *    salt precisely so a rebuilt queue comes back in the same order; a real
 *    shuffle would move the card the user was about to see next, on every answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NEW_ORDERS,
  REVIEW_ORDERS,
  compareKeys,
  daySalt,
  isArranged,
  kindRank,
  newSortKey,
  orderLabel,
  positionOf,
  randomKey,
  reviewSortKey,
  sortCards,
} from "../.build/sort.js";
import { retrievability } from "../.build/fsrs.js";

/**
 * Stability is *defined* as the interval at which recall is 90% likely, so this
 * is the reference retention the FSRS curve is anchored to. `sdk/src/fsrs.ts`
 * builds its `FACTOR` from the same number.
 */
const RETENTION_AT_STABILITY = 0.9;

const NOW = Date.UTC(2026, 2, 4, 12, 0, 0);
const DAY = "2026-03-04";
const SALT = daySalt(DAY);

const card = (id, overrides = {}) => ({
  id,
  file: "notes/a.md",
  kind: "basic",
  deck: "Default",
  tags: [],
  state: "new",
  due: DAY,
  learningStep: null,
  stability: 0,
  difficulty: 0,
  reps: 0,
  lapses: 0,
  intervalDays: 0,
  lastReview: null,
  suspended: false,
  addedAt: "2026-03-01T00:00:00Z",
  ...overrides,
});

const ids = (cards) => cards.map((entry) => entry.id);
const orderNew = (cards, order, salt = SALT) =>
  ids(sortCards(cards, (entry) => newSortKey(entry, order, salt)));
const orderReview = (cards, order, salt = SALT) =>
  ids(sortCards(cards, (entry) => reviewSortKey(entry, order, salt, NOW)));

// -- position ---------------------------------------------------------------

test("position orders small numbers first", () => {
  const cards = [
    card("c", { position: 30 }),
    card("a", { position: 10 }),
    card("b", { position: 20 }),
  ];
  assert.deepEqual(orderNew(cards, "position"), ["a", "b", "c"]);
});

test("unarranged cards sort after the arranged ones", () => {
  // Not to the front: a card added after the user arranged a deck is one they
  // have not placed yet, and putting it first would undo their arrangement.
  const cards = [card("new"), card("placed", { position: 5 }), card("alsoNew")];
  assert.deepEqual(orderNew(cards, "position"), ["placed", "alsoNew", "new"]);
});

test("the descending order agrees about what unarranged means", () => {
  const cards = [card("new"), card("low", { position: 1 }), card("high", { position: 9 })];
  assert.deepEqual(orderNew(cards, "position-desc"), ["high", "low", "new"]);
});

test("equal positions fall back to the id, so the order is determined", () => {
  // Without the tie-break the order of two equal keys would depend on the sort
  // implementation and the input order, and the queue could differ between two
  // rebuilds of identical data.
  const cards = [card("b", { position: 5 }), card("a", { position: 5 })];
  assert.deepEqual(orderNew(cards, "position"), ["a", "b"]);
  assert.deepEqual(orderNew([card("a", { position: 5 }), card("b", { position: 5 })], "position"), ["a", "b"]);
});

test("a broken position counts as unarranged rather than sorting first", () => {
  // A `NaN` or negative value would otherwise put a card at the very front, which
  // reads as "the ordering is broken" rather than "one field is wrong".
  for (const broken of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(positionOf(card("x", { position: broken })), null, `position ${broken}`);
  }
  assert.equal(positionOf(card("x", { position: "3" })), null);
  assert.equal(positionOf(card("x")), null);
  const cards = [card("broken", { position: Number.NaN }), card("placed", { position: 100 })];
  assert.deepEqual(orderNew(cards, "position"), ["placed", "broken"]);
});

test("isArranged separates a fresh deck from an arranged one", () => {
  assert.equal(isArranged([card("a"), card("b")]), false);
  assert.equal(isArranged([card("a"), card("b", { position: 2 })]), true);
  assert.equal(isArranged([card("a", { position: Number.NaN })]), false);
  assert.equal(isArranged([]), false);
});

// -- the other new-card orders ---------------------------------------------

test("by creation time follows addedAt", () => {
  const cards = [
    card("later", { addedAt: "2026-03-03T00:00:00Z" }),
    card("earlier", { addedAt: "2026-03-01T00:00:00Z" }),
  ];
  assert.deepEqual(orderNew(cards, "created"), ["earlier", "later"]);
});

test("a card with no addedAt sorts first rather than crashing", () => {
  const cards = [card("dated", { addedAt: "2026-03-01T00:00:00Z" }), card("undated", { addedAt: undefined })];
  assert.deepEqual(orderNew(cards, "created"), ["undated", "dated"]);
});

test("grouping by kind uses the studio's order, recall first", () => {
  const cards = [
    card("essay", { questionKind: "essay" }),
    card("recall", { questionKind: "recall" }),
    card("choice", { questionKind: "choice" }),
  ];
  assert.deepEqual(orderNew(cards, "kind"), ["recall", "choice", "essay"]);
  assert.ok(kindRank(card("a", { questionKind: "recall" })) < kindRank(card("b", { questionKind: "blank" })));
  assert.ok(kindRank(card("a", { questionKind: "blank" })) < kindRank(card("b", { questionKind: "essay" })));
});

test("a card with no question kind falls back to its legacy kind", () => {
  // Migrated v0.1 cards have `kind` but no `questionKind`.
  assert.equal(kindRank(card("a", { kind: "cloze" })), kindRank(card("b", { questionKind: "blank" })));
  assert.equal(kindRank(card("a", { kind: "basic" })), kindRank(card("b", { questionKind: "recall" })));
});

// -- random -----------------------------------------------------------------

test("the day salt differs between days and is stable within one", () => {
  assert.equal(daySalt("2026-03-04"), daySalt("2026-03-04"));
  assert.notEqual(daySalt("2026-03-04"), daySalt("2026-03-05"));
  // Neighbouring days must be far apart in hash space, which is why the digits
  // are multiplied: without it the day strings differ by one character and the
  // hashes of nearby ids come out correlated.
  assert.ok(Math.abs(daySalt("2026-03-05") - daySalt("2026-03-04")) > 1000);
  assert.equal(daySalt("nonsense"), 1);
});

test("the random order is the same for the same day and salt", () => {
  const cards = [card("a"), card("b"), card("c"), card("d")];
  const first = orderNew(cards, "random");
  const second = orderNew([...cards].reverse(), "random");
  assert.deepEqual(first, second, "input order must not matter");
  assert.deepEqual(first, orderNew(cards, "random", daySalt("2026-03-04")));
});

test("the salt decides every card's key, which is what reshuffling needs", () => {
  // Asserted on the *keys* rather than on the resulting order. With a fixed set
  // of ids, two different salts can hash into the same permutation by chance --
  // so "the order changed" is a coin flip on any particular fixture, while "the
  // key changed" is a property of the function. (Determinism of the resulting
  // order is asserted separately, above.)
  const cards = Array.from({ length: 20 }, (_, index) => card(`c${index}`));
  const keysFor = (salt) => cards.map((entry) => randomKey(entry.id, salt));
  const today = keysFor(daySalt("2026-03-04"));
  assert.notDeepEqual(today, keysFor(daySalt("2026-03-05")));
  // The session's reshuffle count is added to the same number, so "reshuffle
  // now" moves every key within one day as well.
  assert.notDeepEqual(today, keysFor(daySalt("2026-03-04") + 1));
  // Twenty distinct ids never collide under one salt, or the order would have
  // holes in it.
  assert.equal(new Set(today).size, cards.length);
});

test("randomKey is a pure function of id and salt", () => {
  assert.equal(randomKey("a", 7), randomKey("a", 7));
  assert.notEqual(randomKey("a", 7), randomKey("b", 7));
  assert.notEqual(randomKey("a", 7), randomKey("a", 8));
  // Eight lowercase hex digits, so lexicographic order equals numeric order.
  assert.match(randomKey("a", 7), /^[0-9a-f]{8}$/);
});

// -- review orders ----------------------------------------------------------

test("relative overdueness puts the furthest past its curve first", () => {
  const cards = [
    card("mild", { state: "review", stability: 10, lastReview: "2026-02-22T12:00:00Z" }),
    card("severe", { state: "review", stability: 5, lastReview: "2026-02-12T12:00:00Z" }),
  ];
  // mild: 10 days / stability 10 = 1. severe: 20 days / stability 5 = 4.
  assert.deepEqual(orderReview(cards, "relative-overdueness"), ["severe", "mild"]);
});

test("a card with memory state but no last review falls back to how overdue it is", () => {
  // The ratio cannot be computed without a reference point, so this falls back to
  // the due date -- but *negated*, because a card due three weeks ago has the
  // largest due instant and would otherwise come last, in the one mode whose
  // whole purpose is "most overdue first".
  const waiting = card("waiting", { state: "review", stability: 5, lastReview: null, due: "2026-02-11" });
  const recent = card("recent", { state: "review", stability: 5, lastReview: null, due: "2026-03-03" });
  assert.deepEqual(orderReview([recent, waiting], "relative-overdueness"), ["waiting", "recent"]);
});

test("the fallback does not push waiting cards ahead of a genuinely overdue one", () => {
  // A card with a real ratio of 3 (15 days / stability 5) is more overdue than a
  // card that is merely a day past its due date, and must come first.
  const ratio = card("ratio", { state: "review", stability: 5, lastReview: "2026-02-17T12:00:00Z" });
  const dueOnly = card("dueOnly", { state: "review", stability: 5, lastReview: null, due: "2026-03-03" });
  assert.deepEqual(orderReview([dueOnly, ratio], "relative-overdueness"), ["ratio", "dueOnly"]);
});

test("by due date compares days and instants sensibly", () => {
  const cards = [
    card("tomorrow", { due: "2026-03-05" }),
    card("today-late", { due: "2026-03-04T23:00:00Z" }),
    card("yesterday", { due: "2026-03-03" }),
  ];
  // A day-level card is available for the whole of its day, so `2026-03-04`
  // belongs after `2026-03-04T23:00` only if the day is read as its end. Both
  // readings are defensible; what matters is that it does not thrash.
  const order = orderReview(cards, "due");
  assert.equal(order[0], "yesterday");
  assert.equal(order[2], "tomorrow");
});

test("a malformed due value sorts last instead of crashing", () => {
  const cards = [card("bad", { due: "not-a-date" }), card("good", { due: "2026-03-05" })];
  assert.deepEqual(orderReview(cards, "due"), ["good", "bad"]);
});

test("by interval puts the short ones first", () => {
  const cards = [
    card("long", { intervalDays: 90 }),
    card("short", { intervalDays: 2 }),
    card("medium", { intervalDays: 14 }),
  ];
  assert.deepEqual(orderReview(cards, "interval"), ["short", "medium", "long"]);
});

test("review order can be random too, with the same stability guarantee", () => {
  const cards = [card("a"), card("b"), card("c")];
  // Determinism is the property worth asserting; whether a different salt happens
  // to produce a different permutation of three cards is a coin flip, so that is
  // asserted on the keys instead.
  assert.deepEqual(orderReview(cards, "random"), orderReview(cards, "random"));
  assert.deepEqual(
    cards.map((entry) => randomKey(entry.id, SALT)),
    cards.map((entry) => randomKey(entry.id, SALT)),
  );
  assert.notDeepEqual(
    cards.map((entry) => randomKey(entry.id, SALT)),
    cards.map((entry) => randomKey(entry.id, SALT + 1)),
  );
});

// -- agreement with Anki's FSRS review ordering ------------------------------

/**
 * Anki's `REVIEW_CARD_ORDER_RELATIVE_OVERDUENESS`, transcribed from
 * `rslib/src/storage/card/mod.rs:837-848` (the SQL clause) plus
 * `rslib/src/storage/sqlite.rs:410-448` (the function it calls):
 *
 *     -(R(t; S, decay) ** (-1/decay) - 1) / (R_desired ** (-1/decay) - 1)
 *
 * The whole point of computing it the long way here is that the short way --
 * what `reviewSortKey` actually does -- has to be *derived*, not assumed. Two
 * cancellations do the work: the FSRS curve puts `1/decay` on the retrievability
 * and again on the desired retention, so the exponent drops out; and the base
 * factor cancels inside `R^(-1/decay) - 1`, leaving exactly `t / S`. So the sort
 * is "largest elapsed/stability ratio first" and nothing else -- which is why
 * Anki's own code can return the plain ratio for cards whose `card.data` has no
 * memory state (`rslib/src/storage/sqlite.rs:444-448`).
 *
 * If a future change gives this plugin a per-card desired retention, the
 * `R_desired` term stops cancelling *between cards* and this test is where that
 * shows up.
 */
const ankiRelativeOverdueness = ({ stability, lastReview }, now, desiredRetention, decay) => {
  // Anki's `last_review_time` is a real timestamp; the day-boundary form of
  // `secs_elapsed` is only its fallback for cards without one.
  const elapsedDays = (now - Date.parse(lastReview)) / 86400000;
  const current = retrievability(elapsedDays, stability, decay);
  const want = retrievability(ankiInterval(stability, desiredRetention, decay), stability, decay);
  // `.max(0.0001)` on both, as Anki clamps them to avoid a division by zero.
  const numerator = Math.max(current, 0.0001) ** (-1 / decay) - 1;
  const denominator = Math.max(want, 0.0001) ** (-1 / decay) - 1;
  return -numerator / denominator;
};

/** The `S -> scheduled interval` step Anki takes before evaluating the curve. */
const ankiInterval = (stability, desiredRetention, decay) =>
  (stability / (Math.pow(RETENTION_AT_STABILITY, 1 / decay) - 1)) *
  (Math.pow(desiredRetention, 1 / decay) - 1);

test("relative overdueness ranks exactly as Anki's FSRS formula does", () => {
  const cards = [
    card("mild", { stability: 10, lastReview: "2026-03-03T12:00:00Z" }), // 1 day late / 10
    card("severe", { stability: 1, lastReview: "2026-03-03T12:00:00Z" }), // 1 day late / 1
    card("mild-long", { stability: 100, lastReview: "2026-02-02T12:00:00Z" }), // 30 / 100
    card("severe-short", { stability: 2, lastReview: "2026-02-27T12:00:00Z" }), // 5 / 2
    card("same-ratio-a", { stability: 3, lastReview: "2026-02-20T12:00:00Z" }), // 12 / 3 = 4
    card("same-ratio-b", { stability: 1.5, lastReview: "2026-02-26T12:00:00Z" }), // 6 / 1.5 = 4
  ];
  const share = (value, total) => value / total;
  const byRatio = (a, b) =>
    share(NOW - Date.parse(a.lastReview), 86400000) / a.stability -
    share(NOW - Date.parse(b.lastReview), 86400000) / b.stability;

  // Sanity: the fixture has to actually make the two forms disagree, or the
  // comparison below would pass by accident. It does, in two visible ways: the
  // plain ratio puts `same-ratio-a` ahead of `severe-short`, while Anki's
  // formula orders by the curve -- so `severe-short` (5 days at S=2, 2.5x) comes
  // first and `same-ratio-a` (12 days at S=3, 4x) lands in a band after it --
  // and the two exactly-equal ratios tie, where `sort` falls back to input order
  // but the comparator breaks the tie by id.
  const naive = [...cards].sort(byRatio);
  assert.notDeepEqual(ids(naive), ["severe-short", "severe", "same-ratio-a", "same-ratio-b", "mild", "mild-long"]);
  // `byRatio(a, b)` is `ratio(a) - ratio(b)`, so a positive value means the
  // plain ratio puts `same-ratio-a` (4x) ahead of `severe-short` (2.5x).
  assert.ok(byRatio(cards[4], cards[3]) > 0, "the fixture must separate same-ratio-a from severe-short");

  // The decay is a free parameter of the curve (Anki ships one per FSRS
  // revision); the ordering must not depend on which one is in use, because the
  // exponent cancels on both sides of the ratio. Two values are checked so the
  // cancellation is exercised rather than assumed.
  for (const decay of [-0.5, -0.1542]) {
    const ours = [...cards].sort((a, b) =>
      compareKeys(
        reviewSortKey(a, "relative-overdueness", SALT, NOW),
        reviewSortKey(b, "relative-overdueness", SALT, NOW),
        a.id,
        b.id,
      ),
    );
    const anki = [...cards].sort((a, b) => {
      const left = ankiRelativeOverdueness(a, NOW, 0.9, decay);
      const right = ankiRelativeOverdueness(b, NOW, 0.9, decay);
      // A tolerance, not equality: the two forms reach the same number by
      // different arithmetic, so the last bits can differ.
      if (Math.abs(left - right) > 1e-12) return left < right ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    assert.deepEqual(ids(ours), ids(anki), `disagrees with Anki at decay ${decay}`);
  }

  // And the short form really is the plain ratio, not merely order-compatible
  // with it: equal ratios must give equal keys, which is what the exponent
  // cancellation above predicts.
  assert.equal(
    reviewSortKey(cards[4], "relative-overdueness", SALT, NOW),
    reviewSortKey(cards[5], "relative-overdueness", SALT, NOW),
  );
  // The negative sign is load-bearing: the comparator sorts ascending, so a
  // larger ratio has to produce a smaller key.
  assert.ok(
    reviewSortKey(cards[1], "relative-overdueness", SALT, NOW) <
      reviewSortKey(cards[0], "relative-overdueness", SALT, NOW),
  );
});
test("a card with memory state but no lastReview falls back to the due date", () => {
  // No reference point means the ratio cannot be computed. Subtracting from
  // zero instead would order the card by a number nobody can see.
  const orphan = card("orphan", { stability: 20, due: "2026-03-01", lastReview: undefined });
  const dated = card("dated", { stability: 0, due: "2026-03-03", lastReview: undefined });
  assert.ok(reviewSortKey(orphan, "relative-overdueness", SALT, NOW) < 0);
  assert.ok(
    reviewSortKey(orphan, "relative-overdueness", SALT, NOW) <
      reviewSortKey(dated, "relative-overdueness", SALT, NOW),
  );
});
// -- comparison and labels --------------------------------------------------

test("keys compare by value and break ties by id", () => {
  assert.equal(compareKeys(1, 2, "a", "b"), -1);
  assert.equal(compareKeys(2, 1, "a", "b"), 1);
  assert.equal(compareKeys(2, 2, "a", "b"), -1);
  assert.equal(compareKeys(2, 2, "b", "a"), 1);
  assert.equal(compareKeys(2, 2, "a", "a"), 0);
});

test("sorting never reorders the caller's array in place", () => {
  const cards = [card("b"), card("a")];
  const sorted = sortCards(cards, (entry) => entry.id);
  assert.deepEqual(ids(cards), ["b", "a"]);
  assert.deepEqual(ids(sorted), ["a", "b"]);
});

test("every order has a Chinese label", () => {
  for (const order of [...NEW_ORDERS, ...REVIEW_ORDERS]) {
    const label = orderLabel(order);
    assert.ok(/[\u4e00-\u9fff]/.test(label), `${order} label is not Chinese: ${label}`);
    // Two characters is a label ("随机"); one would be a fragment.
    assert.ok(label.length >= 2, `${order} label is too short: ${label}`);
  }
});

test("the offered orders are exactly the ones with labels, without duplicates", () => {
  assert.equal(new Set(NEW_ORDERS).size, NEW_ORDERS.length);
  assert.equal(new Set(REVIEW_ORDERS).size, REVIEW_ORDERS.length);
  assert.ok(NEW_ORDERS.every((order) => orderLabel(order) !== String(order)));
  assert.ok(REVIEW_ORDERS.every((order) => orderLabel(order) !== String(order)));
});