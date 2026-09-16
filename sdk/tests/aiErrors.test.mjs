/**
 * The error taxonomy: every failure shape the three plugins can produce maps to
 * a stable code, a retryable flag and a sentence that names the fix.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyError, errorDedupKey, errorFromStatus, formatRunError } from "../.build/ai/aiErrors.js";

test("transport failures map to their own codes", () => {
  const aborted = classifyError(Object.assign(new Error("cancelled"), { code: "aborted", name: "AbortError" }), { where: "transport" });
  assert.equal(aborted.code, "AI_ABORT");
  assert.equal(aborted.retryable, false);

  const timeout = classifyError(Object.assign(new Error("slow"), { code: "timeout" }));
  assert.equal(timeout.code, "AI_TIMEOUT");
  assert.equal(timeout.retryable, true);

  const network = classifyError(Object.assign(new Error("refused"), { code: "network" }));
  assert.equal(network.code, "AI_NETWORK");

  const config = classifyError(Object.assign(new Error("bad"), { code: "invalid-url" }));
  assert.equal(config.code, "AI_CONFIG_ENDPOINT");
});

test("adapter shape failures are parse errors, provider errors keep their status", () => {
  assert.equal(classifyError(Object.assign(new Error("bad json"), { kind: "invalid-json" })).code, "AI_PARSE");
  assert.equal(classifyError(Object.assign(new Error("shape"), { kind: "shape" })).category, "parse");
  const provider = classifyError(Object.assign(new Error("quota"), { kind: "provider-error", status: 429 }));
  assert.equal(provider.code, "AI_PROVIDER_429");
  assert.equal(provider.retryable, true);
});

test("HTTP statuses get the same wording the runtime already uses", () => {
  assert.equal(errorFromStatus(401, "").code, "AI_AUTH_401");
  assert.equal(errorFromStatus(403, "").category, "auth");
  assert.equal(errorFromStatus(404, "").code, "AI_ENDPOINT_404");
  assert.equal(errorFromStatus(405, "").code, "AI_ENDPOINT_405");
  assert.equal(errorFromStatus(413, "").code, "AI_PAYLOAD_413");
  assert.equal(errorFromStatus(429, "").code, "AI_RATE_LIMIT");
  assert.equal(errorFromStatus(429, "").retryable, true);
  assert.equal(errorFromStatus(503, "").code, "AI_PROVIDER_503");
  assert.equal(errorFromStatus(418, "").code, "AI_HTTP_418");
});

test("a status embedded in the message is still recognized", () => {
  const error = classifyError(new Error("请求失败（502）：bad gateway"));
  assert.equal(error.code, "AI_PROVIDER_502");
  assert.equal(error.status, 502);
});

test("anything unrecognized becomes AI_INTERNAL with the technical text kept", () => {
  const error = classifyError(new Error("Cannot read properties of undefined"), { where: "tool:vault.read" });
  assert.equal(error.code, "AI_INTERNAL");
  assert.ok(error.technical.includes("tool:vault.read"));
  assert.ok(error.technical.includes("Cannot read properties"));
});

test("the dedup key merges repeats of the same code and message", () => {
  const a = errorFromStatus(429, "busy");
  const b = errorFromStatus(429, "busy");
  assert.equal(errorDedupKey(a), errorDedupKey(b));
  assert.notEqual(errorDedupKey(a), errorDedupKey(errorFromStatus(503, "down")));
});

test("formatRunError is the copyable block a user pastes into a report", () => {
  const text = formatRunError(errorFromStatus(401, "invalid key"));
  assert.ok(text.includes("AI_AUTH_401"));
  assert.ok(text.includes("提示："));
  assert.ok(text.includes("不可重试"));
});