/**
 * The encoder choice, and nothing else.
 *
 * This is the whole of what moved into the SDK. The `MediaRecorder` lifecycle
 * stayed in each plugin because it owns a live microphone, so what is asserted
 * here is only the decision that has to agree between the two of them: which
 * format gets tried, in what order, and what "none of them" means.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RECORDING_LIMIT_MS,
  RECORDING_MIME_CANDIDATES,
  detectRecordingMime,
  pickRecordingMime,
} from "../.build/recorder.js";

test("the first candidate is Opus in WebM, which Chromium always ships", () => {
  assert.equal(RECORDING_MIME_CANDIDATES[0], "audio/webm;codecs=opus");
  assert.equal(pickRecordingMime(() => true), RECORDING_MIME_CANDIDATES[0]);
});

test("the first candidate the environment claims wins", () => {
  // A build that has WebM but not Opus must get plain WebM, not the Opus string
  // it would fail to start with.
  assert.equal(pickRecordingMime((mime) => mime === "audio/webm"), "audio/webm");
  assert.equal(pickRecordingMime((mime) => mime === "audio/mp4"), "audio/mp4");
  assert.equal(pickRecordingMime((mime) => mime === "audio/ogg;codecs=opus"), "audio/ogg;codecs=opus");
});

test("no supported candidate is null, never a silent fallback to the first", () => {
  // Returning the first candidate here would produce a recorder that fails on
  // start, which the user reads as "the plugin is broken" rather than "this
  // build cannot record".
  assert.equal(pickRecordingMime(() => false), null);
});

test("the candidates are asked about in order, and asking stops at the first hit", () => {
  const asked = [];
  pickRecordingMime((mime) => {
    asked.push(mime);
    return mime === "audio/webm";
  });
  assert.deepEqual(asked, ["audio/webm;codecs=opus", "audio/webm"]);
});

test("detectRecordingMime reads the real constructor when one is available", () => {
  const fake = { isTypeSupported: (mime) => mime === "audio/webm" };
  assert.equal(detectRecordingMime(fake), "audio/webm");
});

test("detectRecordingMime treats a missing or partial constructor as no support", () => {
  // Optional-chained rather than assumed: an Electron build that dropped
  // `isTypeSupported` must read as "cannot record", not throw from inside a
  // choice function where the caller has no branch for it.
  assert.equal(detectRecordingMime({}), null);
  assert.equal(detectRecordingMime({ isTypeSupported: "not a function" }), null);
  assert.equal(detectRecordingMime(undefined), null);
});

test("the recording limit is five minutes", () => {
  assert.equal(RECORDING_LIMIT_MS, 300_000);
});
