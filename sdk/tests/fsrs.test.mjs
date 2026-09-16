import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CONFIG,
  RATINGS,
  SAME_DAY_ELAPSED,
  Scheduler,
  dueInstant,
  initDifficulty,
  initStability,
  intervalForStability,
  isOverdue,
  nextDifficulty,
  nextInterval,
  normalizeConfig,
  retrievability,
  stabilityAfterRecall,
} from "../.build/fsrs.js";

const NOW = new Date(Date.UTC(2026, 2, 4, 12, 0, 0));

function newCard(overrides = {}) {
  return {
    state: "new",
    due: "2026-03-04",
    learningStep: null,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    intervalDays: 0,
    lastReview: null,
    ...overrides,
  };
}

function reviewCard(overrides = {}) {
  return newCard({
    state: "review",
    due: "2026-03-04",
    stability: 10,
    difficulty: 5,
    reps: 3,
    intervalDays: 10,
    lastReview: new Date(Date.UTC(2026, 1, 22, 12)).toISOString(),
    ...overrides,
  });
}

// --- FSRS primitives --------------------------------------------------------

test("the retention offset makes R(S, S) exactly 0.9", () => {
  // This identity is what gives desiredRetention a meaning: stability is
  // *defined* as the number of days until recall decays to the target. If it
  // drifts, every interval in the app is wrong by a constant factor, and the
  // symptom is a scheduler that feels subtly too aggressive or too lazy.
  for (const stability of [0.5, 1, 5, 42, 365, 10000]) {
    const r = retrievability(stability, stability);
    assert.ok(Math.abs(r - 0.9) < 1e-12, `R(${stability}, ${stability}) = ${r}`);
  }
});

test("retrievability decays monotonically and is 1 at zero elapsed", () => {
  assert.equal(retrievability(0, 10), 1);
  let previous = 1.1;
  for (const elapsed of [0, 1, 5, 20, 100, 400]) {
    const r = retrievability(elapsed, 10);
    assert.ok(r < previous, `not decreasing at elapsed=${elapsed}`);
    previous = r;
  }
  // A decade without review on a 10-day-stability card is very nearly
  // forgotten, but the curve is a power law and not an exponential, so it
  // approaches zero rather than reaching it. An exponential (or a linear)
  // curve would land somewhere completely different here.
  const ancient = retrievability(3650, 10);
  assert.ok(ancient > 0 && ancient < 0.15, `R(3650, 10) = ${ancient}`);
});

test("retrievability of a zero-stability card is 0, not NaN", () => {
  assert.equal(retrievability(5, 0), 0);
  assert.equal(retrievability(5, -1), 0);
});

test("intervalForStability inverts the curve", () => {
  for (const retention of [0.7, 0.8, 0.9, 0.95]) {
    const interval = intervalForStability(20, retention);
    assert.ok(Math.abs(retrievability(interval, 20) - retention) < 1e-9);
  }
});

test("a higher desired retention shortens every interval", () => {
  const low = normalizeConfig({ desiredRetention: 0.8 });
  const high = normalizeConfig({ desiredRetention: 0.95 });
  assert.ok(nextInterval(20, high) < nextInterval(20, low));
});

test("initial stability and difficulty come from the weight table", () => {
  const w = DEFAULT_CONFIG.weights;
  assert.equal(initStability(w, 1), w[0]);
  assert.equal(initStability(w, 4), w[3]);
  // Every rating yields a valid difficulty inside the 1..10 range.
  for (const rating of RATINGS) {
    const d = initDifficulty(w, rating);
    assert.ok(d >= 1 && d <= 10, `difficulty ${d} out of range for ${rating}`);
  }
});

test("difficulty is monotonic: again >= hard >= good >= easy", () => {
  const w = DEFAULT_CONFIG.weights;
  const seed = 5;
  const again = nextDifficulty(w, seed, 1);
  const hard = nextDifficulty(w, seed, 2);
  const good = nextDifficulty(w, seed, 3);
  const easy = nextDifficulty(w, seed, 4);
  assert.ok(again > hard, `${again} !> ${hard}`);
  assert.ok(hard > good, `${hard} !> ${good}`);
  assert.ok(good > easy, `${good} !> ${easy}`);
  // And the whole ladder stays inside the model's range.
  for (const value of [again, hard, good, easy]) assert.ok(value >= 1 && value <= 10);
});

