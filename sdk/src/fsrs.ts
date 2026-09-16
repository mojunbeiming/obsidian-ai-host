/**
 * FSRS-5 memory model with Anki-style learning steps.
 *
 * Why not FSRS alone: a pure FSRS output for a zero-state card is "a few days",
 * so a learner never sees a brand new card twice in the first session and the
 * experience reads as "I could not remember it". Mature schedulers therefore
 * keep a short *learning* phase in front of the long-term model, and this file
 * implements the same two-stage design:
 *
 * * ``learning`` / ``relearning`` are driven by explicit step lists (minutes)
 *   and never touch FSRS;
 * * ``review`` is driven purely by the FSRS memory state ``(stability,
 *   difficulty)``, where stability means "days until the probability of recall
 *   decays to 90%".
 *
 * The maths follows FSRS-5 (19 weights, ``DECAY = -0.5``). ``RETENTION_OFFSET``
 * is chosen so ``R(S, S) === 0.9`` to floating-point precision, which is what
 * makes ``desiredRetention`` meaningful once the interval formula inverts the
 * forgetting curve.
 *
 * References: open-spaced-repetition/free-spaced-repetition-scheduler,
 * open-spaced-repetition/py-fsrs.
 *
 * This module is pure: it never mutates the card it is given, and it never
 * reads a clock. That makes every branch directly unit-testable, which matters
 * because the edge cases below are the ones that actually bite.
 */

import { DAY_MS, MINUTES_PER_DAY, addDays, dayOfInstant, daysBetween, isoTimestamp, timestampValue } from "./clock";
import { formatInterval, formatMinutes } from "./interval";

export type Rating = 1 | 2 | 3 | 4;
export type CardState = "new" | "learning" | "relearning" | "review";

/** The four Anki buttons, in display order. */
export const RATINGS: Rating[] = [1, 2, 3, 4];

export const RATING_LABELS: Record<Rating, string> = {
  1: "again",
  2: "hard",
  3: "good",
  4: "easy",
};

/**
 * What the four buttons say to the user.
 *
 * Kept separate from `RATING_LABELS` on purpose: those are *keys* -- they name
 * the CSS classes (`sfc-again` …) and appear in saved data, so translating them
 * in place would silently break styling and any stored reference. This is the
 * display layer, and the plugin's UI is Chinese.
 */
export const RATING_TEXT: Record<Rating, string> = {
  1: "重来",
  2: "困难",
  3: "良好",
  4: "简单",
};


const DECAY = -0.5;
/**
 * Chosen so that ``R(S, S) === 0.9`` exactly: stability is *defined* as the
 * number of days until recall decays to 90%, and this value is what makes that
 * definition true rather than approximately true.
 *
 * The published FSRS pseudocode writes the constant as
 * ``DECAY ** (-1) * ...``-style arithmetic in one place and as this closed form
 * in another; the closed form is the one the curve actually needs, and the
 * identity assertion in the tests is what pins it down.
 */
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // ~= 0.234568
const MIN_STABILITY = 0.01;
/** FSRS-5 mean-reverts the first stability/difficulty towards these values. */
const INITIAL_STABILITY_MEAN = 4.0;
const MEAN_REVERSION_FACTOR = 0.05;

/** Weights published with FSRS-5. Overridable per deck. */
export const DEFAULT_WEIGHTS: number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

/**
 * Elapsed days used when a card is answered more than once on the same day.
 *
 * The recall formula's growth term is ``exp((1 - R) * w) - 1``, which is
 * exactly 0 when ``R === 1``. With ``elapsedDays === 0`` retrievability is 1,
 * so a same-day repeat would leave stability untouched -- the card would never
 * move forward. Half a day is the smallest value that keeps it moving.
 */
export const SAME_DAY_ELAPSED = 0.5;

/** Any memory state that predates FSRS. Review cards start here. */
export interface CardMemory {
  state: CardState;
  /** ``YYYY-MM-DD`` for day-level cards, ISO UTC instant for sub-day ones. */
  due: string;
  learningStep: number | null;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  intervalDays: number;
  lastReview: string | null;
}

export interface SchedulerConfig {
  desiredRetention: number;
  learningSteps: number[];
  relearningSteps: number[];
  maximumIntervalDays: number;
  minimumIntervalDays: number;
  easyIntervalDays: number;
  hardMultiplier: number;
  weights: number[];
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  desiredRetention: 0.9,
  learningSteps: [1, 10],
  relearningSteps: [10],
  maximumIntervalDays: 36500,
  minimumIntervalDays: 1,
  easyIntervalDays: 4,
  hardMultiplier: 1.2,
  weights: DEFAULT_WEIGHTS,
};

