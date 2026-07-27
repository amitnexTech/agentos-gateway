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

import { lookupProviderForTool, getToolProvider } from "../config/keysStore.js";
import { recordRequest, recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { ApiError } from "../lib/errors.js";
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
//  - non-Kiro provider → the raw id, untouched
//  - Kiro provider → the resolved (short) id when a dated id was sent
//  - no match → { provider: null, model: rawModel } (caller surfaces 404)
//
// The lookup itself (lookupProviderForTool) already enforces that the model is
// in the provider's configured list, so Kiro never receives an unconfigured id
// (ban risk). The redundant getToolModels() re-check that used to live in each
// route's Kiro branch is gone — this single binding check is enough (#171 item 4).
export function lookupModelForTool(tool, rawModel) {
  let provider = lookupProviderForTool(tool, rawModel);
  if (provider) return { provider, model: rawModel };

  // Kiro's catalog uses short names; a date-suffixed id only matches a binding
  // after resolution. Non-Kiro providers get no retry — their catalog is their
  // own concern. (Whether to relax that for passthrough providers is #171 item
  // 3, deferred until Amit decides; gating stays strict here.)
  if (getToolProvider(tool)?.type === "kiro") {
    const model = resolveKiroModel(rawModel);
    if (model !== rawModel) {
      provider = lookupProviderForTool(tool, model);
      if (provider) return { provider, model };
    }
  }
  return { provider: null, model: rawModel };
}

// Execute a Kiro chat request: build the Kiro payload from an Anthropic-shaped
// request, fetch the runtime host, apply Kiro-specific error mapping, record
// usage. Returns { upstream, startTime } on success — the caller consumes
// upstream.body via streamKiroToAnthropic (streaming) or collectKiroResponse
// (collected) and performs the SUCCESS logRequest with the usage it extracts.
//
// `model` must already be the resolved Kiro catalog id (from lookupModelForTool).
// `anthropicReq` is the Anthropic Messages-shaped body; its model field is
// overridden with the resolved id.
export async function executeKiro({ adapter, provider, tool, model, rawModel, anthropicReq }) {
  const kiroPayload = anthropicToKiro({ ...anthropicReq, model });
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
    throw err;
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