test("difficulty mean-reverts towards the good rating", () => {
  const w = DEFAULT_CONFIG.weights;
  const good = initDifficulty(w, 3);
  // A card at an extreme difficulty is pulled noticeably back in one step.
  const reverted = nextDifficulty(w, 10, 3);
  assert.ok(Math.abs(reverted - good) < Math.abs(10 - good));
});

test("stabilityAfterRecall grows more for easier ratings", () => {
  const w = DEFAULT_CONFIG.weights;
  const recall = retrievability(5, 10);
  const hard = stabilityAfterRecall(w, 5, 10, recall, 2);
  const good = stabilityAfterRecall(w, 5, 10, recall, 3);
  const easy = stabilityAfterRecall(w, 5, 10, recall, 4);
  assert.ok(hard < good, `${hard} !< ${good}`);
  assert.ok(good < easy, `${good} !< ${easy}`);
});

test("nextInterval never exceeds its ceiling and never returns zero", () => {
  const config = normalizeConfig({ maximumIntervalDays: 100 });
  const huge = nextInterval(1e6, config);
  assert.ok(huge <= 100, `ceiling breached: ${huge}`);
  assert.ok(nextInterval(0.0001, config) >= 1);
});

// --- new-card ladder --------------------------------------------------------

test("a new card answered Good lands on the FIRST learning step, not the second", () => {
  // Anki's semantics: a new card sits *before* step 0. Getting this wrong is
  // invisible on screen except that new cards skip straight to 10 minutes.
  const scheduler = new Scheduler();
  const outcome = scheduler.grade(newCard(), 3, NOW);
  assert.equal(outcome.stateAfter, "learning");
  assert.equal(outcome.learningStep, 0);
  assert.equal(outcome.intervalLabel, "1 min");
  assert.equal(outcome.wasNew, true);
});

test("learning steps climb 1 min then 10 min, then graduate to a day-scale interval", () => {
  const scheduler = new Scheduler();
  const first = scheduler.grade(newCard(), 3, NOW);
  assert.equal(first.intervalLabel, "1 min");

  const atStep0 = newCard({
    state: "learning",
    learningStep: 0,
    stability: first.stability,
    difficulty: first.difficulty,
    reps: 1,
    lastReview: new Date(NOW.getTime() - 60000).toISOString(),
    due: new Date(NOW.getTime() - 1000).toISOString(),
  });
  const second = scheduler.grade(atStep0, 3, NOW);
  assert.equal(second.learningStep, 1);
  assert.equal(second.intervalLabel, "10 min");

  const atStep1 = {
    ...atStep0,
    learningStep: 1,
    stability: second.stability,
    difficulty: second.difficulty,
    reps: 2,
  };
  const third = scheduler.grade(atStep1, 3, NOW);
  assert.equal(third.stateAfter, "review");
  assert.equal(third.learningStep, null);
  // Graduation lands on a day-scale interval, and it is a civil day so the
  // card is due for the whole of that day.
  assert.ok(third.intervalDays >= 1, `graduated to ${third.intervalDays} days`);
  assert.match(third.due, /^\d{4}-\d{2}-\d{2}$/);
});

test("Again on a new card keeps it at the first step", () => {
  const scheduler = new Scheduler();
  const outcome = scheduler.grade(newCard(), 1, NOW);
  assert.equal(outcome.stateAfter, "learning");
  assert.equal(outcome.learningStep, 0);
  assert.equal(outcome.intervalLabel, "1 min");
});

test("Hard on a new card repeats rather than advances the step", () => {
  const scheduler = new Scheduler();
  const outcome = scheduler.grade(newCard(), 2, NOW);
  // Step index is clamped into range for a brand new card.
  assert.equal(outcome.learningStep, 0);
  assert.equal(outcome.stateAfter, "learning");
});

test("Hard on a mid-ladder card repeats the current step instead of advancing", () => {
  const scheduler = new Scheduler();
  const card = newCard({
    state: "learning",
    learningStep: 0,
    stability: 3,
    difficulty: 5,
    reps: 1,
    lastReview: new Date(NOW.getTime() - 60000).toISOString(),
    due: new Date(NOW.getTime() - 1000).toISOString(),
  });
  const outcome = scheduler.grade(card, 2, NOW);
  assert.equal(outcome.learningStep, 0);
  assert.equal(outcome.intervalLabel, "1 min");
});