export interface IntervalPreview {
  again: string;
  hard: string;
  good: string;
  easy: string;
}

export interface ReviewOutcome {
  rating: Rating;
  stateBefore: CardState;
  stateAfter: CardState;
  /** Where the card should be stored as due. */
  due: string;
  /** The same instant as a millisecond epoch, for comparisons. */
  dueAt: number;
  intervalDays: number;
  intervalLabel: string;
  /** Index into the learning step list; ``null`` once the card is in review. */
  learningStep: number | null;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  wasNew: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function normalizeConfig(partial: Partial<SchedulerConfig> = {}): SchedulerConfig {
  const merged = { ...DEFAULT_CONFIG, ...partial };
  return {
    desiredRetention: clamp(Number(merged.desiredRetention) || 0.9, 0.7, 0.99),
    learningSteps: normalizeSteps(merged.learningSteps, [10]),
    relearningSteps: normalizeSteps(merged.relearningSteps, [10]),
    maximumIntervalDays: Math.max(1, Math.round(merged.maximumIntervalDays)),
    minimumIntervalDays: Math.max(1, merged.minimumIntervalDays),
    easyIntervalDays: Math.max(1, merged.easyIntervalDays),
    hardMultiplier: Math.max(1, merged.hardMultiplier),
    weights:
      Array.isArray(merged.weights) && merged.weights.length >= 17
        ? merged.weights.slice()
        : DEFAULT_WEIGHTS.slice(),
  };
}

function normalizeSteps(steps: number[] | undefined, fallback: number[]): number[] {
  const cleaned = (steps ?? [])
    .map((step) => Number(step))
    .filter((step) => Number.isFinite(step) && step > 0);
  return cleaned.length ? cleaned : fallback.slice();
}

// ---------------------------------------------------------------------------
// FSRS primitives -- pure functions, unit tested directly
// ---------------------------------------------------------------------------

export function initStability(weights: number[], rating: Rating): number {
  return Math.max(MIN_STABILITY, Number(weights[rating - 1]));
}

export function initDifficulty(weights: number[], rating: Rating): number {
  return clamp(weights[4] - Math.exp(weights[5] * (rating - 1)) + 1, 1, 10);
}

/** Probability of recall after ``elapsedDays`` given ``stability``. */
export function retrievability(elapsedDays: number, stability: number, decay = DECAY): number {
  if (stability <= 0) return 0;
  // The decay is the *exponent*, so it divides the elapsed/stability ratio
  // rather than scaling it. Moving it inside the base (a plausible-looking
  // simplification) turns the curve into `1 - 0.047 * x`, which never decays
  // to zero and would make every long interval far too long.
  return Math.pow(1 + FACTOR * (Math.max(0, elapsedDays) / stability), decay);
}

/** Invert the forgetting curve: days until recall hits the target. */
export function intervalForStability(stability: number, desiredRetention: number): number {
  return (stability / FACTOR) * (Math.pow(desiredRetention, 1 / DECAY) - 1);
}

/**
 * Turn a stability value into a review interval in days.
 *
 * ``scheduledDays`` is the interval the card already had; it does not change the
 * result directly but is what the ``Hard`` guard in ``grade`` compares against.
 */
export function nextInterval(
  stability: number,
  config: SchedulerConfig,
  scheduledDays = 0,
): number {
  void scheduledDays;
  const raw = intervalForStability(stability, config.desiredRetention);
  const days = Math.max(config.minimumIntervalDays, raw);
  // Never schedule past the point where recall would fall below the target,
  // and never past the configured ceiling.
  const cap = Math.min(config.maximumIntervalDays, raw + 1);
  return Math.min(days, cap);
}

/** FSRS-5 difficulty update (linear damping + mean reversion). */
export function nextDifficulty(weights: number[], difficulty: number, rating: Rating): number {
  const delta = -weights[6] * (rating - 3);
  const damped = difficulty + (delta * (10 - difficulty)) / 9;
  const goodDifficulty = initDifficulty(weights, 3);
  let reverted = weights[7] * goodDifficulty + (1 - weights[7]) * damped;
  if (Math.abs(reverted - goodDifficulty) < 0.05) reverted = goodDifficulty;
  return clamp(reverted, 1, 10);
}

export function stabilityAfterRecall(
  weights: number[],
  difficulty: number,
  stability: number,
  recall: number,
  rating: Rating,
): number {
  const hardPenalty = rating === 2 ? weights[15] : 1;
  const easyBonus = rating === 4 ? weights[16] : 1;
  const growth =
    Math.exp(weights[8]) *
    (11 - difficulty) *
    Math.pow(stability, -weights[9]) *
    (Math.exp((1 - recall) * weights[10]) - 1) *
    hardPenalty *
    easyBonus;
  return Math.max(MIN_STABILITY, stability * (1 + growth));
}

/** FSRS-5 post-lapse stability, capped at the pre-lapse stability. */
export function stabilityAfterForgetting(
  weights: number[],
  difficulty: number,
  stability: number,
  recall: number,
): number {
  // A card can arrive with difficulty 0 (hand-edited state, or a half-written
  // import), and ``0 ** -0.11`` is a domain error -- so clamp the base.
  const safeDifficulty = Math.max(1, difficulty);
  const next =
    weights[11] *
    Math.pow(safeDifficulty, -weights[12]) *
    (Math.pow(stability + 1, weights[13]) - 1) *
    Math.exp((1 - recall) * weights[14]);
  return Math.max(MIN_STABILITY, Math.min(next, stability));
}

/**
 * FSRS-5 pulls a card's first stability towards the population mean, which
 * corrects a card the user finds unusually easy or hard on its very first
 * review.
 */
export function applyMeanReversion(stability: number, firstStability: number): number {
  return stability + (INITIAL_STABILITY_MEAN - firstStability) * MEAN_REVERSION_FACTOR;
}

export function nextStability(
  weights: number[],
  difficulty: number,
  stability: number,
  elapsedDays: number,
  rating: Rating,
): number {
  const recall = retrievability(Math.max(0, elapsedDays), stability);
  if (rating === 1) return stabilityAfterForgetting(weights, difficulty, stability, recall);
  return stabilityAfterRecall(weights, difficulty, stability, recall, rating);
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  readonly config: SchedulerConfig;

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = normalizeConfig(config);
  }

