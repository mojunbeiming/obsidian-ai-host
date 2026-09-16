/**
 * Whether the configured endpoint actually answers, kept as state rather than as
 * a button the user has to remember to press.
 *
 * ## Why this is a module with state and not a `check()` plus a caller
 *
 * The first version of the AI panels only ran `checkAiConfig`, which validates the
 * *form*: are the fields filled in, is the address usable. So "I pasted my key"
 * and "my key works" looked exactly the same on screen, and the card centre never
 * changed when a key started working -- the user's report was "it does not update
 * whether I am connected", and the reason was that nothing ever asked.
 *
 * Asking costs a round trip, so it cannot happen on every render either: a pane
 * redraws on every answer, every tab switch and every scan. Hence one place that
 * owns the answer, remembers when it was taken, and only spends a request when the
 * answer is stale or the configuration has changed.
 *
 * ## The three things that make it honest
 *
 * * **Keyed by the configuration.** Change the model or the key and the previous
 *   verdict is about a different setup, so it is discarded rather than shown.
 * * **Stale, not wrong.** A verdict older than `STALE_MS` is reported as unknown
 *   while a re-check runs, rather than presented as current.
 * * **One request at a time.** Several panels render on every redraw; without the
 *   in-flight map they would each fire their own probe, which is how a status
 *   indicator turns into a rate limiter.
 *
 * Pure apart from the injected probe: no Obsidian, no timer of its own.
 */

/** How long a verdict is presented as current, in ms. */
export const AI_STATUS_STALE_MS = 60_000;

export interface AiStatusVerdict {
  ok: boolean;
  /** A sentence for the panel: what answered, or exactly what went wrong. */
  message: string;
  /** `Date.now()` at the moment the probe returned. */
  at: number;
  /** The endpoint the verdict is about, for diagnostics. */
  endpoint: string;
  model: string;
}

export interface AiStatusState {
  verdict: AiStatusVerdict | null;
  /** True while a probe is in flight, so the panel can say "正在检测". */
  checking: boolean;
}

/**
 * The key a verdict is filed under.
 *
 * Everything that could change the outcome: a different key, model, address,
 * protocol or provider is a different question. The timeout is deliberately
 * **not** part of it -- a slow answer and a fast answer are the same answer, and
 * including it would discard a verdict for a change that cannot invalidate it.
 */
export function statusKey(config: {
  provider: string;
  baseUrl: string;
  protocol: string;
  model: string;
  apiKey: string;
}): string {
  return [config.provider, config.baseUrl, config.protocol, config.model, config.apiKey].join("\u0000");
}

/** How old a verdict is, or null when there is none. */
export function verdictAge(verdict: AiStatusVerdict | null, now: number): number | null {
  return verdict ? now - verdict.at : null;
}

/**
 * Yes when a verdict exists and is still worth presenting as current.
 *
 * A stale verdict is not wrong, it is *old* -- so the panel says "last checked N
 * minutes ago" and starts a re-check rather than either lying or blanking the
 * status. Blanking on a timer would make a working connection look intermittent.
 */
export function isFresh(verdict: AiStatusVerdict | null, now: number, staleMs = AI_STATUS_STALE_MS): boolean {
  const age = verdictAge(verdict, now);
  return age !== null && age < staleMs;
}

/**
 * The connection status, owned by whoever creates it.
 *
 * Created per plugin rather than kept at module scope: two plugins in one vault
 * have two settings and two endpoints, and a shared singleton would have them
 * overwrite each other's verdicts.
 */
export class AiStatusTracker {
  private state: AiStatusState = { verdict: null, checking: false };
  /** The configuration the current verdict is about. */
  private keyOf = "";
  /** The in-flight probe, so concurrent callers share one request. */
  private inFlight: Promise<AiStatusVerdict> | null = null;
  /** Subscribers, so a panel redraws itself when a verdict lands. */
  private listeners = new Set<() => void>();

  constructor(private readonly probe: () => Promise<{ message: string; endpoint: string; model: string }>) {}

  /** The current state, plus whether it is still worth believing. */
  snapshot(key: string, now = Date.now()): AiStatusState & { fresh: boolean } {
    const mine = this.keyOf === key;
    const verdict = mine ? this.state.verdict : null;
    return {
      verdict,
      checking: this.state.checking,
      fresh: isFresh(verdict, now),
    };
  }

  /** Called whenever a verdict or the checking flag changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Ask, unless the answer would be the one we already have.
   *
   * `force` is for the 重新检测 button: a user pressing it has decided the cached
   * answer is wrong, and refusing to re-ask would make the button a lie.
   */
  async check(key: string, options: { force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    if (this.keyOf !== key) {
      // A different configuration: the old verdict describes a different setup,
      // so it goes away immediately rather than lingering as "connected".
      this.keyOf = key;
      this.state = { verdict: null, checking: this.state.checking };
      this.emit();
    }
    if (!options.force && isFresh(this.state.verdict, now)) return;
    if (this.inFlight) return this.inFlight.then(() => undefined);

    this.state = { ...this.state, checking: true };
    this.emit();
    this.inFlight = (async () => {
      try {
        const answer = await this.probe();
        return { ok: true, message: answer.message, at: Date.now(), endpoint: answer.endpoint, model: answer.model };
      } catch (error) {
        // A failure is a verdict too: "not connected, because X" is exactly the
        // thing the panel has to be able to show.
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
          endpoint: "",
          model: "",
        };
      }
    })();

    try {
      const verdict = await this.inFlight;
      this.state = { verdict, checking: false };
    } finally {
      this.inFlight = null;
      this.emit();
    }
  }

  /** Forget the verdict, so the next render re-checks. Used after a settings edit. */
  invalidate(): void {
    this.state = { verdict: null, checking: this.state.checking };
    this.keyOf = "";
    this.emit();
  }
}
