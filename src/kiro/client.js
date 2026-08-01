// Kiro request execution + model-id resolution — the single home for the
// knowledge that "Kiro's catalog uses short names while Anthropic-format
// clients send date-suffixed ids". Both /v1/messages (Claude Code) and
// /v1/responses (Codex) route their Kiro provider branch through executeKiro
// so the validation + fetch + error mapping lives once instead of being
// copy-pasted into each route.
//
// Resolution is Kiro-only by design (#171 item 1): non-Kiro providers receive
// the raw model id untouched. lookupModelForTool() is the only place that
// applies Kiro aliasing, and only when the tool is actually routed to Kiro.

import { lookupProviderForTool, getToolProvider, fallbackProviders, getProviderModels } from "../config/keysStore.js";
import { recordRequest, recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { isFallbackEnabled } from "../config/keysStore.js";
import { isRetryableApiError } from "../lib/fallback.js";
import { ApiError } from "../lib/errors.js";
import { networkErrorToApiError } from "../lib/netError.js";
import { createAdapter } from "../registry.js";
import { anthropicToKiro } from "./converter.js";

// Explicit aliases ONLY where stripping the -YYYYMMDD suffix does NOT yield a
// name in Kiro's catalog. Silent paid upgrades (sonnet-4 → sonnet-4.5/4.6) are
// deliberately excluded — sonnet-4 works on Kiro directly, so mapping it to a
// pricier model would be an upgrade the client never asked for (#171 item 2).
const MODEL_ALIASES = {
  "claude-opus-4-20250115": "claude-opus-4.5",
  "claude-opus-4-20250514": "claude-opus-4.6",
  "claude-haiku-3.5-20241022": "claude-haiku-4.5",
};

// Resolve a (possibly date-suffixed) Claude model id to a Kiro catalog id.
// Kiro-only: callers must only use this on the Kiro provider path.
export function resolveKiroModel(model) {
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  const stripped = model.replace(/-\d{8}$/, "");
  if (stripped !== model) return stripped;
  return model;
}

// Look up the provider bound to a tool for the given model id, applying Kiro
// alias resolution only when the tool is routed to a Kiro provider.
//
// Returns { provider, model } where `model` is what to forward upstream:
//  - non-Kiro provider -> the raw id, untouched, ALWAYS forwarded to the bound
//    provider (the configured list is advisory, not a gate — #171 item 3)
//  - Kiro provider -> the resolved (short) id when a dated id was sent; only
//    configured ids forward (ban risk), an unconfigured id -> null
//  - no provider bound -> { provider: null, model: rawModel } (caller surfaces 404)
//
// Gating is Kiro-only: sending Kiro an unconfigured model id is a ban risk, so
// the strict list check stays for Kiro. Passthrough providers recognise ids they
// don't advertise, so an unknown id is forwarded and the provider's own response
// (or error) is the source of truth — our local 404 used to mask the real
// upstream answer (#171 item 3). The redundant getToolModels() re-check that
// used to live in each route's Kiro branch is gone (#171 item 4).
export function lookupModelForTool(tool, rawModel) {
  const bound = getToolProvider(tool);

  // Kiro is strict: only forward ids configured on the bound Kiro provider
  // (after dated-id alias resolution). An unmatched id is rejected (404).
  if (bound?.type === "kiro") {
    let provider = lookupProviderForTool(tool, rawModel);
    if (provider) return { provider, model: rawModel };
    const model = resolveKiroModel(rawModel);
    if (model !== rawModel) {
      provider = lookupProviderForTool(tool, model);
      if (provider) return { provider, model };
    }
    return { provider: null, model: rawModel };
  }

  // Passthrough (non-Kiro) provider — #171 item 3: forward the raw id untouched
  // regardless of the configured list; the provider's own response is the source
  // of truth. A disabled bound provider is not relaxed (no traffic to disabled).
  if (bound && bound.enabled !== false) return { provider: bound, model: rawModel };

  return { provider: null, model: rawModel };
}

// Execute a Kiro chat request: fetch the runtime host with a pre-built Kiro
// payload, apply Kiro-specific error mapping, record usage. Returns { upstream,
// startTime } on success — the caller consumes upstream.body via the appropriate
// collector/streamer and performs the SUCCESS logRequest with the usage it extracts.
//
// `model` must already be the resolved Kiro catalog id (from lookupModelForTool).
// `kiroPayload` is the wire-format request body (built by anthropicToKiro or
// codexToKiro) — the executor no longer owns payload construction.
export async function executeKiro({ adapter, provider, tool, model, rawModel, kiroPayload }) {
  const url = adapter.getRequestUrl(model, {});
  const headers = adapter.getRequestHeaders();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  const startTime = Date.now();

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(kiroPayload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new ApiError(504, "Kiro API timeout");
    // Connect-level failure (DNS/TCP/TLS) — a reachability problem, not a bug.
    // Map it so it reads clearly, gets logged, and can trigger auto-fallback.
    const mapped = networkErrorToApiError(err, provider?.name || "Kiro");
    if (mapped !== err) {
      recordError(model);
      logRequest({
        tool, rawModel, model,
        providerId: provider.id, providerName: provider.name,
        latencyMs: Date.now() - startTime,
        status: "error",
        error: mapped.message,
      });
    }
    throw mapped;
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    recordError(model);
    const detail = await upstream.text().catch(() => "");
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
    if (upstream.status === 403) {
      throw new ApiError(
        502,
        `Kiro rejected the API key (403). Check the key is still valid in the Kiro portal: ${detail.slice(0, 200)}`
      );
    }
    throw new ApiError(
      upstream.status >= 500 ? 502 : upstream.status,
      `Kiro API error (${upstream.status}): ${detail.slice(0, 200)}`
    );
  }

  recordRequest(model);
  return { upstream, startTime };
}

// executeKiro with auto-fallback to other Kiro providers. Kiro stays strict
// — sending it an unconfigured model id is a ban risk — so a fallback
// candidate is only tried if it advertises the resolved `model` (or the raw
// id). Returns the provider/adapter that served, plus `fallback`. Off by
// default; when fallbackEnabled is false this is exactly executeKiro.
//
// Each failed attempt is logged as an error entry by executeKiro, so every
// Kiro account that was tried shows up in the log (spend clarity).
export async function executeKiroWithFallback({ adapter: primaryAdapter, provider: primaryProvider, tool, model, rawModel, kiroPayload }) {
  let lastErr;
  try {
    const r = await executeKiro({ adapter: primaryAdapter, provider: primaryProvider, tool, model, rawModel, kiroPayload });
    return { ...r, provider: primaryProvider, adapter: primaryAdapter, fallback: false };
  } catch (err) {
    lastErr = err;
    if (!isFallbackEnabled() || !isRetryableApiError(err)) throw err;
  }

  for (const fp of fallbackProviders(tool, primaryProvider)) {
    // Strict: only fall back to a Kiro provider that advertises this model.
    const configured = getProviderModels(fp.id);
    if (!configured.includes(model) && !configured.includes(rawModel)) continue;
    let adapter;
    try {
      adapter = await createAdapter(fp);
    } catch {
      continue;
    }
    try {
      const r = await executeKiro({ adapter, provider: fp, tool, model, rawModel, kiroPayload });
      return { ...r, provider: fp, adapter, fallback: true };
    } catch (err) {
      lastErr = err;
      if (!isRetryableApiError(err)) throw err;
    }
  }
  throw lastErr;
}
