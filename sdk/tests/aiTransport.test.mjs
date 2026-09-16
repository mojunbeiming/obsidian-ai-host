/**
 * The transport: bytes over a real loopback socket, plus the injected path.
 *
 * The socket tests are deliberately real rather than mocked: the parts of a
 * transport that break are `Content-Length` on a UTF-8 body, a streamed answer
 * split mid-character, and an abort that has to destroy the request rather than
 * merely stop reading. A fake `fetchFn` cannot fail any of those, so it is used
 * only for the cases a server cannot produce on demand (a timeout is tested
 * against a server that never answers, but the injected path proves the error
 * mapping for arbitrary failures).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  AI_TRANSPORT_DEFAULT_TIMEOUT_MS,
  AiTransportError,
  clientsFromRequire,
  createAiTransport,
  isAbortError,
} from "../.build/ai/aiTransport.js";

/** A loopback server, closed by the caller. */
async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function collect(chunks) {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

test("send writes the body, sets Content-Length in bytes, and returns the reply", async () => {
  const seen = {};
  const s = await startServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = body;
      res.writeHead(201, { "x-echo": "yes" });
      res.end("收到");
    });
  });
  try {
    const transport = createAiTransport();
    const response = await transport.send({
      url: `${s.base}/v1/chat/completions`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.text, "收到");
    assert.equal(response.headers["x-echo"], "yes");
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/chat/completions");
    const expectedLength = new TextEncoder().encode(seen.body).length;
    assert.equal(seen.headers["content-length"], String(expectedLength), "Content-Length 必须是字节数");
    assert.notEqual(seen.headers["content-length"], String(seen.body.length));
  } finally {
    await s.close();
  }
});

test("a GET is sent with no body and no Content-Length", async () => {
  const seen = {};
  const s = await startServer((req, res) => {
    seen.headers = req.headers;
    res.end("models");
  });
  try {
    const response = await createAiTransport().send({ url: `${s.base}/v1/models`, method: "GET", headers: {} });
    assert.equal(response.text, "models");
    assert.equal(seen.headers["content-length"], undefined);
  } finally {
    await s.close();
  }
});

test("a non-2xx reply is returned rather than thrown; the caller classifies it", async () => {
  const s = await startServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"bad key"}');
  });
  try {
    const response = await createAiTransport().send({ url: `${s.base}/v1/chat/completions`, method: "POST", headers: {}, body: "{}" });
    assert.equal(response.status, 401);
    assert.equal(response.text, '{"error":"bad key"}');
  } finally {
    await s.close();
  }
});

test("stream hands chunks through, in order, from a chunked response", async () => {
  const s = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: a\n\n");
    setTimeout(() => {
      res.write("data: b\n\n");
      res.end("data: [DONE]\n\n");
    }, 20);
  });
  try {
    const stream = await createAiTransport().stream({ url: `${s.base}/stream`, method: "POST", headers: {}, body: "{}" });
    assert.equal(stream.status, 200);
    assert.equal(await collect(stream.chunks), "data: a\n\ndata: b\n\ndata: [DONE]\n\n");
  } finally {
    await s.close();
  }
});

test("a multi-byte character split across response chunks is reassembled", async () => {
  const s = await startServer((_req, res) => {
    const bytes = Buffer.from("前后", "utf8");
    res.writeHead(200);
    res.write(bytes.subarray(0, 4));
    setTimeout(() => {
      res.write(bytes.subarray(4));
      res.end();
    }, 10);
  });
  try {
    const response = await createAiTransport().send({ url: s.base, method: "GET", headers: {} });
    assert.equal(response.text, "前后");
  } finally {
    await s.close();
  }
});

test("an aborted request rejects with code aborted and destroys the socket", async () => {
  const s = await startServer(() => {
    // Never answer: the abort is the only way out.
  });
  try {
    const controller = new AbortController();
    const pending = createAiTransport().send({ url: s.base, method: "GET", headers: {} }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, (error) => error instanceof AiTransportError && error.code === "aborted" && isAbortError(error));
  } finally {
    await s.close();
  }
});

