import { Router } from "express";
import { randomBytes } from "node:crypto";
import {
  listProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  setProviderModels,
  getEnabledModels,
  getProviderModels,
  getRouting,
  getToolProvider,
  setToolProvider,
  setAllToolsProvider,
  getModelRoutes,
  resolveModelRoute,
  setModelRoute,
  getProfiles,
  resolveProfile,
  setProfile,
  supportedTypesForTool,
  isFallbackEnabled,
  setFallbackEnabled,
  TOOL_SLOTS,
  snapshot,
  replace,
} from "../config/keysStore.js";
import { envSet, envGet, envDelete, envSnapshot, envReplace } from "../config/envStore.js";
import { kiroModelCandidates } from "../kiro/client.js";
import { getStats } from "../config/usageStore.js";
import { supportedTypes, createAdapter } from "../registry.js";
import { fetchModels } from "../lib/modelFetch.js";
import { probeProvider } from "../lib/providerProbe.js";
import { ApiError } from "../lib/errors.js";
import { renderAdminPage } from "./adminPage.js";
import { renderDashboardPage } from "./dashboardPage.js";
import { renderRoutingPage } from "./routingPage.js";
import { renderProvidersPage } from "./providersPage.js";
import { renderLogsPage } from "./logsPage.js";
import { renderSpendAnalyticsPage } from "./spendAnalyticsPage.js";
import { renderKiroPage } from "./kiroPage.js";
import { renderGuidePage } from "./guidePage.js";
import { adminToken } from "../lib/adminAuth.js";
import { getLogs, clearLogs } from "../config/logStore.js";
import { getSpend } from "../config/spendStore.js";
import { kiroAccountRouter } from "./kiroAccount.js";

export const adminRouter = Router();

function maskKey(key = "") {
  if (!key) return "";
  if (key.length <= 4) return "****";
  return `${"*".repeat(key.length - 4)}${key.slice(-4)}`;
}

function providerView(provider) {
  const routing = getRouting();
  const assignedTools = TOOL_SLOTS.filter((t) => routing[t] === provider.id);
  return {
    ...provider,
    models: getProviderModels(provider.id),
    apiKeyMasked: provider.apiKeyRef ? maskKey(envGet(provider.apiKeyRef)) : "",
    assignedTools,
  };
}

function providerKeyRef() {
  return `AGENTOS_KEY_${randomBytes(6).toString("hex").toUpperCase()}`;
}

function requireProvider(id) {
  const provider = getProvider(id);
  if (!provider) throw new ApiError(404, "Provider not found");
  return provider;
}

adminRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), version: "0.1.0" });
});

// --- HTML pages (sidebar navigation) ---
// The JSON APIs keep their original paths (GET /admin/routing, /admin/providers)
// because scripts/bridge-verify.mjs and the docs' curl examples read them; the
// pages therefore live on "-panel" paths rather than stealing those URLs.
adminRouter.get("/", (_req, res) => {
  res.type("html").send(renderDashboardPage());
});

// The previous single-page dashboard, kept as a rollback path while the split
// pages settle.
adminRouter.get("/classic", (_req, res) => {
  res.type("html").send(renderAdminPage());
});

adminRouter.get("/routing-panel", (_req, res) => {
  res.type("html").send(renderRoutingPage());
});

adminRouter.get("/providers-panel", (_req, res) => {
  res.type("html").send(renderProvidersPage());
});

adminRouter.get("/kiro", (_req, res) => {
  res.type("html").send(renderKiroPage());
});

// Setup guide. Built from live state, not hardcoded: the port comes from the
// request's own Host header so the snippets are correct even on a test instance
// running on another port, and the profile list keeps the URLs honest.
adminRouter.get("/guide", (req, res) => {
  const host = req.headers.host || "";
  const port = host.includes(":") ? host.split(":").pop() : process.env.PORT || 9000;
  res.type("html").send(
    renderGuidePage({
      port,
      host: process.env.HOST || "127.0.0.1",
      adminToken: adminToken(),
      profiles: Object.keys(getProfiles()),
    })
  );
});

