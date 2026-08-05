import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "./envStore.js";

// TOOL_SLOTS is the list of tool slots each provider can be bound to.
// "claude"  = /v1/messages (Anthropic Messages API — Claude Code)
// "codex"   = /v1/responses (OpenAI Responses API — Codex)
// "openai"  = /v1/chat/completions (OpenAI Chat API — Cursor, etc.)
// Which provider types each slot accepts lives in TOOL_PROVIDER_TYPES below.
export const TOOL_SLOTS = ["claude", "codex", "openai"];

export function keysPath() {
  return join(dataDir(), "keys.json");
}

const EMPTY = { providers: [], models: [], routing: {}, modelRoutes: {}, profiles: {} };

function readAll() {
  if (!existsSync(keysPath())) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(keysPath(), "utf8"));
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      models: Array.isArray(parsed.models) ? parsed.models : [],
      routing: parsed.routing || {},
      modelRoutes: parsed.modelRoutes || {},
      profiles: parsed.profiles || {},
    };
  } catch {
    return { ...EMPTY };
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

// Which provider types each tool slot can actually serve. This mirrors the
// execution paths, it is not a policy choice:
//   claude (/v1/messages)         — Anthropic-shaped in; served natively by
//                                   anthropic-compat, by kiro through its own
//                                   converter, and by OpenAI-format providers
//                                   through the protocol bridge
//   codex  (/v1/responses)        — Kiro has its own converter; everything else is
//                                   translated into OpenAI Chat Completions, which
//                                   an anthropic-compat provider now receives
//                                   through the bridge
//   openai (/v1/chat/completions) — OpenAI Chat Completions natively or bridged;
//                                   Kiro is reached by bridging the chat body to
//                                   Anthropic Messages first, which is the shape
//                                   its own converter already consumes
//
// Before the bridge existed (lib/protocolBridge.js), an anthropic-compat provider
// on the openai or codex slot failed in the worst possible way: the gateway sent
// an OpenAI-shaped body to /messages (no max_tokens -> 400 from a real provider),
// and on the codex path the Anthropic-shaped reply had no `choices`, so the client
// got HTTP 200 with `output: []` — a silent empty answer. Every pairing listed
// here now has a real translation path; anything absent is refused outright.
const TOOL_PROVIDER_TYPES = {
  claude: ["anthropic-compat", "kiro", "openai-compat", "local-openai"],
  codex: ["kiro", "openai-compat", "local-openai", "anthropic-compat"],
  openai: ["openai-compat", "local-openai", "anthropic-compat", "kiro"],
};

export function toolSupportsProviderType(tool, type) {
  return (TOOL_PROVIDER_TYPES[tool] || []).includes(type);
}

export function supportedTypesForTool(tool) {
  return TOOL_PROVIDER_TYPES[tool] || [];
}

// A Kiro account past its credit budget must stop serving. The budget was
// decorative until 2026-08-02: creditBudget was only ever read by the dashboard
// and the account CRUD route, so a 300cr account kept spending forever. Enforced
// in kiro/client.js executeKiro, which every Kiro request goes through.
// Only Kiro has credit accounting (its stream self-reports the burn), so other
// provider types are never over budget.
export function isOverBudget(provider) {
  return Boolean(
    provider &&
      provider.type === "kiro" &&
      provider.creditBudget > 0 &&
      (provider.usedCredits || 0) >= provider.creditBudget
  );
}

export function setToolProvider(tool, providerId) {
  if (!TOOL_SLOTS.includes(tool)) return null;
  const data = readAll();
  const previous = data.routing[tool];
  if (providerId) {
    const provider = data.providers.find((p) => p.id === providerId);
    if (!provider) return null;
    if (!toolSupportsProviderType(tool, provider.type)) return null;
    data.routing[tool] = providerId;
  } else {
    delete data.routing[tool];
  }
  dropStaleForceRoute(data, tool, previous);
  writeAll(data);
  return data.routing;
}

// The dashboard sets a slot's forced model (modelRoutes[tool]["*"]) as "this
// provider, this model". Once the slot moves to another provider that pairing is
// meaningless, and leaving it would silently keep sending traffic to the old
// account while the dropdown shows the new one. A force route the user aimed at
// some OTHER provider on purpose (from the overrides panel) is left alone.
function dropStaleForceRoute(data, tool, previousProviderId) {
  if (!previousProviderId) return;
  const routes = data.modelRoutes[tool];
  const value = routes?.[WILDCARD];
  const owner = typeof value === "string" ? value : value?.providerId;
  if (owner !== previousProviderId || owner === data.routing[tool]) return;
  delete routes[WILDCARD];
  if (!Object.keys(routes).length) delete data.modelRoutes[tool];
}

// Convenience: set every slot the provider can actually serve (1-click "use
// everywhere"). Slots whose protocol the provider cannot speak are skipped
// rather than silently mis-wired — the return value says which were skipped.
export function setAllToolsProvider(providerId) {
  const data = readAll();
  const provider = data.providers.find((p) => p.id === providerId);
  if (!provider) return null;
  const skipped = [];
  for (const tool of TOOL_SLOTS) {
    if (!toolSupportsProviderType(tool, provider.type)) {
      skipped.push(tool);
      continue;
    }
    const previous = data.routing[tool];
    data.routing[tool] = providerId;
    dropStaleForceRoute(data, tool, previous);
  }
  writeAll(data);
  return { routing: data.routing, skipped };
}

// --- Per-model routes (override the tool's default provider) -----------
// modelRoutes = {
//   claude: {
//     "*":                    { providerId, model },   // force: everything else
//     "claude-sonnet-5":      { providerId, model },   // one model, own target
//     "claude-sonnet-5[1M]":  { exempt: true },        // untouched by the force
//   }, ...
// }
//
// A tool slot binds ONE provider, so every model a client asks for lands on the
// same account. That is wrong for cost: Claude Code sends its small background
// calls (topic detection and friends) under a different model id than the real
// work — measured 64 of 200 requests, 20% of the credits, each carrying the full
// ~140KB history for a 5-token answer. A per-model override sends exactly those
// to a cheap account while the real work stays where it is.
//
// The key is the id the CLIENT sends; `model` is what to forward upstream. They
// differ constantly, because no two catalogs name a model the same way
// (claude-sonnet-5 / anthropic/claude-3.5-sonnet / claude-sonnet-4-5-20250929).
// The mapping is explicit and user-chosen on purpose: guessing it from fetched
// model names would silently serve a different model than asked for, which is
// exactly what the swap detection in logStore.js exists to catch.
//
// Three special forms:
//   "*"             — the force route: applies to every model id with no exact
//                     entry, so an agent can ask for anything and still get the
//                     one model the dashboard chose.
//   { exempt: true } — opts a single model id OUT of the force route, keeping the
//                     tool's own provider and the client's id. Claude Code needs
//                     this: its subagent/auto-mode classifier calls (see
//                     CLAUDE_CODE_SUBAGENT_MODEL, e.g. "claude-sonnet-5[1M]")
//                     must keep reaching a model that can serve them, or auto
//                     mode stops working.
//   a bare string   — legacy shorthand for "same id, different provider".
//
// Exact entries always beat "*". Everything then follows the same rules as a
// bound provider (must exist, must be enabled, Kiro still gates on its list).

const WILDCARD = "*";

export function getModelRoutes(tool) {
  const all = readAll().modelRoutes;
  return tool ? all[tool] || {} : all;
}

// Normalise every stored shape to { providerId, model } | { exempt: true }.
function routeEntry(value, clientModelId) {
  if (!value) return null;
  if (typeof value === "string") return { providerId: value, model: clientModelId };
  if (value.exempt) return { exempt: true };
  if (!value.providerId) return null;
  return { providerId: value.providerId, model: value.model || clientModelId };
}

// Resolve a (tool, model) override to { provider, model } — `model` being the id
// to send upstream. Returns { exempt: true } when the model is explicitly opted
// out of the force route, and null when no override applies.
export function resolveModelRoute(tool, modelId) {
  const data = readAll();
  const byModel = data.modelRoutes?.[tool];
  if (!byModel) return null;

  // Exact entry first: it is the only way to keep one model out of a force route.
  const exact = routeEntry(byModel[modelId], modelId);
  if (exact?.exempt) return { exempt: true };
  const entry = exact || routeEntry(byModel[WILDCARD], modelId);
  if (!entry) return null;

  const provider = data.providers.find((p) => p.id === entry.providerId);
  if (!provider || provider.enabled === false) return null;
  return { provider, model: entry.model };
}

// Write one entry. `route` shapes:
//   { providerId, model? }  — route (and optionally rename) this model id
//   { exempt: true }        — keep this model id on the tool's own provider
//   null / undefined        — clear the entry
// modelId may be "*" to set the force route for every other model.
export function setModelRoute(tool, modelId, route) {
  if (!TOOL_SLOTS.includes(tool) || !modelId) return null;
  const data = readAll();

  if (route?.exempt) {
    data.modelRoutes[tool] = { ...(data.modelRoutes[tool] || {}), [modelId]: { exempt: true } };
  } else if (route?.providerId) {
    const provider = data.providers.find((p) => p.id === route.providerId);
    if (!provider) return null;
    // Same protocol rule as the tool slots: a provider that cannot speak this
    // slot's wire format must not become reachable through an override either.
    if (!toolSupportsProviderType(tool, provider.type)) return null;
    const value = { providerId: route.providerId, model: route.model || modelId };
    // A force route has no client id to fall back on, so it must name its target.
    if (modelId === WILDCARD && !route.model) return null;
    data.modelRoutes[tool] = { ...(data.modelRoutes[tool] || {}), [modelId]: value };
  } else {
    if (data.modelRoutes[tool]) delete data.modelRoutes[tool][modelId];
    if (data.modelRoutes[tool] && !Object.keys(data.modelRoutes[tool]).length) {
      delete data.modelRoutes[tool];
    }
  }
  writeAll(data);
  return data.modelRoutes;
}

// --- Session profiles (per-session provider + model) -------------------
// profiles = { backend: { providerId: "provider-x", model: "claude-opus-4.5" } }
//
// WHY. Everything above is keyed by tool slot and model id, both of which are
// GLOBAL: bind the claude slot to an account, or set its force route, and every
// Claude Code session on the machine follows it. That makes parallel work
// impossible — backend on Opus while the frontend session runs Kimi and a third
// writes docs on Sonnet is exactly what could not be expressed.
//
// A profile is that same "force route" pairing, scoped to a session instead of to
// the whole gateway. The session picks it by BASE URL, because base URL is the one
// setting every client already has:
//
//   ANTHROPIC_BASE_URL=http://localhost:9000/p/backend      (Claude Code)
//   base_url = "http://localhost:9000/p/docs/v1"            (Codex)
//
// Verified against Claude Code 2.1.220: it appends its own path, so the gateway
// receives POST /p/backend/v1/messages?beta=true.
//
// Selecting by URL rather than by model id is deliberate — it covers ALL traffic
// from that process, including the background calls (topic detection, the subagent
// and auto-mode classifier ids) that a model-id-keyed rule cannot follow.
//
// A profile is flat, not per-tool: one session is one client, so one pairing is
// all it can use. `model` is optional — omit it to pin only the account and let
// the client's own model id through.

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function getProfiles() {
  return readAll().profiles;
}

export function getProfile(name) {
  if (!name || !PROFILE_NAME.test(name)) return null;
  return readAll().profiles[name] || null;
}

// Resolve a profile to { provider, model } — `model` being what to send upstream,
// or null to forward the client's own id. Returns null when the profile does not
// exist or its provider is gone/disabled; app.js refuses the request in that case
// rather than letting it fall through to the global routing, because silently
// serving a session from the wrong account is a billing mistake.
export function resolveProfile(name) {
  const profile = getProfile(name);
  if (!profile?.providerId) return null;
  const provider = readAll().providers.find((p) => p.id === profile.providerId);
  if (!provider || provider.enabled === false) return null;
  return { provider, model: profile.model || null };
}

// setProfile(name, { providerId, model? }) writes; setProfile(name, null) deletes.
export function setProfile(name, profile) {
  if (!PROFILE_NAME.test(String(name || ""))) return null;
  const data = readAll();
  if (!profile) {
    delete data.profiles[name];
  } else {
    if (!data.providers.some((p) => p.id === profile.providerId)) return null;
    data.profiles[name] = {
      providerId: profile.providerId,
      ...(profile.model ? { model: profile.model } : {}),
    };
  }
  writeAll(data);
  return data.profiles;
}

// --- Which models a CALLER can actually reach ------------------------------
// getEnabledModels() above answers "every model any slot can reach", which is the
// right answer for the dashboard and the wrong one for a client: /v1/models is
// shared by all three protocol routes, so a Claude Code client was being told
// about the models of whatever provider the codex/openai slots happened to use.
// Measured on Amit's config: 12 ids advertised, 11 of them owned only by the
// codex/openai slot's provider and unreachable on /v1/messages.
//
// Narrowing is deliberately NOT applied when a force route is active, and that is
// not laziness: with a force route every id the client sends is rewritten to the
// forced model, so every id genuinely IS accepted and a shorter list would be the
// less truthful one. It would also be risky — Claude Code checks its configured
// model against this endpoint, so dropping the id it is about to send can make it
// refuse before a request is ever made.
//
// Where it does narrow, it matters: with "(client decides)" the client's own id is
// what goes upstream, so an id the slot provider does not serve is a 403/404 from
// the provider. That is exactly when an honest list stops a broken choice.
export function reachableModels({ tool, profile } = {}) {
  // A session profile is the most specific answer there is: one provider, and one
  // model when it pins one.
  if (profile) {
    const resolved = resolveProfile(profile);
    if (!resolved) return [];
    return resolved.model ? [resolved.model] : getProviderModels(resolved.provider.id);
  }

  // An unrecognised client gets the old union — better a superset than a wrong
  // guess about which route it meant to use.
  if (!TOOL_SLOTS.includes(tool)) return getEnabledModels();

  const data = readAll();
  const routes = data.modelRoutes?.[tool] || {};
  if (routes[WILDCARD]) return getEnabledModels(); // force route: everything is accepted

  const ids = new Set();
  const slot = getToolProvider(tool);
  if (slot && slot.enabled !== false) for (const id of getProviderModels(slot.id)) ids.add(id);
  // A per-model override makes the client's id reachable even when the slot
  // provider knows nothing about it.
  for (const id of Object.keys(routes)) ids.add(id);
  return [...ids];
}

// --- Auto-fallback (default OFF) ---------------------------------------
// When the user opts in (routing.fallbackEnabled === true), a retriable
// upstream error on a tool's bound provider retries the same request on
// another enabled provider allowed on that slot — across protocols, since the
// bridge translates and the route consumes the winner's adapter. Kiro is the
// exception: executeKiro is its own execution path, so a Kiro primary only
// falls back onto Kiro. Default off: the user keeps clarity on which account is
// spending. Toggle via the dashboard or POST /admin/routing/fallback.

export function isFallbackEnabled() {
  return readAll().routing.fallbackEnabled === true;
}

export function setFallbackEnabled(enabled) {
  const data = readAll();
  if (enabled) data.routing.fallbackEnabled = true;
  else delete data.routing.fallbackEnabled;
  writeAll(data);
  return data.routing;
}

// Enabled providers to try after `primary` fails, in creation order. Kiro is its
// own island — executeKiro is a different execution path, and a Kiro account is
// only ever a fallback for another Kiro account. Every other provider is fair
// game for any slot it is allowed on, because the protocol bridge
// (lib/protocolBridge.js) translates whichever direction is needed; the route
// consumes the winner's adapter, so a fallback that speaks the other protocol is
// handled correctly rather than mis-parsed.
export function fallbackProviders(tool, primary) {
  if (!primary) return [];
  const types =
    primary.type === "kiro"
      ? new Set(["kiro"])
      : new Set(supportedTypesForTool(tool).filter((type) => type !== "kiro"));
  return readAll().providers.filter(
    (p) => p.id !== primary.id && p.enabled !== false && types.has(p.type)
  );
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
    // …and from any per-model override, otherwise the model would resolve to a
    // provider that no longer exists.
    const routes = data.modelRoutes[tool];
    if (routes) {
      for (const [modelId, value] of Object.entries(routes)) {
        const providerId = typeof value === "string" ? value : value?.providerId;
        if (providerId === id) delete routes[modelId];
      }
      if (!Object.keys(routes).length) delete data.modelRoutes[tool];
    }
  }
  data.providers = data.providers.filter((p) => p.id !== id);
  data.models = data.models.filter((m) => m.providerId !== id);
  // Same reason as the overrides above: a session profile naming a deleted
  // provider would refuse every request from that session with no clue why.
  for (const [name, profile] of Object.entries(data.profiles)) {
    if (profile?.providerId === id) delete data.profiles[name];
  }
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

// ponytail: lookupProviderForTool deleted — it had no callers left. It was part of
// the old "does this provider sell this model" gate that, together with a
// client-driven model choice, leaked a /model switch onto whichever provider
// happened to sell that id. Resolution now runs only through lookupModelForTool
// (exempt -> session profile -> modelRoutes -> the tool's own slot), and every
// provider lookup in this file is by ID. Leaving dead copies of the old rule
// around is how it comes back.

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
  // Providers reachable only through a per-model override serve real traffic too.
  for (const routes of Object.values(data.modelRoutes || {})) {
    for (const value of Object.values(routes)) {
      const providerId = typeof value === "string" ? value : value?.providerId;
      if (providerId) activeProviderIds.add(providerId);
    }
  }
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
    modelRoutes: newData.modelRoutes || {},
    profiles: newData.profiles || {},
  });
}
