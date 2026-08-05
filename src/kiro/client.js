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

import { getToolProvider, resolveModelRoute, resolveProfile, fallbackProviders, getProviderModels, isOverBudget } from "../config/keysStore.js";
import { requestContext } from "../lib/requestContext.js";
import { recordRequest, recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { isFallbackEnabled } from "../config/keysStore.js";
import { isRetryableApiError } from "../lib/fallback.js";
import { ApiError } from "../lib/errors.js";
import { networkErrorToApiError } from "../lib/netError.js";
import { armTimeout } from "../lib/proxyExecute.js";
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

// Candidate Kiro catalog ids for a model id a client sent, in decreasing order
// of fidelity. The caller keeps the first one the account actually advertises,
// so nothing is guessed away when an exact match exists.
//
// Decorations that get peeled: an explicit alias, a trailing capability marker in
// brackets (the form CLAUDE_CODE_SUBAGENT_MODEL is written in, e.g.
// "claude-sonnet-5[1M]" — measured 2026-08-02, Claude Code does NOT send that
// suffix on the wire, so this is insurance for clients that do, not a live fix),
// the -YYYYMMDD date suffix, and finally Anthropic's dashed version style
// ("claude-sonnet-4-5") which Kiro spells with a dot ("claude-sonnet-4.5").
export function kiroModelCandidates(model) {
  const out = [];
  const push = (m) => { if (m && !out.includes(m)) out.push(m); };

  push(model);
  if (MODEL_ALIASES[model]) push(MODEL_ALIASES[model]);

  const undecorated = model.replace(/\[[^\]]*\]$/, "");
  push(undecorated);
  if (MODEL_ALIASES[undecorated]) push(MODEL_ALIASES[undecorated]);

  const undated = undecorated.replace(/-\d{8}$/, "");
  push(undated);
  if (MODEL_ALIASES[undated]) push(MODEL_ALIASES[undated]);

  // claude-sonnet-4-5 -> claude-sonnet-4.5
  push(undated.replace(/-(\d+)-(\d+)$/, "-$1.$2"));

  return out;
}

// Single best-guess resolution, for callers with no catalog to check against.
// ponytail: deleted — it had no caller, and its "last candidate wins" rule was
// wrong for the aliased ids (claude-opus-4-20250514 would resolve to
// claude-opus-4, the very name the alias exists because Kiro does NOT serve).
// lookupModelForTool below walks kiroModelCandidates in order against the
// account's real catalog, which is the only correct way to pick.

// Look up the provider bound to a tool for the given model id, applying Kiro
// alias resolution only when the tool is routed to a Kiro provider.
//
// Resolution order: an `exempt` entry, then the request's session profile
// (keysStore "Session profiles" — the /p/<name>/v1 prefix), then a per-model
// override (keysStore modelRoutes), then the tool's own slot.
//
// A per-model override (keysStore modelRoutes) wins over the tool's default
// provider — that is how a cheap background model gets kept off an expensive
// account without moving the whole tool. An override may also carry the upstream
// model id, since catalogs disagree on names; that id is what gets forwarded.
//
// Returns { provider, model } where `model` is what to forward upstream:
//  - override with a target model -> that id (client's id stays in rawModel)
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
  const route = resolveModelRoute(tool, rawModel);
  // A session profile (the /p/<name>/v1 base URL this request came in on) beats
  // the global model routes — that is what lets parallel sessions run different
  // models. An explicit `exempt` entry still wins, because those exist to keep
  // Claude Code's auto-mode/subagent classifier ids on a provider that serves
  // them; a profile that forced those onto one pinned model would break auto mode.
  const session = route?.exempt ? null : resolveProfile(requestContext().profile);
  // `exempt` means this model id is opted out of a force route: tool's own
  // provider, client's own id. Claude Code's subagent/auto-mode classifier
  // models need that, or auto mode breaks.
  const forced = session || (route && !route.exempt ? route : null);
  const bound = forced?.provider || getToolProvider(tool);
  if (!bound || bound.enabled === false) return { provider: null, model: rawModel };
  // An override's target id is deliberate, so it is what Kiro gets gated on too.
  // A profile with no model pinned forwards the client's own id.
  const wanted = forced ? forced.model || rawModel : rawModel;

  // Kiro is strict: only forward ids configured on the bound Kiro provider
  // (after peeling the decorations clients add). An unmatched id is rejected (404).
  if (bound.type === "kiro") {
    const configured = getProviderModels(bound.id);
    for (const candidate of kiroModelCandidates(wanted)) {
      if (configured.includes(candidate)) return { provider: bound, model: candidate };
    }
    return { provider: null, model: wanted };
  }

  // Passthrough (non-Kiro) provider — #171 item 3: forward the id untouched
  // regardless of the configured list; the provider's own response is the source
  // of truth. A disabled provider is not relaxed (no traffic to disabled).
  return { provider: bound, model: wanted };
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
  // Credit budget is enforced here, before anything is spent, because every Kiro
  // request on every route passes through this function. Until 2026-08-02 the
  // budget was display-only and an exhausted account kept serving.
  if (isOverBudget(provider)) {
    const err = new ApiError(
      402,
      `Kiro account "${provider.name}" has used its credit budget ` +
        `(${(provider.usedCredits || 0).toFixed(2)} of ${provider.creditBudget} cr). ` +
        `Raise or clear the budget in the dashboard, reset its usage, or route this tool to another account.`
    );
    err.budgetExhausted = true; // lib/fallback.js treats this as worth a fallback
    logRequest({
      tool, rawModel, model,
      providerId: provider.id, providerName: provider.name,
      latencyMs: 0, status: "error", error: err.message,
    });
    err.logged = true; // already in the log; the route's catch must not repeat it
    throw err;
  }

  const url = adapter.getRequestUrl(model, {});
  const headers = adapter.getRequestHeaders();

  const controller = new AbortController();
  // Same rule as the non-Kiro path: no fixed abort unless one is configured.
  const clearTimer = armTimeout(controller);
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
    clearTimer();
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
      mapped.logged = true;
    }
    throw mapped;
  }
  clearTimer();

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
    // Both throws are for a failure already written to the log.
    const logged = (e) => Object.assign(e, { logged: true });
    if (upstream.status === 403) {
      throw logged(new ApiError(
        502,
        `Kiro rejected the API key (403). Check the key is still valid in the Kiro portal: ${detail.slice(0, 200)}`
      ));
    }
    throw logged(new ApiError(
      upstream.status >= 500 ? 502 : upstream.status,
      `Kiro API error (${upstream.status}): ${detail.slice(0, 200)}`
    ));
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
    // Strict: only fall back to a Kiro provider that advertises this model, and
    // never onto an account that is already over its own credit budget.
    if (isOverBudget(fp)) continue;
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
