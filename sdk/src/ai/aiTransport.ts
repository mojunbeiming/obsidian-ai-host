/**
 * The one socket in the SDK.
 *
 * ## Why the socket lives here now
 *
 * The first transport lived in each plugin's `aiProvider.ts`, and the guard
 * named one file per plugin. That was a real improvement over "a request could
 * be anywhere", but it also meant the host plugin planned for the next step
 * would have had a *third* copy -- and three copies of the scheme check, the
 * abort handling and the error phrasing is how they drift. There is one
 * implementation here; `tools/check-no-network.mjs` names this file as the
 * allowed exception, and the per-plugin transports are expected to become thin
 * adapters over it.
 *
 * ## Node's client, not `fetch`
 *
 * A local model server is not obliged to accept a renderer-origin request. The
 * one this project was written against rejects a browser-shaped request with a
 * 403 even when the session cookie is valid, because it checks `Origin` against
 * `Host`. Node's client sends neither header. The injected `AiTransportFetch`
 * exists for tests and for a future mobile path, not as the desktop path: on
 * desktop the default is `node:http`/`node:https`, chosen by URL scheme.
 *
 * ## Abort and timeout are one mechanism
 *
 * The caller's signal and the timeout are folded into one internal controller,
 * so every layer below has a single thing to watch: the internal signal. The
 * timeout is a *whole-request* budget that stays armed until the body has been
 * read, not a connection timeout that expires while a slow model streams --
 * the failure that looks like a hang on exactly the long replies that need the
 * longest budget.
 *
 * ## What this file deliberately does not do
 *
 * It does not classify status codes, build a credential header, or parse SSE.
 * A non-2xx response is returned as a status and a body; the adapter maps it. A
 * header map is written exactly as handed over; the adapter resolved it from the
 * provider table. Bytes are turned into strings here (streaming UTF-8 safe) and
 * the frame parser lives in `aiSse.ts`, because that parser is the part worth
 * testing with adversarial chunk boundaries.
 *
 * The transport is the only file allowed to import a Node HTTP module; nothing
 * in it names a host, so the question "where can this send a request" is still
 * answered by `aiProviders.ts` alone.
 */

/** How long a request gets before it is aborted, unless the caller says otherwise. */
export const AI_TRANSPORT_DEFAULT_TIMEOUT_MS = 120_000;

/** One request, already resolved to a URL and headers by an adapter. */
export interface AiHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface AiHttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface AiStreamResponse {
  status: number;
  headers: Record<string, string>;
  /** UTF-8 strings, split wherever the socket split them; feed straight to `AiSseParser`. */
  chunks: AsyncIterable<string>;
}

/** What an injected implementation must produce for one request. */
export interface AiFetchedResponse {
  status: number;
  headers: Record<string, string>;
  /** Read the whole body as text. Call this *or* `stream`, once. */
  text(): Promise<string>;
  stream(): AsyncIterable<string>;
}

/**
 * One HTTP request, with an already-resolved signal.
 *
 * The signal passed here is the internal one (caller abort + timeout already
 * folded in), so an implementation never has to know about budgets: it only has
 * to stop when the signal fires.
 */
export type AiTransportFetch = (request: AiHttpRequest, signal: AbortSignal) => Promise<AiFetchedResponse>;

export interface AiTransportCallOptions {
  signal?: AbortSignal;
  /** Whole-request budget. Defaults to two minutes; clamped to at least one second. */
  timeoutMs?: number;
}

export interface AiTransport {
  send(request: AiHttpRequest, options?: AiTransportCallOptions): Promise<AiHttpResponse>;
  stream(request: AiHttpRequest, options?: AiTransportCallOptions): Promise<AiStreamResponse>;
}

export type AiTransportErrorCode = "aborted" | "timeout" | "invalid-url" | "unsupported-protocol" | "network";

/** A transport failure with a message meant for the user, in their language. */
export class AiTransportError extends Error {
  readonly code: AiTransportErrorCode;
  readonly url?: string;
  /** Declared here rather than via `Error.cause`: the SDK targets ES2021, where it is not in lib. */
  readonly cause?: unknown;