// --- Routing (per-tool provider assignment) ---

adminRouter.get("/routing", (_req, res) => {
  const routing = getRouting();
  const detailed = {};
  for (const tool of TOOL_SLOTS) {
    const provider = getToolProvider(tool);
    detailed[tool] = provider ? { id: provider.id, name: provider.name, type: provider.type } : null;
  }
  detailed.fallbackEnabled = isFallbackEnabled();
  // Which provider types each route can actually serve, so the dashboard offers
  // only workable pairings instead of letting the user wire a slot that fails
  // upstream (or worse, returns an empty answer).
  detailed.supportedTypes = Object.fromEntries(TOOL_SLOTS.map((t) => [t, supportedTypesForTool(t)]));
  res.json(detailed);
});

// --- Per-model routes (override a tool's provider for one model id) ---
// A tool slot sends every model to one provider. These overrides exist because
// that is expensive: a client's cheap background model can be pinned to a cheap
// account while the real work stays on the good one.
// Registered before /routing/:tool so "model" is not captured as a tool param.

adminRouter.get("/routing/models", (_req, res) => {
  const routes = getModelRoutes();
  const detailed = {};
  for (const [tool, byModel] of Object.entries(routes)) {
    detailed[tool] = {};
    for (const [modelId, raw] of Object.entries(byModel)) {
      // An exempt entry has no provider by definition — it means "leave this one
      // on the tool's own provider", which is how a force route gets holes.
      // Whether that provider can actually serve the id is the trap this reports:
      // exempting an id the slot provider does not sell turns the call into a 403
      // (measured: a router that only sells one model answered
      // "This token has no access to model claude-sonnet-5").
      if (raw && typeof raw === "object" && raw.exempt) {
        detailed[tool][modelId] = { exempt: true, ...slotCoverage(tool, modelId) };
        continue;
      }
      const route = resolveModelRoute(tool, modelId);
      if (route && !route.exempt) {
        detailed[tool][modelId] = {
          id: route.provider.id,
          name: route.provider.name,
          type: route.provider.type,
          model: route.model,
        };
      } else {
        // Provider gone or disabled: still reported, so a dead override is
        // visible instead of silently falling back to the tool default.
        detailed[tool][modelId] = {
          id: typeof raw === "string" ? raw : raw?.providerId || null,
          name: null,
          type: null,
          model: typeof raw === "string" ? modelId : raw?.model || modelId,
          unavailable: true,
        };
      }
    }
  }
  res.json(detailed);
});

// Can the tool's own provider serve this model id? Kiro is strict (an id outside
// its configured list is rejected outright), everything else is passthrough — the
// id is forwarded even when unlisted, so an unlisted id is a warning, not a
// verdict. Mirrors the matching in kiro/client.js lookupModelForTool.
function slotCoverage(tool, modelId) {
  const slot = getToolProvider(tool);
  if (!slot) return { slotProvider: null, servedBySlot: false, strict: false };
  const configured = getProviderModels(slot.id);
  const strict = slot.type === "kiro";
  const servedBySlot = strict
    ? kiroModelCandidates(modelId).some((c) => configured.includes(c))
    : configured.includes(modelId);
  return { slotProvider: slot.name, servedBySlot, strict };
}

