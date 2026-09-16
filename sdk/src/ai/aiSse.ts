/**
 * The SSE parser: pure text in, frames out.
 *
 * ## Why it is separated from the socket
 *
 * Server-sent events are the worst possible thing to test through a server: the
 * interesting cases are a frame split at every byte offset, two frame
 * terminators arriving in one read, and a multi-byte character cut in half --
 * none of which a real server produces on demand. A parser that takes strings
 * and byte chunks lets `node --test` construct all of them deterministically,
 * and the transport's job shrinks to "read bytes, hand them here".
 *
 * ## The three boundaries, and why all three
 *
 * The spec allows `\n`, `\r` and `\r\n` as line endings, so a frame ends at
 * `\n\n`, `\r\r` or `\r\n\r\n`. Servers disagree about which one is polite:
 * OpenAI sends `\n\n`; some gateways send `\r\n\r\n`; an old proxy in front of a
 * vLLM box was seen sending `\r\r`. The boundary search below finds the earliest
 * of the three and consumes the longest match at that offset, which is what
 * keeps `\r\n\r\n` from being read as two frames.
 *
 * ## Bytes are decoded with `{stream: true}`
 *
 * A `TextDecoder` without that option turns each chunk in isolation into
 * strings, so one emoji split across two reads becomes two replacement
 * characters -- in a reasoning trace that reads like a model glitch and gets
 * debugged as one. The decoder is kept on the parser for the whole response so
 * the split character is reassembled.
 *
 * ## A bad frame is recorded, then skipped
 *
 * The reference implementation throws on malformed JSON, which turns one bad
 * keep-alive comment into a dead conversation. TARS skips silently, which turns
 * a systematically wrong shape into an empty answer. Neither is right, so
 * `tryParseSseJson` reports through a callback and the caller decides: the chat
 * layer records it in the trace and keeps reading.
 *
 * Pure: no I/O, no clock, no globals.
 */

/** A parsed event. `data` is the joined value of every `data:` line in the frame. */
export interface AiSseFrame {
  /** Defaults to `message`; Anthropic uses `event:` to name its payload shapes. */
  event: string;
  data: string;
  /** Last `id:` seen in this frame; empty when the server sent none. */
  id: string;
  /** Reconnection delay the server suggested, when it is a valid integer. */
  retry?: number;
}

/** The sentinel OpenAI-compatible streams end with. */
export const AI_SSE_DONE = "[DONE]";

/** What went wrong with a frame, for the trace. */
export interface AiSseProblem {
  reason: "json";
  /** The offending payload, truncated so a trace cannot balloon. */
  raw: string;
  message: string;
}

export interface AiSseParserOptions {
  /** Called once per unparseable JSON payload; the frame is skipped either way. */
  onError?: (problem: AiSseProblem) => void;
}

/**
 * Is this frame the end-of-stream sentinel?
 *
 * A function rather than a comparison at each call site, because `data:
 * [DONE]` and `data:[DONE]` (no space) are the same thing after parsing, and a
 * gateway that sends the second must not be treated as "the model said
 * [DONE]" -- which is exactly how an answer that ended with that word would be
 * truncated.
 */
export function isDoneFrame(frame: AiSseFrame): boolean {
  return frame.data.trim() === AI_SSE_DONE;
}

/**
 * Parse a frame's `data` as JSON, reporting a failure instead of throwing.
 *
 * A discriminated result rather than an exception: the caller is in a stream
 * read loop, where the failure mode of `throw` is an aborted conversation for a
 * payload the next frame may well supersede.
 */
export function tryParseSseJson(
  frame: AiSseFrame,
  onError?: (problem: AiSseProblem) => void,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(frame.data) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError?.({ reason: "json", raw: frame.data.slice(0, 400), message });
    return { ok: false, message };
  }
}

/**
 * A streaming parser.
 *
 * Push text or bytes in any chunking; pull frames out. One instance per
 * response, because the buffer and the decoder are per-stream state.
 */
