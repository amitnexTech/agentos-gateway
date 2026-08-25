// Upstream error extraction and network-failure mapping. Both exist so a
// provider-side failure reads as one line naming the provider instead of an
// undici stack trace or a bare "Internal gateway error", and both feed
// auto-fallback, so a wrong status here silently changes retry behaviour.

import test from "node:test";
import assert from "node:assert/strict";

import { extractUpstreamError, upstreamErrorMessage } from "../src/lib/upstreamError.js";
import { networkErrorToApiError, isNetworkError } from "../src/lib/netError.js";
import { isRetryableApiError } from "../src/lib/fallback.js";
import { ApiError } from "../src/lib/errors.js";

const fakeResponse = (body, { status = 500, statusText = "" } = {}) => ({
  status,
  statusText,
  text: async () => body,
});

test("extractUpstreamError digs the message out of the shapes providers actually send", () => {
  assert.equal(extractUpstreamError('{"error":{"message":"max_tokens: field required"}}'), "max_tokens: field required");
  assert.equal(extractUpstreamError('{"error":"plain string error"}'), "plain string error");
  assert.equal(extractUpstreamError({ message: "top level message" }), "top level message");
  assert.equal(extractUpstreamError({ detail: "detail field" }), "detail field");
  assert.equal(extractUpstreamError({ errors: [{ message: "first of many" }] }), "first of many");
  assert.equal(extractUpstreamError({ error: { message: "rate limited", code: "429" } }), "rate limited (429)");
  assert.equal(extractUpstreamError("not json at all"), "not json at all");
  assert.equal(extractUpstreamError(""), "");
});

test("an HTML error page is collapsed instead of dumped into the log", async () => {
  const html = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>${"x".repeat(5000)}</body></html>`;
  const message = await upstreamErrorMessage(fakeResponse(html));
  assert.match(message, /HTML error page/);
  assert.match(message, /502 Bad Gateway/);
  assert.ok(message.length < 200, "the page body must not reach the log");
});

test("upstreamErrorMessage falls back to statusText and truncates", async () => {
  assert.equal(await upstreamErrorMessage(fakeResponse("", { statusText: "Service Unavailable" })), "Service Unavailable");
  assert.equal(await upstreamErrorMessage(fakeResponse("", { status: 503 })), "503");
  const long = await upstreamErrorMessage(fakeResponse(JSON.stringify({ error: { message: "y".repeat(2000) } })));
  assert.equal(long.length, 500);
});

test("networkErrorToApiError unwraps fetch's nested cause", () => {
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" }),
  });
  const mapped = networkErrorToApiError(err, "example-provider");
  assert.ok(mapped instanceof ApiError);
  assert.equal(mapped.status, 502);
  assert.match(mapped.message, /Could not reach example-provider/);
  assert.match(mapped.message, /does not resolve \(ENOTFOUND\)/);
  assert.ok(isNetworkError(err));
});

test("networkErrorToApiError handles an AggregateError from a multi-address connect", () => {
  // What this host produces on the NAT64 / Happy Eyeballs path.
  const inner = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  const err = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new AggregateError([inner], "all attempts failed"), {}),
  });
  const mapped = networkErrorToApiError(err, "Kiro");
  assert.equal(mapped.status, 504);
  assert.match(mapped.message, /connection timed out \(ETIMEDOUT\)/);
});

test("a malformed baseUrl is named, since undici raises it with no code", () => {
  const err = Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") });
  const mapped = networkErrorToApiError(err, "typo provider");
  assert.match(mapped.message, /port Node refuses to connect to/);
});

test("a genuine bug keeps its own error object and stack", () => {
  const bug = new TypeError("x.map is not a function");
  assert.equal(networkErrorToApiError(bug, "provider"), bug);
  assert.equal(isNetworkError(bug), false);
});

test("every mapped network failure is retriable, and client errors are not", () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
    const err = networkErrorToApiError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }), "p");
    assert.equal(isRetryableApiError(err), true, `${code} should be worth a fallback`);
  }
  assert.equal(isRetryableApiError(new ApiError(429, "rate limit", 429)), true);
  assert.equal(isRetryableApiError(new ApiError(400, "bad request", 400)), false, "a bad request fails the same way everywhere");
  assert.equal(isRetryableApiError(new ApiError(404, "no model", 404)), false);
  assert.equal(isRetryableApiError(new Error("not an ApiError")), false);
});

test("a Kiro account out of credit budget is retriable so another account can serve", () => {
  const err = new ApiError(402, "budget used");
  err.budgetExhausted = true;
  assert.equal(isRetryableApiError(err), true);
  assert.equal(isRetryableApiError(new ApiError(402, "budget used")), false, "402 alone is not retriable");
});


// The upstream abort timer. It is OFF by default on purpose (a fixed abort ends a
// turn the client was willing to wait for), so the default must stay 0 and a
// garbage env value must not silently arm it.
test("upstreamTimeoutMs is off unless a positive number is configured", async () => {
  const { upstreamTimeoutMs, armTimeout } = await import("../src/lib/proxyExecute.js");
  const original = process.env.AGENTOS_UPSTREAM_TIMEOUT_MS;
  try {
    delete process.env.AGENTOS_UPSTREAM_TIMEOUT_MS;
    assert.equal(upstreamTimeoutMs(), 0, "no timeout by default");
    for (const bad of ["", "0", "-1", "abc"]) {
      process.env.AGENTOS_UPSTREAM_TIMEOUT_MS = bad;
      assert.equal(upstreamTimeoutMs(), 0, `"${bad}" must not arm the timer`);
    }
    process.env.AGENTOS_UPSTREAM_TIMEOUT_MS = "1500";
    assert.equal(upstreamTimeoutMs(), 1500);

    // With no timeout the controller must never be aborted, and clear() is still
    // safe to call — the fetch paths call it unconditionally.
    const off = new AbortController();
    armTimeout(off, 0)();
    assert.equal(off.signal.aborted, false);

    // With one configured it does abort, and clearing it prevents that.
    const armed = new AbortController();
    armTimeout(armed, 1);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(armed.signal.aborted, true);

    const cancelled = new AbortController();
    armTimeout(cancelled, 1)();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(cancelled.signal.aborted, false);
  } finally {
    if (original === undefined) delete process.env.AGENTOS_UPSTREAM_TIMEOUT_MS;
    else process.env.AGENTOS_UPSTREAM_TIMEOUT_MS = original;
  }
});