// Distinct model ids clients have actually asked for, from the request log.
// Without this the only way to learn what an agent sends (Claude Code's subagent
// id, its auto-mode classifier id, …) is to guess — and a wrong guess produces a
// route that never matches anything.
adminRouter.get("/routing/seen", (_req, res) => {
  const routes = getModelRoutes();
  const seen = new Map();
  for (const entry of getLogs({ limit: 1000 })) {
    const tool = entry.tool;
    // logStore stores rawModel only when it differs from what was sent upstream,
    // so the id the CLIENT asked for is rawModel ?? model.
    const asked = entry.rawModel || entry.model;
    if (!tool || !asked) continue;
    const key = `${tool}|${asked}`;
    const hit = seen.get(key) || { tool, model: asked, count: 0, lastSeen: entry.ts, routed: false };
    hit.count++;
    if (entry.ts > hit.lastSeen) hit.lastSeen = entry.ts;
    seen.set(key, hit);
  }
  const out = [...seen.values()].map((hit) => ({
    ...hit,
    routed: Boolean(routes[hit.tool]?.[hit.model]),
  }));
  out.sort((a, b) => b.count - a.count);
  res.json(out);
});

// POST /admin/routing/models { tool, model, providerId, targetModel, exempt }
//   model "*"       -> force route for every model without an exact entry
//   exempt true     -> keep this model id on the tool's own provider (the escape
//                      hatch a force route needs for Claude Code's subagent /
//                      auto-mode classifier models)
//   providerId null -> clear the entry
adminRouter.post("/routing/models", (req, res, next) => {
  try {
    const { tool, model, providerId, targetModel, exempt } = req.body || {};
    if (!TOOL_SLOTS.includes(tool)) throw new ApiError(400, `tool must be one of ${TOOL_SLOTS.join(", ")}`);
    if (!model) throw new ApiError(400, "model is required");
    if (exempt && model === "*") throw new ApiError(400, "the force route (*) cannot be exempt from itself");
    if (!exempt && providerId) requireProvider(providerId);
    const route = exempt
      ? { exempt: true }
      : providerId
        ? { providerId, model: targetModel || null }
        : null;
    const modelRoutes = setModelRoute(tool, model, route);
    if (!modelRoutes) {
      throw new ApiError(
        400,
        model === "*" && providerId
          ? "The force route (*) needs a target model — there is no client id to fall back on"
          : "Rejected: unknown provider, or a provider type this route cannot serve"
      );
    }
    res.json({ ok: true, modelRoutes });
  } catch (err) {
    next(err);
  }
});

// Set ALL tools to the same provider (convenience): POST /admin/routing/all { providerId: "xxx" }
adminRouter.post("/routing/all", (req, res, next) => {
  try {
    const { providerId } = req.body || {};
    if (!providerId) throw new ApiError(400, "providerId is required");
    requireProvider(providerId);
    const result = setAllToolsProvider(providerId);
    if (!result) throw new ApiError(400, "Unknown provider");
    res.json({
      ok: true,
      routing: result.routing,
      skipped: result.skipped,
      ...(result.skipped.length
        ? { note: `Skipped ${result.skipped.join(", ")} — this provider type cannot serve those routes.` }
        : {}),
    });
  } catch (err) {
    next(err);
  }
});

// Toggle auto-fallback: POST /admin/routing/fallback { enabled: true|false }
// Registered before /routing/:tool so "fallback" is not captured as a tool param.
adminRouter.post("/routing/fallback", (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    const routing = setFallbackEnabled(Boolean(enabled));
    res.json({ ok: true, fallbackEnabled: isFallbackEnabled(), routing });
  } catch (err) {
    next(err);
  }
});

// --- Session profiles (per-session provider + model, chosen by base URL) ---
// A tool slot is global: every session follows it. A profile is the same pairing
// scoped to one session, selected by the base URL it was started with, so
// parallel sessions can run different models. See keysStore "Session profiles".

adminRouter.get("/profiles", (_req, res) => {
  const out = {};
  for (const [name, profile] of Object.entries(getProfiles())) {
    const resolved = resolveProfile(name);
    out[name] = resolved
      ? { id: resolved.provider.id, name: resolved.provider.name, type: resolved.provider.type, model: resolved.model }
      // Reported, not hidden: a profile whose provider is gone refuses every
      // request from its sessions, so it has to be visible in the dashboard.
      : { id: profile?.providerId || null, name: null, type: null, model: profile?.model || null, unavailable: true };
  }
  res.json(out);
});