test("Easy on a new card skips the whole ladder", () => {
  const scheduler = new Scheduler();
  const outcome = scheduler.grade(newCard(), 4, NOW);
  assert.equal(outcome.stateAfter, "review");
  assert.equal(outcome.learningStep, null);
  assert.equal(outcome.intervalDays, 4);
  assert.equal(outcome.intervalLabel, "4 d");
});

test("Easy on a relearning card does not use the new-card shortcut", () => {
  // Relearning means the card already carries a memory state, so dropping it
  // onto the fixed 4-day "easy" interval would throw away evidence the model
  // has already paid for -- and would do it right after a lapse, which is when
  // the estimate most needs updating.
  const scheduler = new Scheduler();
  const card = newCard({
    state: "relearning",
    learningStep: 0,
    stability: 5,
    difficulty: 6,
    reps: 4,
    lapses: 1,
    lastReview: new Date(NOW.getTime() - 600000).toISOString(),
    due: new Date(NOW.getTime() - 1000).toISOString(),
  });
  const outcome = scheduler.grade(card, 4, NOW);
  assert.notEqual(outcome.intervalDays, scheduler.config.easyIntervalDays);
  // It graduates out of the ladder, but on an FSRS-derived interval.
  assert.equal(outcome.stateAfter, "review");
  assert.ok(outcome.intervalDays >= 1, `relearned to ${outcome.intervalDays} days`);
});

test("a relearning card graded late uses elapsed time from its OWN last review", () => {
  // The due instant here is in the past (the user answered late). Using it as
  // the judging moment would measure elapsed time from before the card's last
  // review -- i.e. answering later would make the card *younger*, growing
  // stability less. The direction of that error is what makes it dangerous.
  const scheduler = new Scheduler();
  const tenDaysAgo = new Date(NOW.getTime() - 10 * 86400000).toISOString();
  const card = newCard({
    state: "relearning",
    learningStep: 0,
    stability: 5,
    difficulty: 6,
    reps: 4,
    lapses: 1,
    lastReview: tenDaysAgo,
    due: new Date(NOW.getTime() - 9 * 86400000).toISOString(),
  });
  const outcome = scheduler.grade(card, 3, NOW);
  assert.ok(outcome.elapsedDays >= 10, `elapsed ${outcome.elapsedDays} should be ~10`);
});

// --- overdue / early / same day --------------------------------------------

test("an overdue card is rescheduled from now, never from its stale due date", () => {
  // The failure this prevents: a card imported from Anki two years overdue
  // would get "due = 2024 + 10 minutes", which is in the past, so it returns
  // immediately and loops forever.
  const scheduler = new Scheduler();
  const card = newCard({
    state: "learning",
    learningStep: 0,
    stability: 2,
    difficulty: 5,
    reps: 1,
    lastReview: new Date(Date.UTC(2024, 0, 1, 12)).toISOString(),
    due: new Date(Date.UTC(2024, 0, 1, 12, 1)).toISOString(),
  });
  const outcome = scheduler.grade(card, 3, NOW);
  assert.ok(outcome.dueAt > NOW.getTime(), "due landed in the past");
  assert.ok(Math.abs(outcome.dueAt - (NOW.getTime() + 600000)) < 1000);
});

test("answering a learning card EARLY keeps the ladder from collapsing", () => {
  // The next step is measured from the instant the current step was *due*,
  // not from now -- so a user who clicks through a 1-minute step after 5
  // seconds still gets the full 10 minutes, and repeatedly early-clicking
  // cannot compress the ladder into nothing.
  const scheduler = new Scheduler();
  const dueAt = NOW.getTime() + 5 * 60000; // due 5 minutes in the future
  const card = newCard({
    state: "learning",
    learningStep: 0,
    stability: 2,
    difficulty: 5,
    reps: 1,
    lastReview: new Date(NOW.getTime() - 60000).toISOString(),
    due: new Date(dueAt).toISOString(),
  });
  const outcome = scheduler.grade(card, 3, NOW);
  assert.equal(outcome.learningStep, 1);
  assert.equal(outcome.intervalLabel, "10 min");
  // 5 minutes still owed on the current step, plus the full 10-minute next
  // step, measured from the scheduled instant.
  assert.ok(
    Math.abs(outcome.dueAt - (NOW.getTime() + 15 * 60000)) < 1000,
    `due in ${(outcome.dueAt - NOW.getTime()) / 60000} min`,
  );
});