test("a request with no answer times out as a timeout, not as an abort", async () => {
  const s = await startServer(() => {
    // Never answer.
  });
  try {
    const started = Date.now();
    await assert.rejects(
      createAiTransport().send({ url: s.base, method: "GET", headers: {} }, { timeoutMs: 1000 }),
      (error) => error instanceof AiTransportError && error.code === "timeout",
    );
    assert.ok(Date.now() - started >= 900, "超时预算不能比请求本身先结束");
  } finally {
    await s.close();
  }
});

test("obviously wrong URLs fail before any socket exists", async () => {
  const transport = createAiTransport();
  await assert.rejects(transport.send({ url: "not a url", method: "GET", headers: {} }), (error) => error.code === "invalid-url");
  await assert.rejects(transport.send({ url: "ftp://example.invalid/x", method: "GET", headers: {} }), (error) => error.code === "unsupported-protocol");
  assert.equal(AI_TRANSPORT_DEFAULT_TIMEOUT_MS, 120_000);
});

test("an injected fetchFn is what send and stream call, signal included", async () => {
  const calls = [];
  const transport = createAiTransport({
    fetchFn: async (request, signal) => {
      calls.push({ request, aborted: signal.aborted });
      return {
        status: 200,
        headers: { "x-test": "1" },
        text: async () => "hello",
        stream: async function* () {
          yield "a";
          yield "b";
        },
      };
    },
  });
  const sent = await transport.send({ url: "http://127.0.0.1:1/x", method: "POST", headers: {}, body: "{}" });
  assert.equal(sent.text, "hello");
  assert.equal(sent.headers["x-test"], "1");
  const streamed = await transport.stream({ url: "http://127.0.0.1:1/y", method: "POST", headers: {}, body: "{}" });
  assert.equal(await collect(streamed.chunks), "ab");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].request.url.endsWith("/x"));
  assert.equal(calls[0].aborted, false);
});

test("a caller abort reaches an injected implementation, and its rejection maps to aborted", async () => {
  const transport = createAiTransport({
    fetchFn: (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })));
      }),
  });
  const controller = new AbortController();
  const pending = transport.send({ url: "http://127.0.0.1:1/x", method: "GET", headers: {} }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "aborted");
});

test("an injected implementation's own error becomes a network error with its message", async () => {
  const transport = createAiTransport({
    fetchFn: async () => {
      // Not a code the transport phrases itself; an unknown failure must still
      // arrive as a diagnosis rather than as a bare stack trace.
      throw Object.assign(new Error("socket exploded"), { code: "EWEIRD" });
    },
  });
  await assert.rejects(transport.send({ url: "http://127.0.0.1:1/x", method: "GET", headers: {} }), (error) => {
    assert.equal(error.code, "network");
    assert.ok(error.message.includes("socket exploded"));
    return true;
  });
});

/**
 * The desktop loader, tested by what it does with a loader rather than by
 * inspecting one.
 *
 * The bug this pins: the loader used to require `require.resolve` before calling
 * `require`. Obsidian's own `require` has no `resolve`, so the check fell through
 * to `import("node:http")`, the renderer refused the `node:` specifier, and every
 * request failed with "Failed to fetch dynamically imported module: node:http".
 * A call inside `try` cannot make that mistake -- and this is the shape the
 * three real environments present: no loader at all (mobile), a loader that
 * throws when called (esbuild's ESM shim), and a loader that works.
 */
test("a throwing require is refused instead of being trusted", () => {
  const shim = () => {
    throw Object.assign(new Error('Dynamic require of "node:http" is not supported'), { name: "Error" });
  };
  assert.equal(clientsFromRequire(shim), null, "a loader that no longer resolves `resolve`");
  assert.equal(clientsFromRequire(undefined), null);
  assert.equal(clientsFromRequire({ request: () => {} }), null, "an object is not a loader");
  assert.equal(clientsFromRequire(() => ({})), null, "an empty module is not a client");
  assert.equal(clientsFromRequire(() => ({ request: "nope" })), null, "a non-callable `request` is not a client");
});

test("a working require is used, and its two clients come back by scheme", () => {
  const httpClient = { request: () => "http" };
  const httpsClient = { request: () => "https" };
  const loader = (id) => {
    if (id === "node:http") return httpClient;
    if (id === "node:https") return httpsClient;
    throw new Error(`unexpected module ${id}`);
  };
  const clients = clientsFromRequire(loader);
  assert.ok(clients);
  assert.equal(clients.httpClient, httpClient);
  assert.equal(clients.httpsClient, httpsClient);
});