// POST /admin/profiles { name, providerId, model? } — providerId null deletes it.
adminRouter.post("/profiles", (req, res, next) => {
  try {
    const { name, providerId, model } = req.body || {};
    if (!name) throw new ApiError(400, "name is required");
    if (providerId) requireProvider(providerId);
    const profiles = setProfile(name, providerId ? { providerId, model: model || null } : null);
    if (!profiles) {
      throw new ApiError(
        400,
        "Rejected: unknown provider, or a name outside a-z 0-9 _ - (max 32 chars — it becomes a URL path segment)"
      );
    }
    res.json({ ok: true, profiles });
  } catch (err) {
    next(err);
  }
});

// Set provider for a specific tool: POST /admin/routing/claude { providerId: "xxx" }
adminRouter.post("/routing/:tool", (req, res, next) => {
  try {
    const { tool } = req.params;
    if (!TOOL_SLOTS.includes(tool)) throw new ApiError(400, `Unknown tool: ${tool}. Valid: ${TOOL_SLOTS.join(", ")}`);
    const { providerId } = req.body || {};
    if (providerId) requireProvider(providerId);
    const routing = setToolProvider(tool, providerId || null);
    if (!routing) {
      const provider = providerId ? getProvider(providerId) : null;
      throw new ApiError(
        400,
        provider
          ? `Provider "${provider.name}" (${provider.type}) cannot serve the ${tool} route — it needs ${supportedTypesForTool(tool).join(" or ")}.`
          : "Unknown provider"
      );
    }
    res.json({ ok: true, routing });
  } catch (err) {
    next(err);
  }
});

// --- Providers ---

adminRouter.get("/providers", (_req, res) => {
  res.json(listProviders().map(providerView));
});

