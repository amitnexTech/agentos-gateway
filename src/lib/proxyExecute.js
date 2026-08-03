// Shared upstream execution for the three protocol routes
// (proxy / anthropic / responses). Collapses the fetch + timeout + error-map +
// logging scaffolding that each route used to carry inline. Route-specific
// response/streaming handling stays in the routes; this module only obtains the
// upstream Response (or throws ApiError).

import { recordRequest, recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { isFallbackEnabled, fallbackProviders } from "../config/keysStore.js";
import { ApiError } from "./errors.js";
import { upstreamErrorMessage } from "./upstreamError.js";
import { networkErrorToApiError } from "./netError.js";
import { isRetryableApiError } from "./fallback.js";
import { MissingSecretError, UnknownProviderTypeError, createAdapter } from "../registry.js";

// Adapter-construction errors → the API error a client should see. Used to be
// inlined in all three routes (proxy.js had it as a function; the other two
// had the same instanceof checks inline).
export function adapterErrorToApiError(err) {
  if (err instanceof MissingSecretError) return new ApiError(503, "Provider API key is missing");
  if (err instanceof UnknownProviderTypeError) return new ApiError(503, err.message);
  return err;
}

// SSE headers for a streaming proxy response. Was duplicated in 4+ places.
export function setSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

// Read a non-streaming upstream body as JSON with an honest error.
//
// All three routes used to call upstream.json() bare, so a 200 whose body is not
// JSON (a compressed body with no content-encoding, an HTML error page from a
// proxy in front of the provider, an empty body) surfaced as an opaque
// "Internal gateway error" 500 from the express error handler — a gateway bug
// message for an upstream fault. Observed live: an anthropic-compat provider
// answered HTTP 200 with binary bytes and the client learned nothing.
export async function readUpstreamJson(upstream, provider) {
  const label = provider?.name ? `Provider "${provider.name}"` : "Upstream";
  const text = await upstream.text();
  if (!text.trim()) {
    throw new ApiError(502, `${label} returned HTTP ${upstream.status} with an empty body`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const printable = text.replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
    throw new ApiError(
      502,
      `${label} returned HTTP ${upstream.status} with a body that is not JSON ` +
        `(content-type ${upstream.headers.get("content-type") || "none"}): ${printable}`
    );
  }
}

// Fetch the upstream provider and apply unified error mapping.
//
// On success: returns { upstream, startTime } — the caller consumes
// upstream.body (streaming pipe or .json()) and performs the SUCCESS logRequest
// with whatever usage it extracts (usage shape varies per protocol).
// On upstream error: records the error, logs it, and throws ApiError.
// On timeout: throws ApiError(504).
//
// anthropicVersion is forwarded only by the Anthropic passthrough route so the
// client's requested version reaches the provider; other adapters ignore it.
export async function callUpstream({
  adapter,
  body,
  model,
  rawModel,
  tool,
  provider,
  timeoutMs = 300000,
  anthropicVersion,
}) {
  const url = adapter.getRequestUrl(model, { stream: Boolean(body?.stream) });
  const headers =
    anthropicVersion !== undefined
      ? adapter.getRequestHeaders({ anthropicVersion })
      : adapter.getRequestHeaders();
  const translated = adapter.translateRequest(body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = Date.now();

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(translated),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new ApiError(504, "Upstream timeout");
    // A connect-level failure ("fetch failed" + ENOTFOUND/ETIMEDOUT/…) is a
    // provider outage, not a gateway bug. Map it so it gets a readable message,
    // lands in the request log, and can trigger auto-fallback.
    const mapped = networkErrorToApiError(err, provider?.name || url);
    if (mapped !== err) {
      recordError(model);
      logRequest({
        tool, rawModel, model,
        providerId: provider.id, providerName: provider.name,
        latencyMs: Date.now() - startTime,
        status: "error",
        error: mapped.message,
      });
      mapped.logged = true; // the route's catch must not write a second entry
    }
    throw mapped;
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    recordError(model);
    const detail = await upstreamErrorMessage(upstream);
    logRequest({
      tool,
      rawModel,
      model,
      providerId: provider.id,
      providerName: provider.name,
      latencyMs: Date.now() - startTime,
      status: "error",
      error: `${upstream.status}: ${detail.slice(0, 200)}`,
    });
    // Every throw below is for a failure already in the log; the route's catch
    // must not write a second entry for it.
    const logged = (err) => Object.assign(err, { logged: true });
    if (upstream.status === 401 || upstream.status === 403) {
      throw logged(new ApiError(502, `Upstream auth error (${upstream.status}): ${detail}`, upstream.status));
    }
    if (upstream.status === 429) {
      throw logged(new ApiError(429, `Upstream rate limit (${upstream.status}): ${detail}`, upstream.status));
    }
    throw logged(new ApiError(
      upstream.status >= 500 ? 502 : upstream.status,
      `Upstream error (${upstream.status}): ${detail}`,
      upstream.status
    ));
  }

  recordRequest(model);
  return { upstream, startTime };
}

// callUpstream with auto-fallback. Same contract as callUpstream for the
// primary attempt; on a retriable upstream error — and only when the user has
// opted in via routing.fallbackEnabled — retries on each same-protocol
// enabled provider in creation order. Returns the provider/adapter that
// actually served (plus `fallback: true/false`) so the route consumes and
// logs against the winner, not the primary that failed.
//
// Off by default: when fallbackEnabled is false this makes one call and
// behaves exactly like callUpstream (the winning provider is the primary).
//
// Each failed attempt is logged as an error entry by callUpstream itself, so
// the log shows every provider that was tried — preserving spend clarity.
export async function callUpstreamWithFallback({
  adapter: primaryAdapter,
  body,
  model,
  rawModel,
  tool,
  provider: primaryProvider,
  timeoutMs,
  anthropicVersion,
  speaks,
}) {
  let lastErr;
  try {
    const r = await callUpstream({
      adapter: primaryAdapter, body, model, rawModel, tool,
      provider: primaryProvider, timeoutMs, anthropicVersion,
    });
    return { ...r, provider: primaryProvider, adapter: primaryAdapter, fallback: false };
  } catch (err) {
    lastErr = err;
    if (!isFallbackEnabled() || !isRetryableApiError(err)) throw err;
  }

  for (const fp of fallbackProviders(tool, primaryProvider)) {
    // Passthrough (#171 item 3): forward the raw id untouched to the fallback
    // provider; its own response/error is the source of truth. `speaks` matters
    // here: a fallback may speak a different protocol than the primary, in which
    // case it needs the translating adapter (see registry.createAdapter).
    let adapter;
    try {
      adapter = await createAdapter(fp, { speaks });
    } catch {
      continue; // missing key / unknown type — skip this candidate silently
    }
    try {
      const r = await callUpstream({
        adapter, body, model: rawModel, rawModel, tool, provider: fp, timeoutMs, anthropicVersion,
      });
      return { ...r, provider: fp, adapter, fallback: true };
    } catch (err) {
      lastErr = err;
      // A non-retriable error on a fallback is a real answer (e.g. 400 from
      // the winning provider) — surface it rather than burning more accounts.
      if (!isRetryableApiError(err)) throw err;
    }
  }
  throw lastErr;
}