  constructor(code: AiTransportErrorCode, message: string, options: { url?: string; cause?: unknown } = {}) {
    super(message);
    this.name = "AiTransportError";
    this.code = code;
    this.url = options.url;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** True for the one failure callers are expected to swallow: the user cancelled. */
export function isAbortError(error: unknown): boolean {
  return error instanceof AiTransportError && error.code === "aborted";
}

/**
 * Build a transport.
 *
 * Tests inject `fetchFn`; desktop uses the Node client; mobile (Obsidian's
 * Capacitor WebView, where `node:http` does not exist) uses XMLHttpRequest.
 * `xhrFactory` exists so the mobile carrier can be unit-tested without a
 * WebView.
 */
export function createAiTransport(options: { fetchFn?: AiTransportFetch; mobile?: boolean; xhrFactory?: XhrFactory } = {}): AiTransport {
  const fetchFn =
    options.fetchFn ??
    (options.mobile ? createXhrTransportFetch(options.xhrFactory ?? (() => new XMLHttpRequest())) : nodeAiTransportFetch);
  return {
    async send(request, callOptions = {}) {
      const budget = createBudget(request.url, callOptions);
      try {
        const fetched = await fetchFn(request, budget.signal);
        const text = await fetched.text();
        return { status: fetched.status, headers: fetched.headers, text };
      } catch (error) {
        throw mapTransportError(error, budget, request.url);
      } finally {
        budget.dispose();
      }
    },

    async stream(request, callOptions = {}) {
      const budget = createBudget(request.url, callOptions);
      let fetched: AiFetchedResponse;
      try {
        fetched = await fetchFn(request, budget.signal);
      } catch (error) {
        budget.dispose();
        throw mapTransportError(error, budget, request.url);
      }
      return {
        status: fetched.status,
        headers: fetched.headers,
        chunks: wrapChunks(fetched.stream(), budget, request.url),
      };
    },
  };
}

/**
 * The desktop implementation, over Node's HTTP clients.
 *
 * The modules are loaded lazily, inside the call, because the plugin bundle is
 * also shipped to mobile where a top-level `require("node:http")` would throw
 * during load and take the whole plugin down. The scheme decides which one can
 * open the connection: handing an `https:` URL to `node:http` does not fail at
 * the server, it throws `Protocol "https:" not supported` before anything
 * leaves the machine.
 *
 * If no Node client can be obtained at all -- a renderer whose `require` only
 * knows `obsidian` and whose ESM loader rejects `node:` specifiers -- the
 * request still goes out, over the XHR carrier that mobile already uses. That
 * carrier is not a degraded console-only path: it streams from
 * `readystatechange` and carries every provider request this plugin makes.
 */
export const nodeAiTransportFetch: AiTransportFetch = async (request, signal) => {
  const clients = await loadNodeHttpClients();
  if (!clients) return await xhrDesktopTransport()(request, signal);
  const { httpClient, httpsClient } = clients;
  return await new Promise<AiFetchedResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new AiTransportError("invalid-url", `端点地址无法解析：${request.url}`, { url: request.url }));
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(
        new AiTransportError("unsupported-protocol", `不支持的协议 ${url.protocol}，只支持 https（远程）与 http（本机）。`, {
          url: request.url,
        }),
      );
      return;
    }

    const secure = url.protocol === "https:";
    const client = secure ? httpsClient : httpClient;
    const headers: Record<string, string> = { ...request.headers };
    const body = request.method === "GET" ? undefined : request.body;
    if (body !== undefined && !hasHeader(headers, "content-length")) {
      // Set by hand rather than left to chunked encoding: some local servers
      // reject a chunked POST, and the byte count has to be UTF-8 length, not
      // string length, or a body with Chinese in it is truncated.
      headers["Content-Length"] = String(utf8ByteLength(body));
    }

