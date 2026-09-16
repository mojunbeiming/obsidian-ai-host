/**
 * The mobile carrier: XMLHttpRequest.
 *
 * The WebView is not available in `node --test`, so the factory is injected. The
 * contract under test is the one the adapters consume: a status, lowercased
 * headers, a full text body, and a chunk stream that matches the body.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createXhrTransportFetch, parseRawHeaders } from "../.build/ai/aiTransport.js";
import { createAiTransport } from "../.build/ai/aiTransport.js";

/** A scripted XHR: readyState transitions happen on the microtask queue. */
function scriptedXhr(script) {
  const xhr = {
    readyState: 0,
    status: 0,
    responseText: "",
    requestHeaders: {},
    method: "",
    url: "",
    sentBody: undefined,
    aborted: false,
    onreadystatechange: null,
    onerror: null,
    onabort: null,
    open(method, url) {
      this.method = method;
      this.url = url;
    },
    setRequestHeader(name, value) {
      this.requestHeaders[name.toLowerCase()] = value;
    },
    getAllResponseHeaders() {
      return script.headers ?? "Content-Type: text/event-stream\r\nX-Test: yes";
    },
    send(body) {
      this.sentBody = body;
      queueMicrotask(() => {
        this.status = script.status ?? 200;
        this.readyState = 2;
        this.onreadystatechange?.();
        const frames = script.frames ?? [script.body ?? ""];
        let index = 0;
        const step = () => {
          if (this.aborted) return;
          if (index >= frames.length) {
            this.readyState = 4;
            this.onreadystatechange?.();
            return;
          }
          this.responseText += frames[index];
          index += 1;
          this.readyState = 3;
          this.onreadystatechange?.();
          queueMicrotask(step);
        };
        queueMicrotask(step);
      });
    },
    abort() {
      this.aborted = true;
      this.onabort?.();
    },
  };
  return xhr;
}

test("parseRawHeaders lowercases names and joins duplicates", () => {
  assert.deepEqual(parseRawHeaders("Content-Type: text/plain\r\nX-A: 1\r\nX-A: 2\r\n"), {
    "content-type": "text/plain",
    "x-a": "1, 2",
  });
});

test("send() returns status, headers and the full body", async () => {
  const fetchFn = createXhrTransportFetch(() => scriptedXhr({ status: 201, body: "hello" }));
  const transport = createAiTransport({ fetchFn });
  const response = await transport.send({
    url: "https://example.invalid/v1/chat",
    method: "POST",
    headers: { authorization: "Bearer x" },
    body: "{}",
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.equal(response.text, "hello");
});

test("stream() yields the frames in order", async () => {
  const fetchFn = createXhrTransportFetch(() => scriptedXhr({ frames: ["data: a\n\n", "data: b\n\n"] }));
  const transport = createAiTransport({ fetchFn });
  const response = await transport.stream({ url: "https://example.invalid/stream", method: "POST", headers: {}, body: "{}" });
  assert.equal(response.status, 200);
  const chunks = [];
  for await (const chunk of response.chunks) chunks.push(chunk);
  assert.equal(chunks.join(""), "data: a\n\ndata: b\n\n");
});

test("an aborted request surfaces the aborted code, not a generic network error", async () => {
  const fetchFn = createXhrTransportFetch(() => scriptedXhr({ frames: ["data: a\n\n", "data: b\n\n"] }));
  const transport = createAiTransport({ fetchFn });
  const controller = new AbortController();
  const pending = transport.send(
    { url: "https://example.invalid/stream", method: "POST", headers: {}, body: "{}" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "aborted");
});

test("a network failure is a transport error with the url attached", async () => {
  const fetchFn = createXhrTransportFetch(() => {
    const xhr = scriptedXhr({});
    xhr.send = function () {
      queueMicrotask(() => this.onerror?.());
    };
    return xhr;
  });
  const transport = createAiTransport({ fetchFn });
  await assert.rejects(
    transport.send({ url: "https://example.invalid/x", method: "GET", headers: {} }),
    (error) => error.code === "network" && String(error.url).includes("example.invalid"),
  );
});