export class AiSseParser {
  private buffer = "";
  private decoder: TextDecoder | null = null;
  private readonly onError?: (problem: AiSseProblem) => void;

  constructor(options: AiSseParserOptions = {}) {
    this.onError = options.onError;
  }

  /**
   * Parse one frame as JSON with this parser's error sink.
   *
   * The convenience method is not cosmetic: a caller that creates the parser
   * with `onError` and then calls the free `tryParseSseJson(frame)` silently
   * loses the callback, and the malformed payload ends up in neither the trace
   * nor the UI.
   */
  parseJson(frame: AiSseFrame): { ok: true; value: unknown } | { ok: false; message: string } {
    return tryParseSseJson(frame, this.onError);
  }

  /** Feed one chunk. Returns every complete frame it completed. */
  push(chunk: string | Uint8Array): AiSseFrame[] {
    const text = this.decode(chunk);
    this.buffer += text;
    return this.drain();
  }

  /**
   * Flush the decoder and treat whatever is left as one final frame.
   *
   * A server is allowed to close without a trailing blank line, and the reply
   * that arrived that way is complete; discarding it would turn a successful
   * answer into "the stream ended with no content".
   */
  flush(): AiSseFrame[] {
    if (this.decoder) {
      // `decode()` with no argument at end-of-stream emits any partial character
      // as a replacement rather than holding it forever.
      this.buffer += this.decoder.decode();
      this.decoder = null;
    }
    const frames = this.drain();
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return frames;
    const frame = this.parseFrame(rest);
    return frame ? [...frames, frame] : frames;
  }

  private decode(chunk: string | Uint8Array): string {
    if (typeof chunk === "string") return this.stripBom(chunk);
    this.decoder ??= new TextDecoder("utf-8", { fatal: false });
    return this.stripBom(this.decoder.decode(chunk, { stream: true }));
  }

  /** The BOM is a byte-order detail, not the first character of `data:`. */
  private stripBom(text: string): string {
    if (!this.buffer && text.charCodeAt(0) === 0xfeff) return text.slice(1);
    return text;
  }

  private drain(): AiSseFrame[] {
    const frames: AiSseFrame[] = [];
    for (;;) {
      const boundary = findBoundary(this.buffer);
      if (!boundary) break;
      const raw = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.separator.length);
      const frame = this.parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private parseFrame(raw: string): AiSseFrame | null {
    if (!raw.trim()) return null;
    const data: string[] = [];
    let event = "";
    let id = "";
    let retry: number | undefined;
    for (const line of raw.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      // Exactly one leading space belongs to the protocol, not the value; a
      // second one is data the server meant to send.
      if (value.startsWith(" ")) value = value.slice(1);
      switch (field) {
        case "data":
          data.push(value);
          break;
        case "event":
          event = value;
          break;
        case "id":
          id = value;
          break;
        case "retry": {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
          break;
        }
        default:
          // Unknown fields are ignored, as the spec requires: a future extension
          // must not make an old client drop the frame.
          break;
      }
    }
    // An empty `data:` buffer dispatches nothing, per the spec: a bare `data:`
    // line is a keep-alive, and turning it into a frame would hand the adapter
    // an empty payload to parse and reject.
    const joined = data.join("\n");
    if (!joined && !event && !id) return null;
    return { event: event || "message", data: joined, id, ...(retry !== undefined ? { retry } : {}) };
  }
}

/** The earliest frame terminator in `buffer`, preferring the longest at a tie. */
function findBoundary(buffer: string): { index: number; separator: string } | null {
  const candidates: { index: number; separator: string }[] = [];
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) candidates.push({ index: lf, separator: "\n\n" });
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) candidates.push({ index: crlf, separator: "\r\n\r\n" });
  const cr = buffer.indexOf("\r\r");
  if (cr >= 0) candidates.push({ index: cr, separator: "\r\r" });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.index - b.index || b.separator.length - a.separator.length);
  return candidates[0];
}