adminRouter.post("/providers", (req, res, next) => {
  try {
    const { name, type, baseUrl, apiKey } = req.body || {};
    if (!name || !type || !baseUrl) {
      throw new ApiError(400, "name, type, and baseUrl are required");
    }
    if (!supportedTypes().includes(type)) {
      throw new ApiError(400, `Unsupported provider type: ${type}. Supported: ${supportedTypes().join(", ")}`);
    }
    if (type !== "local-openai" && !apiKey) {
      throw new ApiError(400, "apiKey is required for this provider type");
    }

    const apiKeyRef = apiKey ? providerKeyRef() : null;
    if (apiKeyRef) envSet(apiKeyRef, apiKey);
    const provider = addProvider({ name, type, baseUrl, apiKeyRef });
    res.status(201).json(providerView(provider));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/providers/:id", (req, res, next) => {
  try {
    res.json(providerView(requireProvider(req.params.id)));
  } catch (err) {
    next(err);
  }
});

adminRouter.put("/providers/:id", (req, res, next) => {
  try {
    const provider = requireProvider(req.params.id);
    const { name, type, baseUrl, apiKey, status, enabled } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (baseUrl !== undefined) patch.baseUrl = baseUrl;
    if (status !== undefined) patch.status = status;
    if (enabled !== undefined) patch.enabled = Boolean(enabled);
    if (type !== undefined) {
      if (!supportedTypes().includes(type)) throw new ApiError(400, `Unsupported provider type: ${type}`);
      patch.type = type;
    }
    if (apiKey !== undefined) {
      const apiKeyRef = provider.apiKeyRef || providerKeyRef();
      envSet(apiKeyRef, apiKey);
      patch.apiKeyRef = apiKeyRef;
    }
    res.json(providerView(updateProvider(req.params.id, patch)));
  } catch (err) {
    next(err);
  }
});

adminRouter.delete("/providers/:id", (req, res) => {
  const provider = getProvider(req.params.id);
  if (provider && provider.apiKeyRef) envDelete(provider.apiKeyRef);
  deleteProvider(req.params.id);
  res.status(204).end();
});

// --- Models ---

adminRouter.get("/providers/:id/models", async (req, res, next) => {
  try {
    const provider = requireProvider(req.params.id);
    const adapter = await createAdapter(provider);
    const result = await fetchModels({ adapter, apiKey: adapter.apiKey });
    // Auto-correct baseUrl if /v1 was missing
    if (result.correctedBaseUrl) {
      updateProvider(provider.id, { baseUrl: result.correctedBaseUrl });
    }
    res.json(result.models);
  } catch (err) {
    // If fetch fails, return already-configured models
    const existing = getProviderModels(req.params.id);
    if (existing.length) {
      res.json(existing.map((id) => ({ id, cached: true })));
    } else {
      next(err instanceof ApiError ? err : new ApiError(502, `Failed to fetch models: ${err.message}`));
    }
  }
});

// Manual model add (when auto-fetch fails or provider doesn't support /models)
adminRouter.post("/providers/:id/models/add", (req, res, next) => {
  try {
    requireProvider(req.params.id);
    const { models } = req.body || {};
    if (!Array.isArray(models) || !models.length) throw new ApiError(400, "models must be a non-empty array of model IDs");
    // Merge with existing models
    const existing = getProviderModels(req.params.id);
    const merged = [...new Set([...existing, ...models])];
    const saved = setProviderModels(req.params.id, merged);
    res.json({ ok: true, models: saved });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/providers/:id/models", (req, res, next) => {
  try {
    requireProvider(req.params.id);
    const { models } = req.body || {};
    if (!Array.isArray(models)) throw new ApiError(400, "models must be an array");
    const saved = setProviderModels(req.params.id, models);
    res.json({ ok: true, models: saved });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/providers/:id/test", async (req, res, next) => {
  try {
    const provider = requireProvider(req.params.id);
    const configuredProbeModel = req.body?.model || getProviderModels(provider.id)[0];
    const probe = await probeProvider(provider, { modelId: configuredProbeModel });
    const updated = updateProvider(req.params.id, {
      status: "ok",
      lastTestedAt: new Date().toISOString(),
    });
    res.json({ ...providerView(updated), probe });
  } catch (err) {
    if (getProvider(req.params.id)) {
      updateProvider(req.params.id, { status: "error", lastTestedAt: new Date().toISOString() });
    }
    next(err instanceof ApiError ? err : new ApiError(502, `Provider test failed: ${err.message}`));
  }
});

// All models across routed providers (for /v1/models)
adminRouter.get("/models", (_req, res) => {
  res.json(getEnabledModels());
});

adminRouter.get("/stats", (_req, res) => {
  res.json(getStats());
});

adminRouter.get("/config", (_req, res) => {
  res.json({ keys: snapshot(), env: envSnapshot() });
});

adminRouter.post("/config", (req, res) => {
  const body = req.body || {};
  replace(body.keys || body);
  if (body.env) envReplace(body.env);
  res.json({ ok: true });
});


// --- Logs ---

adminRouter.get("/logs", (_req, res) => {
  res.type("html").send(renderLogsPage());
});

adminRouter.get("/logs/data", (req, res) => {
  const { limit, tool } = req.query;
  res.json(getLogs({ limit: Number(limit) || 100, tool: tool || undefined }));
});

adminRouter.delete("/logs", (_req, res) => {
  clearLogs();
  res.json({ ok: true });
});

// Spend: the permanent record the 200-entry log cannot answer for — monthly totals
// broken down by project, provider, model, tool and client. See spendStore.js.
adminRouter.get("/spend", (_req, res) => {
  res.type("html").send(renderSpendAnalyticsPage());
});

adminRouter.get("/spend/data", (req, res) => {
  res.json(getSpend({ month: req.query.month }));
});


// --- Kiro Account Management ---
adminRouter.use(kiroAccountRouter);
