/**
 * An in-memory stand-in for the filesystem shim.
 *
 * The persistence module takes its filesystem as a parameter precisely so it
 * can be tested this way: the interesting behaviour is atomicity, backup and
 * partial-line tolerance, and none of that needs a real disk -- while a real
 * disk would make the corruption cases impossible to trigger on purpose.
 */
export function memoryFs() {
  const files = new Map();
  const mtimes = new Map();
  let clock = 1_000_000;

  const touch = (path) => {
    clock += 1;
    mtimes.set(path, clock);
  };

  return {
    files,
    readFile: (path) => (files.has(path) ? files.get(path) : null),
    writeFile: (path, content) => {
      files.set(path, content);
      touch(path);
    },
    appendFile: (path, content) => {
      files.set(path, (files.get(path) ?? "") + content);
      touch(path);
    },
    rename: (from, to) => {
      if (!files.has(from)) throw new Error(`rename: ${from} does not exist`);
      files.set(to, files.get(from));
      files.delete(from);
      mtimes.delete(from);
      touch(to);
    },
    remove: (path) => {
      files.delete(path);
      mtimes.delete(path);
    },
    exists: (path) => files.has(path),
    mtime: (path) => mtimes.get(path) ?? null,
  };
}

/** A minimal card with sensible defaults, so tests state only what matters. */
export function card(overrides = {}) {
  return {
    id: "c1",
    file: "notes/a.md",
    kind: "basic",
    deck: "d1",
    tags: [],
    state: "new",
    due: "2026-03-04",
    learningStep: null,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    intervalDays: 0,
    lastReview: null,
    suspended: false,
    ...overrides,
  };
}

export function review(overrides = {}) {
  return {
    id: "r1",
    cardId: "c1",
    deck: "d1",
    rating: 3,
    stateBefore: "review",
    stateAfter: "review",
    intervalDays: 10,
    scheduledDays: 10,
    elapsedDays: 10,
    durationMs: 4000,
    reviewedAt: "2026-03-04T12:00:00Z",
    day: "2026-03-04",
    stability: 10,
    difficulty: 5,
    ...overrides,
  };
}