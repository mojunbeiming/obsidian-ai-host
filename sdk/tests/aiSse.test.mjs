/**
 * The SSE parser against the chunk boundaries a real server never produces.
 *
 * The important test here is the exhaustive one: the same stream is split at
 * *every* offset and must parse identically. Everything else pins one decision
 * (which separators count, what a multi-line `data:` means, that a bad payload
 * is reported rather than thrown) so a future rewrite that keeps the exhaustive
 * property but changes a rule is still caught.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_SSE_DONE, AiSseParser, isDoneFrame, tryParseSseJson } from "../.build/ai/aiSse.js";

/** Push every chunk, then flush, returning the frames in order. */
function collect(chunks) {
  const parser = new AiSseParser();
  const frames = [];
  for (const chunk of chunks) frames.push(...parser.push(chunk));
  frames.push(...parser.flush());
  return frames;
}

test("two frames separated by a blank line parse into two frames", () => {
  assert.deepEqual(collect(['data: {"a":1}\n\ndata: {"b":2}\n\n']), [
    { event: "message", data: '{"a":1}', id: "" },
    { event: "message", data: '{"b":2}', id: "" },
  ]);
});

test("the same stream parses identically at every split offset", () => {
  // Unicode and a multi-line data payload on purpose: both are what a naive
  // per-chunk `toString()` or `split("\n")` gets wrong.
  const stream =
    "event: message_start\n" +
    'data: {"text":"你好"}\n' +
    "data: second line\n" +
    "id: 7\n\n" +
    'data: {"n":2}\r\n\r\n' +
    "data: [DONE]\n\n";
  const expected = collect([stream]);
  assert.equal(expected.length, 3);
  for (let offset = 0; offset <= stream.length; offset += 1) {
    const frames = collect([stream.slice(0, offset), stream.slice(offset)]);
    assert.deepEqual(frames, expected, `split at ${offset}`);
  }
});

test("CR-only and CRLF boundaries both end a frame", () => {
  assert.deepEqual(collect(["data: a\r\rdata: b\r\r"]), [
    { event: "message", data: "a", id: "" },
    { event: "message", data: "b", id: "" },
  ]);
  assert.deepEqual(collect(["event: x\r\ndata: y\r\n\r\n"]), [{ event: "x", data: "y", id: "" }]);
});

test("multiple data lines join with a newline, and one leading space is protocol", () => {
  assert.deepEqual(collect(["data: first\ndata:  indented\n\n"]), [
    { event: "message", data: "first\n indented", id: "" },
  ]);
});

test("comments and unknown fields are ignored", () => {
  const frames = collect([": keep-alive\n\n", "future: yes\ndata: x\n\n"]);
  assert.deepEqual(frames, [{ event: "message", data: "x", id: "" }]);
});

test("event, id and a valid retry survive; an invalid retry is dropped", () => {
  assert.deepEqual(collect(["event: ping\nid: 42\nretry: 1500\ndata: {}\n\n"]), [
    { event: "ping", data: "{}", id: "42", retry: 1500 },
  ]);
  const bad = collect(["retry: soon\ndata: {}\n\n"]);
  assert.equal(bad[0].retry, undefined);
});

test("an empty data buffer dispatches nothing", () => {
  assert.deepEqual(collect(["data:\n\n", "data: \n\n"]), []);
});

test("flush emits a final frame that never got its blank line", () => {
  assert.deepEqual(collect(["data: tail"]), [{ event: "message", data: "tail", id: "" }]);
});

test("a UTF-8 BOM is not part of the first field name", () => {
  assert.deepEqual(collect(["\uFEFFdata: x\n\n"]), [{ event: "message", data: "x", id: "" }]);
});

test("bytes feed through a streaming decoder, so a split emoji is reassembled", () => {
  const text = 'data: {"text":"前面后面"}\n\n';
  const bytes = new TextEncoder().encode(text);
  const parser = new AiSseParser();
  const frames = [];
  for (let index = 0; index < bytes.length; index += 1) {
    // One byte at a time: the worst case for a decoder that is not streaming.
    frames.push(...parser.push(bytes.slice(index, index + 1)));
  }
  frames.push(...parser.flush());
  assert.deepEqual(frames, [{ event: "message", data: '{"text":"前面后面"}', id: "" }]);
});

test("a malformed JSON payload is reported and skipped, not thrown", () => {
  const problems = [];
  const parser = new AiSseParser({ onError: (problem) => problems.push(problem) });
  const frames = parser.push("data: {oops\n\ndata: {\"ok\":true}\n\n");
  frames.push(...parser.flush());
  // Parsing happens when the *consumer* asks for it, not during the push: the
  // parser's job is framing, and an adapter may want the raw text of a frame
  // before deciding it is JSON at all. So the error is reported by parseJson.
  parser.parseJson(frames[0]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, "json");
  assert.equal(problems[0].raw, "{oops");
  const parsed = parser.parseJson(frames[1]);
  assert.deepEqual(parsed, { ok: true, value: { ok: true } });

  const free = tryParseSseJson(frames[0]);
  assert.equal(free.ok, false);
});

test("the done sentinel is recognized with and without the space", () => {
  const frames = collect(["data: [DONE]\n\n", "data:[DONE]\n\n"]);
  assert.ok(frames.every((frame) => isDoneFrame(frame)));
  assert.ok(!isDoneFrame({ event: "message", data: "hello [DONE]", id: "" }));
  assert.equal(AI_SSE_DONE, "[DONE]");
});