    let nodeRequest: import("node:http").ClientRequest;
    try {
      nodeRequest = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
        },
        (response) => {
          const finish = once(() => removeAbortListener());
          response.on("close", finish);
          resolve({
            status: response.statusCode ?? 0,
            headers: normalizeNodeHeaders(response.headers),
            text: () => collectText(response).finally(finish),
            stream: () => iterateText(response),
          });
        },
      );
    } catch (error) {
      reject(mapTransportError(error, null, request.url));
      return;
    }

    const onAbort = (): void => {
      const reason = signal.reason instanceof Error ? signal.reason : new AiTransportError("aborted", "请求已取消。", { url: request.url });
      nodeRequest.destroy(reason);
    };
    const removeAbortListener = (): void => signal.removeEventListener("abort", onAbort);

    nodeRequest.on("error", (error) => {
      removeAbortListener();
      reject(error instanceof AiTransportError ? error : mapTransportError(error, { signal }, request.url));
    });

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // A GET has no body, and writing an empty string to one is refused by some
    // servers -- the models probe is a GET, so this branch is load-bearing.
    if (body !== undefined) nodeRequest.write(body);
    nodeRequest.end();
  });
};

/** Read a Node response to a string. UTF-8 continuations are handled by setEncoding. */
function collectText(response: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    response.setEncoding("utf8");
    let text = "";
    response.on("data", (chunk: string) => {
      text += chunk;
    });
    response.on("end", () => resolve(text));
    response.on("error", reject);
  });
}

/** Stream a Node response as UTF-8 strings. */
async function* iterateText(response: import("node:http").IncomingMessage): AsyncIterable<string> {
  response.setEncoding("utf8");
  for await (const chunk of response) yield chunk as string;
}

/** The internal budget: the caller's signal, a timeout, and one signal for both. */
interface Budget {
  signal: AbortSignal;
  dispose(): void;
  timedOut: boolean;
  abortReason: AiTransportError;
}

function createBudget(url: string, options: AiTransportCallOptions): Budget {
  const controller = new AbortController();
  const caller = options.signal;
  const timeoutMs = clampTimeout(options.timeoutMs);
  const abortReason = new AiTransportError("aborted", "请求已取消。", { url });
  const timeoutReason = new AiTransportError("timeout", `等待响应超时（${Math.round(timeoutMs / 1000)} 秒）。`, { url });
  const budget: Budget = {
    signal: controller.signal,
    timedOut: false,
    abortReason,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", forward);
    },
  };
  const forward = (): void => {
    const reason = caller?.reason instanceof Error ? caller.reason : abortReason;
    controller.abort(reason);
  };
  if (caller) {
    if (caller.aborted) controller.abort(abortReason);
    else caller.addEventListener("abort", forward, { once: true });
  }
  const timer = setTimeout(() => {
    budget.timedOut = true;
    controller.abort(timeoutReason);
  }, timeoutMs);
  return budget;
}

function clampTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return AI_TRANSPORT_DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(value, 600_000));
}

/** Turn anything an implementation threw into an `AiTransportError`. */
function mapTransportError(error: unknown, context: { signal: AbortSignal; timedOut?: boolean } | null, url: string): AiTransportError {
  if (error instanceof AiTransportError) return error;
  if (context?.timedOut) {
    return new AiTransportError("timeout", `等待响应超时。`, { url, cause: error });
  }
  if (context?.signal.aborted) {
    const reason = context.signal.reason;
    if (reason instanceof AiTransportError) return reason;
    return new AiTransportError("aborted", "请求已取消。", { url, cause: error });
  }
  const record = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (record && record.name === "AbortError") {
    return new AiTransportError("aborted", "请求已取消。", { url, cause: error });
  }
  const code = typeof record?.code === "string" ? record.code : "";
  const message = typeof record?.message === "string" ? record.message : String(error);
  return new AiTransportError("network", describeNetworkError(code, message, url), { url, cause: error });
}

/** An OS error phrased as the thing the user should check. */
function describeNetworkError(code: string, message: string, url: string): string {
  switch (code) {
    case "ECONNREFUSED":
      return `连不上 ${url}：这个端口上没有服务在监听。先把它启动起来，或到设置里改端点地址。`;
    case "ECONNRESET":
      return `连接被 ${url} 重置：服务可能刚重启，或拒绝了这次请求。`;
    case "ENOTFOUND":
      return `解析不了 ${url} 的主机名。本机服务用 127.0.0.1 而不是主机名。`;
    case "ETIMEDOUT":
      return `连接 ${url} 超时。`;
    case "ECONNABORTED":
      return `连接 ${url} 被中断。`;
    default:
      return `请求 ${url} 失败：${message}${code ? `（${code}）` : ""}`;
  }
}