  /** Interval label for each of the four answer buttons. */
  preview(card: CardMemory, now: Date): IntervalPreview {
    const labels = {} as IntervalPreview;
    for (const rating of RATINGS) {
      // The one place the rating->key mapping has to be asserted rather than
      // inferred: RATING_LABELS is deliberately a plain Record<Rating, string>
      // so callers can print it, which loses the literal key type.
      const key = RATING_LABELS[rating] as keyof IntervalPreview;
      labels[key] = this.grade(card, rating, now).intervalLabel;
    }
    return labels;
  }

  /** Full outcome for one answer. The card is not modified. */
  grade(card: CardMemory, rating: Rating, now: Date): ReviewOutcome {
    const { moment, judged } = this.reference(card, now);
    if (card.state === "review") return this.gradeReview(card, rating, moment, judged);
    // Learning steps extend from when the current step was *due*, so answering
    // late does not push the remaining ladder back.
    return this.gradeLearning(card, rating, judged);
  }

  /** Recall probability right now -- used to order the review queue. */
  retrievabilityNow(card: CardMemory, now: Date): number {
    if (card.stability <= 0 || !card.lastReview) return 0;
    return retrievability(this.elapsedDays(card, now.getTime()), card.stability);
  }

  /**
   * The instant an answer is recorded, and the instant it is *judged*.
   *
   * Two different moments matter and conflating them causes real bugs:
   *
   * * **recorded** (``moment``) is always wall-clock now. Every new due date
   *   is computed from it. Anchoring a new interval to a *past* due instant
   *   would happily schedule the next step at a moment that has already
   *   elapsed, so a card could come back the instant it was answered.
   * * **judged** is when the card is treated as having been answered, for the
   *   elapsed-time maths only. Answering *before* the due instant uses the
   *   scheduled instant, which keeps a short learning ladder from being
   *   silently shortened by early clicking.
   *
   * A due instant in the past is ignored entirely.
   */
  private reference(card: CardMemory, now: Date): { moment: number; judged: number } {
    const moment = now.getTime();
    if (card.state === "learning" || card.state === "relearning") {
      const scheduled = dueInstant(card.due);
      // Only a due instant still in the FUTURE is used as the judging moment.
      // A due instant in the past is stale -- an imported card, or a step the
      // user simply answered late -- and using it would compute the elapsed
      // time from before the card's own last review, which yields a *shorter*
      // elapsed time the later the user answers. That is the wrong direction,
      // and it silently mis-grows stability.
      if (scheduled !== null && scheduled > moment) return { moment, judged: scheduled };
    }
    return { moment, judged: moment };
  }

