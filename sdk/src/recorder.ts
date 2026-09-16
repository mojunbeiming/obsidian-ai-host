/**
 * Recording helpers shared by the two plugins.
 *
 * The plugin that records audio for a card and the one that records a spoken
 * plan are asking the same question -- "which encoder does this Electron build
 * actually have?" -- and a second copy of the answer is how one of them starts
 * preferring a format the other refuses. So the candidate list and the choice
 * live here, in a module with no Obsidian and no DOM at import time.
 *
 * Only the *pure* part is here on purpose. The `MediaRecorder` lifecycle stays
 * in each plugin, because it owns a live microphone and a live `Notice`: the
 * flashcard side attaches it to the studio's abort signal, and the planning side
 * attaches it to a modal's close button. Sharing that would mean inventing a
 * callback contract for two call sites with nothing else in common -- and unlike
 * a wrong mime choice, a wrong microphone lifecycle fails loudly.
 *
 * Pure: a predicate in, a mime type out.
 */

/**
 * The formats to try, in order.
 *
 * Opus-in-WebM first because that is what Chromium ships on every desktop it
 * runs on, and Electron is Chromium. The rest are there because a platform build
 * can drop one without dropping `MediaRecorder` itself -- and the failure that
 * matters is not "no recorder" but "a recorder that stops on start", which is
 * why every candidate is *asked about* rather than assumed.
 */
export const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

/** Which candidate this environment claims to support, or null if none. */
export function pickRecordingMime(supported: (mime: string) => boolean): string | null {
  for (const mime of RECORDING_MIME_CANDIDATES) {
    if (supported(mime)) return mime;
  }
  return null;
}

/**
 * The same answer, read off the global `MediaRecorder`.
 *
 * Optional-chained rather than assumed: recording is started from a command or a
 * button, which can run in a context where the constructor exists but
 * `isTypeSupported` was never attached (or was removed by a future Electron). A
 * missing method must read as "this format is not supported", which is a branch
 * the caller already has to handle, not as a `TypeError` thrown from inside a
 * choice function.
 *
 * Returning `null` here is the caller's cue to say "this environment cannot
 * record" -- never to record anyway. An encoder that was never confirmed is the
 * one failure mode that produces a file the user cannot play.
 */
export function detectRecordingMime(recorder: typeof MediaRecorder | undefined = undefined): string | null {
  const ctor = recorder ?? (typeof MediaRecorder === "undefined" ? undefined : MediaRecorder);
  if (!ctor || typeof ctor.isTypeSupported !== "function") return null;
  return pickRecordingMime((mime) => ctor.isTypeSupported(mime));
}

/** How long a single recording may run, in milliseconds. */
export const RECORDING_LIMIT_MS = 5 * 60 * 1000;