/** Async wrapper that disposes the budget when the body finishes, however it ends. */
async function* wrapChunks(source: AsyncIterable<string>, budget: Budget, url: string): AsyncIterable<string> {
  try {
    for await (const chunk of source) yield chunk;
  } catch (error) {
    throw mapTransportError(error, budget, url);
  } finally {
    budget.dispose();
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function normalizeNodeHeaders(headers: import("node:http").IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/**
 * Load the two Node clients once, on the first desktop request.
 *
 * `require` is tried **by calling it**, not by inspecting it. The previous
 * version asked for `require.resolve` as proof of "real CommonJS" and that
 * proof is wrong in Obsidian: the plugin loader gives the bundle a `require`
 * that can load builtins but carries no `resolve` property, so the check fell
 * through to the dynamic import, the renderer's ESM loader refused the `node:`
 * specifier, and every AI request failed with "Failed to fetch dynamically
 * imported module: node:http" while the plugin looked correctly built.
 *
 * A `try` around the call is the honest test, because the three environments
 * that cannot provide the clients fail in three different ways -- esbuild's ESM
 * shim throws when called, a mobile host has no `require` at all, and Obsidian's
 * own `require` may simply not know the module -- and all three are answered by
 * `null`.
 */
let nodeClients: NodeClients | null = null;
/** Set once the load has been proven impossible, so it is not retried per request. */
let nodeClientsUnavailable = false;

type NodeClients = { httpClient: typeof import("node:http"); httpsClient: typeof import("node:https") };

export function clientsFromRequire(loader: unknown): NodeClients | null {
  if (typeof loader !== "function") return null;
  try {
    const realRequire = loader as (id: string) => unknown;
    const httpClient = realRequire("node:http") as typeof import("node:http") | undefined;
    const httpsClient = realRequire("node:https") as typeof import("node:https") | undefined;
    // A shim that returns an empty object instead of throwing is worse than one
    // that throws: the request would be built against nothing and fail later
    // with a confusing message. `request` is the only member used.
    if (typeof httpClient?.request !== "function" || typeof httpsClient?.request !== "function") return null;
    return { httpClient, httpsClient };
  } catch {
    return null;
  }
}

/** The XHR carrier, built once, used when no Node client can be loaded. */
let xhrDesktopFetch: AiTransportFetch | null = null;

function xhrDesktopTransport(): AiTransportFetch {
  xhrDesktopFetch ??= createXhrTransportFetch(() => new XMLHttpRequest());
  return xhrDesktopFetch;
}

async function loadNodeHttpClients(): Promise<NodeClients | null> {
  if (nodeClients) return nodeClients;
  if (nodeClientsUnavailable) return null;
  const viaRequire = clientsFromRequire(typeof require === "function" ? require : null);
  if (viaRequire) {
    nodeClients = viaRequire;
    return nodeClients;
  }
  try {
    // Node accepts `import()` for builtins only outside CommonJS, which is why
    // this form is here: the SDK's own ESM test build has no `require` and still
    // exercises this transport against a real local server.
    const [httpModule, httpsModule] = await Promise.all([import("node:http"), import("node:https")]);
    const resolve = <T,>(module: T & { default?: T }): T => (module.default ?? module);
    nodeClients = {
      httpClient: resolve(httpModule as unknown as typeof import("node:http") & { default?: typeof import("node:http") }),
      httpsClient: resolve(httpsModule as unknown as typeof import("node:https") & { default?: typeof import("node:https") }),
    };
    return nodeClients;
  } catch {
    // The renderer: dynamic `import("node:http")` is a fetch of a module the ESM
    // loader cannot resolve. Remembered as "no clients" rather than thrown, so
    // the caller falls back to XHR instead of failing the request.
    nodeClientsUnavailable = true;
    return null;
  }
}

/** Minimal XMLHttpRequest surface; the WebView provides the real one. */
export interface XhrLike {
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: unknown): void;
  abort(): void;
  getAllResponseHeaders(): string;
  readyState: number;
  status: number;
  responseText: string;
  // `unknown` on purpose: the real XMLHttpRequest handlers take an Event, and
  // this file only assigns to them, so naming a signature would make the WebView
  // object fail structural compatibility.
  onreadystatechange: unknown;
  onerror: unknown;
  onabort: unknown;
}

export type XhrFactory = () => XhrLike;

/**
 * The mobile implementation, over XMLHttpRequest.
 *
 * Streaming comes from `readystatechange`: XHR exposes the response text
 * cumulatively, so each event yields the delta since the last one. A platform
 * that only reports state 4 degrades to a single chunk at the end -- the reply
 * is still correct, it just does not appear token by token.
 */
export function createXhrTransportFetch(makeXhr: XhrFactory): AiTransportFetch {
  return (request, signal) =>
    new Promise<AiFetchedResponse>((resolve, reject) => {
      const xhr = makeXhr();
      const chunks: string[] = [];
      const waiters: (() => void)[] = [];
      let received = 0;
      let done = false;
      let failure: unknown = null;
      let resolved = false;

      const wake = (): void => {
        for (const waiter of waiters.splice(0)) waiter();
      };
      const push = (): void => {
        const text = xhr.responseText ?? "";
        if (text.length > received) {
          chunks.push(text.slice(received));
          received = text.length;
          wake();
        }
      };
      const cleanup = (): void => signal.removeEventListener("abort", onSignalAbort);
      const waitDone = (): Promise<void> => (done ? Promise.resolve() : new Promise<void>((res) => waiters.push(res)));
      const finish = (error: unknown): void => {
        if (done) return;
        done = true;
        failure = error;
        cleanup();
        wake();
        if (!resolved) reject(error instanceof Error ? error : new AiTransportError("network", `请求 ${request.url} 失败。`, { url: request.url }));
      };
      const onSignalAbort = (): void => {
        try {
          xhr.abort();
        } catch {
          // Aborting an already-finished XHR is a no-op in every WebView.
        }
      };

      if (signal.aborted) {
        reject(new AiTransportError("aborted", "请求已取消。", { url: request.url }));
        return;
      }
      signal.addEventListener("abort", onSignalAbort, { once: true });

      xhr.open(request.method, request.url, true);
      for (const [name, value] of Object.entries(request.headers)) {
        try {
          xhr.setRequestHeader(name, value);
        } catch {
          // Some headers are forbidden to scripts; the provider table does not
          // use them, and a rejected cosmetic header must not fail the request.
        }
      }
      xhr.onreadystatechange = () => {
        if (!resolved && xhr.readyState >= 2) {
          resolved = true;
          resolve({
            status: xhr.status,
            headers: parseRawHeaders(xhr.getAllResponseHeaders()),
            text: async () => {
              await waitDone();
              if (failure) throw failure instanceof Error ? failure : new AiTransportError("network", `请求 ${request.url} 失败。`, { url: request.url });
              return xhr.responseText ?? "";
            },
            stream: () => readChunks(),
          });
        }
        if (xhr.readyState === 3 || xhr.readyState === 4) push();
        if (xhr.readyState === 4) finish(null);
      };
      xhr.onerror = () => finish(new AiTransportError("network", `请求 ${request.url} 失败：网络不可达。`, { url: request.url }));
      xhr.onabort = () =>
        finish(
          signal.aborted
            ? new AiTransportError("aborted", "请求已取消。", { url: request.url })
            : new AiTransportError("network", "连接被中断。", { url: request.url }),
        );
      try {
        xhr.send(request.body ?? null);
      } catch (error) {
        finish(error);
      }

      async function* readChunks(): AsyncIterable<string> {
        for (;;) {
          while (chunks.length) yield chunks.shift() as string;
          if (done) {
            if (failure) throw failure instanceof Error ? failure : new AiTransportError("network", `请求 ${request.url} 失败。`, { url: request.url });
            return;
          }
          await new Promise<void>((res) => waiters.push(res));
        }
      }
    });
}

/** `a: 1\r\nb: 2` -> `{a: "1", b: "2"}`, matching the Node normalizer's lowercasing. */
export function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!key) continue;
    out[key] = out[key] ? `${out[key]}, ${value}` : value;
  }
  return out;
}