test("a same-day repeat of a review card still moves stability forward", () => {
  // The recall growth term is exp((1-R)*w) - 1, which is exactly 0 when R is
  // 1. With elapsedDays 0 retrievability is 1, so the card would sit still
  // forever without the SAME_DAY_ELAPSED substitution.
  const scheduler = new Scheduler();
  const card = reviewCard({ lastReview: new Date(NOW.getTime() - 60000).toISOString() });
  const outcome = scheduler.grade(card, 3, NOW);
  assert.ok(outcome.stability > card.stability, `stability stalled at ${outcome.stability}`);
  assert.equal(SAME_DAY_ELAPSED, 0.5);
});

test("elapsed days are reported from the last review", () => {
  const scheduler = new Scheduler();
  const card = reviewCard({ lastReview: new Date(NOW.getTime() - 5 * 86400000).toISOString() });
  const outcome = scheduler.grade(card, 3, NOW);
  assert.ok(Math.abs(outcome.elapsedDays - 5) < 1e-6, `elapsed ${outcome.elapsedDays}`);
});

test("a future lastReview date does not produce negative elapsed time", () => {
  const scheduler = new Scheduler();
  const card = reviewCard({ lastReview: new Date(NOW.getTime() + 86400000).toISOString() });
  const outcome = scheduler.grade(card, 3, NOW);
  assert.ok(outcome.elapsedDays >= 0);
});

// --- degenerate state -------------------------------------------------------

test("a review card with difficulty 0 does not raise a domain error", () => {
  // 0 ** -0.11 is a math domain error; an imported or hand-edited state can
  // legitimately carry difficulty 0.
  const scheduler = new Scheduler();
  const outcome = scheduler.grade(reviewCard({ difficulty: 0, stability: 10 }), 1, NOW);
  assert.ok(Number.isFinite(outcome.stability));
  assert.ok(Number.isFinite(outcome.difficulty));
  assert.ok(outcome.stability > 0);
});

test("a review card with no memory state is seeded rather than dividing by zero", () => {
  const scheduler = new Scheduler();
  const outcome = scheduler.grade(reviewCard({ stability: 0, difficulty: 0 }), 3, NOW);
  assert.ok(Number.isFinite(outcome.stability) && outcome.stability > 0);
  assert.ok(Number.isFinite(outcome.difficulty) && outcome.difficulty > 0);
});

test("a corrupt lastReview timestamp degrades to zero elapsed", () => {
  const scheduler = new Scheduler();
  const outcome = scheduler.grade(reviewCard({ lastReview: "not-a-date" }), 3, NOW);
  assert.equal(outcome.elapsedDays, 0);
  assert.ok(Number.isFinite(outcome.intervalDays));
});

// --- review-state behaviour -------------------------------------------------

test("Again on a review card moves it to relearning with the first relearning step", () => {
  const scheduler = new Scheduler();
  const card = reviewCard();
  const outcome = scheduler.grade(card, 1, NOW);
  assert.equal(outcome.stateAfter, "relearning");
  assert.equal(outcome.learningStep, 0);
  assert.equal(outcome.intervalLabel, "10 min");
  assert.equal(outcome.lapses, undefined); // lapses are the store's job
  assert.ok(outcome.stability <= card.stability, "post-lapse stability grew");
  assert.equal(outcome.scheduledDays, 10);
});

test("Hard never shortens an interval that is already long", () => {
  const scheduler = new Scheduler();
  const card = reviewCard({ stability: 100, intervalDays: 100, difficulty: 5 });
  const outcome = scheduler.grade(card, 2, NOW);
  assert.ok(outcome.intervalDays >= 100, `interval shrank to ${outcome.intervalDays}`);
});

test("a review card's rating order produces ascending intervals", () => {
  const scheduler = new Scheduler();
  const card = reviewCard();
  const intervals = [1, 2, 3, 4].map((rating) => scheduler.grade(card, rating, NOW).intervalDays);
  // Again is a relearning step in minutes; the rest ascend.
  assert.ok(intervals[0] < 1, "again should be a sub-day step");
  assert.ok(intervals[1] < intervals[2], `${intervals[1]} !< ${intervals[2]}`);
  assert.ok(intervals[2] < intervals[3], `${intervals[2]} !< ${intervals[3]}`);
});