  /**
   * Elapsed time has a floor of zero.
   *
   * Clamping rather than rejecting keeps a clock skew, a card imported with a
   * future review date, or a manually edited state from producing a negative
   * elapsed time, which would otherwise propagate NaN through the stability
   * update and freeze the card forever.
   */
  private elapsedDays(card: CardMemory, judged: number): number {
    if (!card.lastReview) return 0;
    const reference = timestampValue(card.lastReview);
    if (!Number.isFinite(reference)) return 0;
    return Math.max(0, (judged - reference) / DAY_MS);
  }

  /** Same-day repeats need a non-zero elapsed time for the maths to move. */
  private effectiveElapsed(card: CardMemory, elapsed: number): number {
    if (elapsed <= 0 && card.reps > 0) return SAME_DAY_ELAPSED;
    return elapsed;
  }

  private gradeReview(card: CardMemory, rating: Rating, moment: number, judged: number): ReviewOutcome {
    const weights = this.config.weights;
    // A review card can carry no memory state (hand-edited, or a half-written
    // import). Seed it rather than dividing by zero or tripping Math.pow.
    const stability0 = card.stability > 0 ? card.stability : initStability(weights, 3);
    const difficulty0 = card.difficulty > 0 ? card.difficulty : initDifficulty(weights, 3);

    const elapsed = this.elapsedDays(card, judged);
    const effective = this.effectiveElapsed(card, elapsed);
    const recall = retrievability(effective, stability0);
    const difficulty = nextDifficulty(weights, difficulty0, rating);
    const scheduled = card.intervalDays || 0;

    if (rating === 1) {
      const stability = stabilityAfterForgetting(weights, difficulty0, stability0, recall);
      const stepMinutes = this.config.relearningSteps[0];
      const due = moment + stepMinutes * 60000;
      return {
        rating,
        stateBefore: "review",
        stateAfter: "relearning",
        due: isoTimestamp(new Date(due)),
        dueAt: due,
        intervalDays: stepMinutes / MINUTES_PER_DAY,
        intervalLabel: formatMinutes(stepMinutes),
        learningStep: 0,
        stability,
        difficulty,
        elapsedDays: elapsed,
        scheduledDays: scheduled,
        wasNew: false,
      };
    }

    let stability = stabilityAfterRecall(weights, difficulty0, stability0, recall, rating);
    if (rating === 2 && scheduled >= 1) {
      // Hard must never shorten an interval that is already long.
      stability = Math.max(stability, stability0 * this.config.hardMultiplier);
    }
    const days = nextInterval(stability, this.config, scheduled);
    return this.finish(
      "review", rating, "review",
      scheduleDays(moment, days), days, null, stability, difficulty, elapsed, scheduled,
    );
  }

