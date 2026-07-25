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
  TOOL_SLOTS,
  snapshot,
  replace,
} from "../config/keysStore.js";
import { envSet, envGet, envDelete, envSnapshot, envReplace } from "../config/envStore.js";
import { getStats } from "../config/usageStore.js";
import { supportedTypes, createAdapter } from "../registry.js";
import { fetchModels } from "../lib/modelFetch.js";
import { probeProvider } from "../lib/providerProbe.js";
import { ApiError } from "../lib/errors.js";
import { renderAdminPage } from "./adminPage.js";
import { getLogs, clearLogs } from "../config/logStore.js";
import { renderLogPage } from "./logPage.js";

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

adminRouter.get("/", (_req, res) => {
  res.type("html").send(renderAdminPage());
});

// --- Routing (per-tool provider assignment) ---

adminRouter.get("/routing", (_req, res) => {
  const routing = getRouting();
  const detailed = {};
  for (const tool of TOOL_SLOTS) {
    const provider = getToolProvider(tool);
    detailed[tool] = provider ? { id: provider.id, name: provider.name, type: provider.type } : null;
  }
  res.json(detailed);
});

// Set ALL tools to the same provider (convenience): POST /admin/routing/all { providerId: "xxx" }
adminRouter.post("/routing/all", (req, res, next) => {
  try {
    const { providerId } = req.body || {};
    if (!providerId) throw new ApiError(400, "providerId is required");
    requireProvider(providerId);
    const routing = setAllToolsProvider(providerId);
    res.json({ ok: true, routing });
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
  res.type("html").send(renderLogPage());
});

adminRouter.get("/logs/data", (req, res) => {
  const { limit, tool } = req.query;
  res.json(getLogs({ limit: Number(limit) || 100, tool: tool || undefined }));
});

adminRouter.delete("/logs", (_req, res) => {
  clearLogs();
  res.json({ ok: true });
});