test("grading never mutates the card it is given", () => {
  const scheduler = new Scheduler();
  const card = reviewCard();
  const snapshot = JSON.stringify(card);
  scheduler.grade(card, 3, NOW);
  scheduler.preview(card, NOW);
  assert.equal(JSON.stringify(card), snapshot);
});

test("preview yields a label for all four buttons", () => {
  const scheduler = new Scheduler();
  const preview = scheduler.preview(newCard(), NOW);
  assert.deepEqual(Object.keys(preview).sort(), ["again", "easy", "good", "hard"]);
  for (const label of Object.values(preview)) assert.ok(label.length > 0);
});

test("retrievabilityNow is 0 for a card that has never been reviewed", () => {
  const scheduler = new Scheduler();
  assert.equal(scheduler.retrievabilityNow(newCard(), NOW), 0);
});

// --- configuration ----------------------------------------------------------

test("normalizeConfig clamps retention and rejects bad step lists", () => {
  const config = normalizeConfig({ desiredRetention: 1.5, learningSteps: [], relearningSteps: [-1] });
  assert.equal(config.desiredRetention, 0.99);
  assert.deepEqual(config.learningSteps, [10]);
  assert.deepEqual(config.relearningSteps, [10]);
});

test("normalizeConfig falls back to the published weights", () => {
  assert.deepEqual(normalizeConfig({ weights: [1, 2] }).weights, DEFAULT_CONFIG.weights);
  const custom = Array.from({ length: 19 }, (_, i) => i + 1);
  assert.deepEqual(normalizeConfig({ weights: custom }).weights, custom);
});

test("a custom single-step ladder graduates on the second Good", () => {
  // A new card's first Good only *enters* the ladder (it starts at the step
  // before step 0). Graduation therefore needs one more Good, even when the
  // ladder has a single rung -- otherwise "1 minute" would silently become
  // "skip learning entirely" as soon as the user shortened the step list.
  const scheduler = new Scheduler({ learningSteps: [5] });
  const first = scheduler.grade(newCard(), 3, NOW);
  assert.equal(first.stateAfter, "learning");
  assert.equal(first.learningStep, 0);
  assert.equal(first.intervalLabel, "5 min");

  const atStep0 = newCard({
    state: "learning",
    learningStep: 0,
    stability: first.stability,
    difficulty: first.difficulty,
    reps: 1,
    lastReview: new Date(NOW.getTime() - 300000).toISOString(),
    due: new Date(NOW.getTime() - 1000).toISOString(),
  });
  const second = scheduler.grade(atStep0, 3, NOW);
  assert.equal(second.stateAfter, "review");
  assert.equal(second.learningStep, null);
  assert.ok(second.intervalDays >= 1, `graduated to ${second.intervalDays} days`);
});

// --- due-value helpers ------------------------------------------------------

test("dueInstant distinguishes civil days from instants", () => {
  assert.equal(dueInstant("2026-03-04"), null);
  assert.equal(dueInstant(""), null);
  assert.equal(dueInstant("2026-03-04T12:00:00Z"), Date.UTC(2026, 2, 4, 12));
  assert.equal(dueInstant("garbage"), null);
});

test("isOverdue treats a civil day as due for the whole of that day", () => {
  // Changing this to "due at midnight" is the classic off-by-one: cards would
  // show as overdue the entire day they are due.
  assert.equal(isOverdue("2026-03-04", NOW), false);
  assert.equal(isOverdue("2026-03-03", NOW), true);
  assert.equal(isOverdue("2026-03-05", NOW), false);
  assert.equal(isOverdue("2026-03-04T11:00:00Z", NOW), true);
  assert.equal(isOverdue("2026-03-04T13:00:00Z", NOW), false);
});

test("a graduated review interval is stored as a civil day", () => {
  const scheduler = new Scheduler();
  const card = reviewCard({ stability: 1000, intervalDays: 1000 });
  const outcome = scheduler.grade(card, 3, NOW);
  assert.match(outcome.due, /^\d{4}-\d{2}-\d{2}$/);
});