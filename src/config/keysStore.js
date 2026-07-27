import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "./envStore.js";

// Tool slots: each tool/agent can route to a different provider
// "claude"  = /v1/messages (Anthropic Messages API — Claude Code)
// "codex"   = /v1/responses (OpenAI Responses API — Codex)
// "openai"  = /v1/chat/completions (OpenAI Chat API — Cursor, etc.)
//            Kiro is NOT supported on this slot (its protocol is Anthropic-
//            shaped); route Kiro via the "claude" or "codex" slot instead.
export const TOOL_SLOTS = ["claude", "codex", "openai"];

export function keysPath() {
  return join(dataDir(), "keys.json");
}

function readAll() {
  if (!existsSync(keysPath())) return { providers: [], models: [], routing: {} };
  try {
    const parsed = JSON.parse(readFileSync(keysPath(), "utf8"));
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      models: Array.isArray(parsed.models) ? parsed.models : [],
      routing: parsed.routing || {},
    };
  } catch {
    return { providers: [], models: [], routing: {} };
  }
}

// Atomic write: temp file + rename.
function writeAll(data) {
  mkdirSync(dataDir(), { recursive: true });
  const tmp = `${keysPath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, keysPath());
  chmodSync(keysPath(), 0o600);
}

function newId() {
  return `provider-${randomBytes(4).toString("hex")}`;
}

// --- Routing (per-tool provider assignment) ----------------------------
// routing = { claude: "provider-xxx", codex: "provider-yyy", openai: "provider-zzz" }
// Each tool routes ONLY to its assigned provider's models. Unassigned = no routing.

export function getRouting() {
  return readAll().routing;
}

export function getToolProvider(tool) {
  const data = readAll();
  const providerId = data.routing[tool];
  if (!providerId) return null;
  return data.providers.find((p) => p.id === providerId) || null;
}

export function setToolProvider(tool, providerId) {
  if (!TOOL_SLOTS.includes(tool)) return null;
  const data = readAll();
  if (providerId) {
    const provider = data.providers.find((p) => p.id === providerId);
    if (!provider) return null;
    data.routing[tool] = providerId;
  } else {
    delete data.routing[tool];
  }
  writeAll(data);
  return data.routing;
}

// Convenience: set all tools to the same provider (1-click "use everywhere")
export function setAllToolsProvider(providerId) {
  const data = readAll();
  const provider = data.providers.find((p) => p.id === providerId);
  if (!provider) return null;
  for (const tool of TOOL_SLOTS) {
    data.routing[tool] = providerId;
  }
  writeAll(data);
  return data.routing;
}

// --- Providers ---------------------------------------------------------

export function listProviders() {
  return readAll().providers;
}

export function getProvider(id) {
  return readAll().providers.find((p) => p.id === id);
}

export function addProvider({ name, type, baseUrl, apiKeyRef, region, creditBudget }) {
  const data = readAll();
  const provider = {
    id: newId(),
    name,
    type,
    baseUrl,
    apiKeyRef,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastTestedAt: null,
    status: "untested",
  };
  // Kiro derives endpoints from region; credit budget is optional per-account.
  if (type === "kiro") {
    provider.region = region || "us-east-1";
    provider.usedCredits = 0;
    if (creditBudget) provider.creditBudget = creditBudget;
  }
  data.providers.push(provider);
  writeAll(data);
  return provider;
}

export function updateProvider(id, patch) {
  const data = readAll();
  const p = data.providers.find((x) => x.id === id);
  if (!p) return undefined;
  Object.assign(p, patch);
  writeAll(data);
  return p;
}

export function deleteProvider(id) {
  const data = readAll();
  // Remove from routing if assigned
  for (const tool of TOOL_SLOTS) {
    if (data.routing[tool] === id) delete data.routing[tool];
  }
  data.providers = data.providers.filter((p) => p.id !== id);
  data.models = data.models.filter((m) => m.providerId !== id);
  writeAll(data);
}

// --- Models per provider -----------------------------------------------

export function setProviderModels(providerId, modelIds) {
  const data = readAll();
  const provider = data.providers.find((p) => p.id === providerId);
  if (!provider) return undefined;
  data.models = data.models.filter((m) => m.providerId !== providerId);
  for (const modelId of modelIds) {
    data.models.push({ modelId, providerId });
  }
  writeAll(data);
  return modelIds;
}

// Lookup model for a specific tool. Only routes to the provider assigned
// to that tool, and only if the model is configured on it AND provider is enabled.
export function lookupProviderForTool(tool, modelId) {
  const data = readAll();
  const providerId = data.routing[tool];
  if (!providerId) return undefined;
  const provider = data.providers.find((p) => p.id === providerId);
  if (!provider || provider.enabled === false) return undefined;
  const binding = data.models.find(
    (m) => m.modelId === modelId && m.providerId === providerId
  );
  if (!binding) return undefined;
  return provider;
}

// Get models available for a specific tool (from its assigned provider)
export function getToolModels(tool) {
  const data = readAll();
  const providerId = data.routing[tool];
  if (!providerId) return [];
  return data.models
    .filter((m) => m.providerId === providerId)
    .map((m) => m.modelId);
}

// Get all models across all active tool routes (for /v1/models)
export function getEnabledModels() {
  const data = readAll();
  const activeProviderIds = new Set(Object.values(data.routing));
  if (!activeProviderIds.size) return [];
  const seen = new Set();
  return data.models
    .filter((m) => activeProviderIds.has(m.providerId))
    .filter((m) => { if (seen.has(m.modelId)) return false; seen.add(m.modelId); return true; })
    .map((m) => m.modelId);
}

// Get all models configured for a specific provider
export function getProviderModels(providerId) {
  return readAll()
    .models.filter((m) => m.providerId === providerId)
    .map((m) => m.modelId);
}

// Full snapshot (for config export).
export function snapshot() {
  return readAll();
}

// Replace snapshot (for config import).
export function replace(newData) {
  writeAll({
    providers: Array.isArray(newData.providers) ? newData.providers : [],
    models: Array.isArray(newData.models) ? newData.models : [],
    routing: newData.routing || {},
  });
}
