// Shared upstream execution for the three protocol routes
// (proxy / anthropic / responses). Collapses the fetch + timeout + error-map +
// logging scaffolding that each route used to carry inline. Route-specific
// response/streaming handling stays in the routes; this module only obtains the
// upstream Response (or throws ApiError).

import { recordRequest, recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { ApiError } from "./errors.js";
import { upstreamErrorMessage } from "./upstreamError.js";
import { MissingSecretError, UnknownProviderTypeError } from "../registry.js";

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
    throw err;
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
    if (upstream.status === 401 || upstream.status === 403) {
      throw new ApiError(502, `Upstream auth error (${upstream.status}): ${detail}`, upstream.status);
    }
    if (upstream.status === 429) {
      throw new ApiError(429, `Upstream rate limit (${upstream.status}): ${detail}`, upstream.status);
    }
    throw new ApiError(
      upstream.status >= 500 ? 502 : upstream.status,
      `Upstream error (${upstream.status}): ${detail}`,
      upstream.status
    );
  }

  recordRequest(model);
  return { upstream, startTime };
}