  private gradeLearning(card: CardMemory, rating: Rating, moment: number): ReviewOutcome {
    const weights = this.config.weights;
    const relearning = card.state === "relearning";
    const steps = relearning ? this.config.relearningSteps : this.config.learningSteps;

    let difficulty: number;
    let stability: number;
    if (card.state === "new") {
      difficulty = initDifficulty(weights, rating);
      // Seed FSRS from the weight table, then mean-revert (FSRS-5).
      stability = applyMeanReversion(initStability(weights, rating), weights[rating - 1]);
    } else {
      difficulty = nextDifficulty(weights, card.difficulty > 0 ? card.difficulty : initDifficulty(weights, 3), rating);
      if (card.stability <= 0) {
        stability = applyMeanReversion(initStability(weights, rating), weights[rating - 1]);
      } else {
        const elapsed = this.effectiveElapsed(card, this.elapsedDays(card, moment));
        stability = nextStability(weights, card.difficulty, card.stability, elapsed, rating);
      }
    }

    const elapsedDays = this.elapsedDays(card, moment);
    const scheduled = card.intervalDays || 0;

    const base = {
      rating,
      stateBefore: card.state,
      stability,
      difficulty,
      elapsedDays,
      scheduledDays: scheduled,
      wasNew: card.state === "new",
    };

    if (rating === 4 && card.state === "new") {
      // Anki's "Easy" skips the remaining learning steps entirely.
      //
      // Guarded on the state rather than on "not relearning": a card in
      // *learning* has already been answered at least once and is carrying a
      // real memory state, so jumping it to the easy interval would throw that
      // evidence away. Only a genuinely new card gets the shortcut.
      const days = this.config.easyIntervalDays;
      const boosted = Math.max(stability, this.easyStability(days));
      return {
        ...base,
        stability: boosted,
        stateAfter: "review",
        due: scheduleDays(moment, days),
        dueAt: moment + days * DAY_MS,
        intervalDays: days,
        intervalLabel: formatInterval(days),
        learningStep: null,
      };
    }

    // A brand new card sits *before* the first step: Good sends it to step 0
    // (e.g. 1 minute) and Hard keeps it there. This matches Anki, where the
    // first answer on a new card starts the learning ladder rather than
    // skipping its first rung. Getting this wrong is invisible until a test
    // asserts the step order.
    // Where this answer lands in the ladder.
    //
    // Again restarts it. Hard *repeats* the current step rather than advancing,
    // which is why its index is the current one -- clamped into range so a card
    // whose stored step is out of bounds (after the step list was shortened in
    // settings) still gets a real step. Everything else advances, and an index
    // past the end is precisely how a card graduates.
    let index: number;
    if (rating === 1) {
      index = 0;
    } else if (rating === 2) {
      const current = card.state === "new" ? 0 : (card.learningStep ?? 0);
      index = Math.min(Math.max(0, current), steps.length - 1);
    } else {
      const current = card.state === "new" ? -1 : (card.learningStep ?? 0);
      index = current + 1;
    }

    if (index >= steps.length) {
      // Graduated: hand the card over to FSRS.
      const days = nextInterval(stability, this.config, scheduled);
      return {
        ...base,
        stateAfter: "review",
        due: scheduleDays(moment, days),
        dueAt: moment + days * DAY_MS,
        intervalDays: days,
        intervalLabel: formatInterval(days),
        learningStep: null,
      };
    }

    const minutes = steps[index];
    const due = moment + minutes * 60000;
    return {
      ...base,
      stateAfter: relearning ? "relearning" : "learning",
      due: isoTimestamp(new Date(due)),
      dueAt: due,
      intervalDays: minutes / MINUTES_PER_DAY,
      intervalLabel: formatMinutes(minutes),
      learningStep: index,
    };
  }

  private finish(
    stateBefore: CardState,
    rating: Rating,
    stateAfter: CardState,
    due: string,
    days: number,
    learningStep: number | null,
    stability: number,
    difficulty: number,
    elapsedDays: number,
    scheduledDays: number,
  ): ReviewOutcome {
    const dueAt = dueInstant(due) ?? 0;
    return {
      rating,
      stateBefore,
      stateAfter,
      due,
      dueAt,
      intervalDays: days,
      intervalLabel: formatInterval(days),
      learningStep,
      stability,
      difficulty,
      elapsedDays,
      scheduledDays,
      wasNew: stateBefore === "new",
    };
  }

  /**
   * Stability whose interval equals ``days`` at the target retention.
   *
   * ``nextInterval`` inverts the forgetting curve, so this runs that inversion
   * backwards: seeding a new card answered *Easy* with this value makes the
   * resulting interval exactly ``easyIntervalDays`` rather than a value that
   * happens to round near it.
   */
  private easyStability(days: number): number {
    return (days * FACTOR) / (Math.pow(this.config.desiredRetention, 1 / DECAY) - 1);
  }
}

/** A due value as an epoch, or null when it is a plain civil day. */
export function dueInstant(due: string): number | null {
  if (!due || /^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  const value = timestampValue(due);
  return Number.isFinite(value) ? value : null;
}

/** Intervals of a day or more are stored as civil days; shorter ones as instants. */
function scheduleDays(moment: number, days: number): string {
  if (days >= 1) {
    // Interval of a day or more: store a civil day, so "due today" survives a
    // timezone change and stays an equality test rather than a range.
    return addDays(dayOfInstant(moment), Math.round(days));
  }
  return isoTimestamp(new Date(moment + days * DAY_MS));
}

/** Is this due value already in the past? */
export function isOverdue(due: string, now: Date): boolean {
  const instant = dueInstant(due);
  if (instant !== null) return instant <= now.getTime();
  // A civil day is due the whole of that day, so it only counts as overdue
  // once the day has actually passed.
  return daysBetween(due, dayOfInstant(now.getTime())) > 0;
}