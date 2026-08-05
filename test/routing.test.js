// Routing resolution: tool slots, per-model overrides, the "*" force route and
// the fallback pool. This is the logic that decides which ACCOUNT pays for a
// request, so a silent mistake here is a billing mistake — and its rules
// (exact beats "*", exempt means "slot's own provider", a force route dies with
// the provider it named) are subtle enough to be worth pinning down.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "agentos-routing-test-"));
process.env.AGENTOS_DATA_DIR = dataDir; // read per call by envStore.dataDir()

const {
  TOOL_SLOTS,
  toolSupportsProviderType,
  supportedTypesForTool,
  setToolProvider,
  setAllToolsProvider,
  getToolProvider,
  setModelRoute,
  resolveModelRoute,
  setProfile,
  getProfiles,
  resolveProfile,
  setProviderModels,
  deleteProvider,
  fallbackProviders,
  isOverBudget,
  getRouting,
} = await import("../src/config/keysStore.js");
const { runWithContext } = await import("../src/lib/requestContext.js");

const PROVIDERS = [
  { id: "p-anth", name: "Anth", type: "anthropic-compat", baseUrl: "https://a.example/v1", enabled: true },
  { id: "p-oai", name: "OAI", type: "openai-compat", baseUrl: "https://o.example/v1", enabled: true },
  { id: "p-local", name: "Local", type: "local-openai", baseUrl: "http://localhost:11434/v1", enabled: true },
  { id: "p-kiro", name: "Kiro A", type: "kiro", region: "us-east-1", enabled: true, usedCredits: 0 },
  { id: "p-kiro2", name: "Kiro B", type: "kiro", region: "us-east-1", enabled: true, usedCredits: 0 },
  { id: "p-off", name: "Disabled", type: "anthropic-compat", baseUrl: "https://d.example/v1", enabled: false },
];

function seed({ routing = {}, modelRoutes = {}, profiles = {} } = {}) {
  writeFileSync(
    join(dataDir, "keys.json"),
    JSON.stringify({ providers: PROVIDERS, models: [], routing, modelRoutes, profiles }, null, 2),
    { mode: 0o600 }
  );
}

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test("every provider type can serve every slot, and unknown types are still refused", () => {
  seed();
  // True since the protocol bridge landed: the table is now a regression net
  // (a future provider type stays unroutable until wired) rather than a live
  // restriction. It is still what fallbackProviders() reads.
  for (const tool of TOOL_SLOTS) {
    for (const type of ["anthropic-compat", "openai-compat", "local-openai", "kiro"]) {
      assert.equal(toolSupportsProviderType(tool, type), true, `${type} on ${tool}`);
    }
    assert.equal(toolSupportsProviderType(tool, "gemini-native"), false, "an unwired type must not route");
    assert.ok(supportedTypesForTool(tool).length >= 4);
  }
  assert.equal(toolSupportsProviderType("nonexistent-slot", "kiro"), false);
});

test("setToolProvider binds and clears a slot", () => {
  seed();
  assert.deepEqual(setToolProvider("claude", "p-oai"), { claude: "p-oai" });
  assert.equal(getToolProvider("claude").id, "p-oai");
  assert.equal(setToolProvider("claude", null).claude, undefined);
  assert.equal(getToolProvider("claude"), null);
  assert.equal(setToolProvider("not-a-slot", "p-oai"), null);
  assert.equal(setToolProvider("claude", "no-such-provider"), null);
});

test("a disabled provider is never used by the request path", async () => {
  seed({ routing: { claude: "p-off" } });
  // getToolProvider is a raw accessor and returns the record as stored; the
  // enabled check belongs to the resolver the routes actually call.
  assert.equal(getToolProvider("claude").id, "p-off");
  const { lookupModelForTool } = await import("../src/kiro/client.js");
  assert.deepEqual(lookupModelForTool("claude", "some-model"), { provider: null, model: "some-model" });
});

test("setAllToolsProvider fills every slot it can serve", () => {
  seed();
  const { routing, skipped } = setAllToolsProvider("p-kiro");
  assert.deepEqual(skipped, [], "Kiro now serves all three slots");
  assert.deepEqual(routing, { claude: "p-kiro", codex: "p-kiro", openai: "p-kiro" });
});

test("an exact per-model route beats the force route", () => {
  seed({
    routing: { claude: "p-anth" },
    modelRoutes: {
      claude: {
        "*": { providerId: "p-kiro", model: "claude-sonnet-4.5" },
        "claude-sonnet-5": { providerId: "p-oai", model: "gpt-5.6" },
      },
    },
  });

  const exact = resolveModelRoute("claude", "claude-sonnet-5");
  assert.equal(exact.provider.id, "p-oai");
  assert.equal(exact.model, "gpt-5.6", "an override may rename the model on the way upstream");

  const forced = resolveModelRoute("claude", "claude-opus-5");
  assert.equal(forced.provider.id, "p-kiro");
  assert.equal(forced.model, "claude-sonnet-4.5", "everything without an exact entry goes to the force target");
});

test("exempt opts one model id out of the force route", () => {
  seed({
    routing: { claude: "p-anth" },
    modelRoutes: {
      claude: {
        "*": { providerId: "p-kiro", model: "claude-sonnet-4.5" },
        "claude-sonnet-5[1M]": { exempt: true },
      },
    },
  });
  assert.deepEqual(resolveModelRoute("claude", "claude-sonnet-5[1M]"), { exempt: true });
  assert.equal(resolveModelRoute("claude", "anything-else").provider.id, "p-kiro");
});

test("the legacy string shorthand means same id, different provider", () => {
  seed({ modelRoutes: { openai: { "gpt-5.6": "p-local" } } });
  const route = resolveModelRoute("openai", "gpt-5.6");
  assert.equal(route.provider.id, "p-local");
  assert.equal(route.model, "gpt-5.6");
});

test("a route pointing at a disabled or deleted provider resolves to nothing", () => {
  seed({ modelRoutes: { claude: { "m": { providerId: "p-off", model: "m" } } } });
  assert.equal(resolveModelRoute("claude", "m"), null, "so the slot's own provider serves instead");
  seed({ modelRoutes: { claude: { "m": { providerId: "p-gone", model: "m" } } } });
  assert.equal(resolveModelRoute("claude", "m"), null);
  seed();
  assert.equal(resolveModelRoute("claude", "m"), null);
});

test("a force route must name its target model", () => {
  seed({ routing: { claude: "p-anth" } });
  assert.equal(setModelRoute("claude", "*", { providerId: "p-kiro" }), null, "there is no client id to fall back on");
  assert.ok(setModelRoute("claude", "*", { providerId: "p-kiro", model: "claude-sonnet-4.5" }));
  assert.equal(resolveModelRoute("claude", "whatever").model, "claude-sonnet-4.5");
});

test("changing a slot's provider drops a force route that belonged to the old one", () => {
  seed({ routing: { claude: "p-kiro" }, modelRoutes: { claude: { "*": { providerId: "p-kiro", model: "claude-sonnet-4.5" } } } });
  setToolProvider("claude", "p-anth");
  assert.equal(
    resolveModelRoute("claude", "anything"),
    null,
    "otherwise the dropdown names one account while traffic keeps going to another"
  );
});

test("a force route deliberately aimed at another provider survives a slot change", () => {
  seed({ routing: { claude: "p-anth" }, modelRoutes: { claude: { "*": { providerId: "p-kiro", model: "claude-sonnet-4.5" } } } });
  setToolProvider("claude", "p-oai");
  assert.equal(resolveModelRoute("claude", "anything").provider.id, "p-kiro", "it never named the old slot provider");
});

test("clearing the last route removes the tool's route map", () => {
  seed({ modelRoutes: { claude: { "m": { providerId: "p-anth", model: "m" } } } });
  const routes = setModelRoute("claude", "m", null);
  assert.equal(routes.claude, undefined);
});

test("the fallback pool crosses protocols but never mixes Kiro with the rest", () => {
  seed();
  const forAnth = fallbackProviders("openai", PROVIDERS[0]);
  assert.deepEqual(forAnth.map((p) => p.id), ["p-oai", "p-local"], "no Kiro, no disabled provider, no self");

  const forKiro = fallbackProviders("claude", PROVIDERS[3]);
  assert.deepEqual(forKiro.map((p) => p.id), ["p-kiro2"], "executeKiro is its own execution path");

  assert.deepEqual(fallbackProviders("claude", null), []);
});

test("isOverBudget only fires for a Kiro account that has actually reached its budget", () => {
  assert.equal(isOverBudget({ type: "kiro", creditBudget: 100, usedCredits: 100 }), true);
  assert.equal(isOverBudget({ type: "kiro", creditBudget: 100, usedCredits: 100.5 }), true);
  assert.equal(isOverBudget({ type: "kiro", creditBudget: 100, usedCredits: 99.9 }), false);
  assert.equal(isOverBudget({ type: "kiro", usedCredits: 5000 }), false, "no budget means no limit");
  assert.equal(isOverBudget({ type: "kiro", creditBudget: 0, usedCredits: 5 }), false, "0 clears the budget");
  assert.equal(isOverBudget({ type: "kiro" }), false);
  assert.equal(isOverBudget({ type: "anthropic-compat", creditBudget: 1, usedCredits: 99 }), false, "only Kiro reports credits");
  assert.equal(isOverBudget(null), false);
});

test("routing survives a round trip through keys.json", () => {
  seed();
  setToolProvider("codex", "p-kiro");
  assert.equal(getRouting().codex, "p-kiro");
});


// --- Session profiles ---------------------------------------------------
// The reason these exist: the rules above are global, so every session on the
// machine shared one model. A profile is per-session (chosen by the /p/<name>/v1
// base URL), which is what makes parallel sessions on different models possible.

test("a session profile pins provider and model, beating the force route", async () => {
  seed({
    routing: { claude: "p-anth" },
    modelRoutes: { claude: { "*": { providerId: "p-anth", model: "globally-forced" } } },
    profiles: { backend: { providerId: "p-oai", model: "gpt-5.6" } },
  });
  const { lookupModelForTool } = await import("../src/kiro/client.js");

  const inSession = runWithContext({ profile: "backend" }, () => lookupModelForTool("claude", "claude-opus-5"));
  assert.equal(inSession.provider.id, "p-oai");
  assert.equal(inSession.model, "gpt-5.6");

  // Another session, same gateway, same instant: still the global force route.
  const noSession = runWithContext({ profile: null }, () => lookupModelForTool("claude", "claude-opus-5"));
  assert.equal(noSession.provider.id, "p-anth");
  assert.equal(noSession.model, "globally-forced");
});

test("a profile with no model pinned forwards the client's own id", async () => {
  seed({ routing: { claude: "p-anth" }, profiles: { loose: { providerId: "p-oai" } } });
  const { lookupModelForTool } = await import("../src/kiro/client.js");
  const r = runWithContext({ profile: "loose" }, () => lookupModelForTool("claude", "whatever-5"));
  assert.equal(r.provider.id, "p-oai");
  assert.equal(r.model, "whatever-5", "pin the account only");
});

test("an exempt model id stays on the slot even inside a profile", async () => {
  // Claude Code's auto-mode classifier ids must keep reaching a provider that
  // serves them; a profile forcing them onto one pinned model breaks auto mode.
  seed({
    routing: { claude: "p-anth" },
    modelRoutes: { claude: { "claude-sonnet-5[1M]": { exempt: true } } },
    profiles: { backend: { providerId: "p-oai", model: "gpt-5.6" } },
  });
  const { lookupModelForTool } = await import("../src/kiro/client.js");
  const r = runWithContext({ profile: "backend" }, () => lookupModelForTool("claude", "claude-sonnet-5[1M]"));
  assert.equal(r.provider.id, "p-anth");
  assert.equal(r.model, "claude-sonnet-5[1M]");
});

test("a profile resolves to nothing when it is unknown, misnamed, or its provider is unusable", () => {
  seed({ profiles: { dead: { providerId: "p-off" }, gone: { providerId: "p-gone" }, ok: { providerId: "p-anth" } } });
  assert.equal(resolveProfile("nope"), null);
  assert.equal(resolveProfile("dead"), null, "disabled provider");
  assert.equal(resolveProfile("gone"), null, "deleted provider");
  assert.equal(resolveProfile("../etc"), null, "the name is a URL segment, so it is validated");
  assert.equal(resolveProfile(null), null);
  assert.equal(resolveProfile("ok").provider.id, "p-anth");
});

test("setProfile validates the name and the provider", () => {
  seed();
  assert.equal(setProfile("Backend", { providerId: "p-anth" }), null, "uppercase is not a URL-safe segment here");
  assert.equal(setProfile("a/b", { providerId: "p-anth" }), null);
  assert.equal(setProfile("x".repeat(33), { providerId: "p-anth" }), null);
  assert.equal(setProfile("ok", { providerId: "p-nope" }), null, "unknown provider");
  assert.deepEqual(setProfile("docs", { providerId: "p-anth", model: "claude-sonnet-5" }), {
    docs: { providerId: "p-anth", model: "claude-sonnet-5" },
  });
  assert.deepEqual(setProfile("docs", null), {}, "clearing removes it");
});

test("deleting a provider takes its profiles with it", () => {
  seed({ profiles: { backend: { providerId: "p-oai", model: "gpt-5.6" }, docs: { providerId: "p-anth" } } });
  deleteProvider("p-oai");
  assert.deepEqual(Object.keys(getProfiles()), ["docs"], "a profile naming a dead provider refuses every request");
});


// --- the old cross-provider leak ---------------------------------------
// Resolution used to fall back to "whichever provider sells this model id", so a
// /model switch in the client silently moved the request (and the bill) to another
// account. It is fixed, and this is what keeps it fixed: a model id that only some
// OTHER provider sells must still be served by the tool's own slot.

test("an id the slot provider does not sell is NOT rerouted to the provider that does", async () => {
  seed({ routing: { claude: "p-anth" } });
  // p-oai is the only provider with any model configured, and it sells "gpt-5.6".
  setProviderModels("p-oai", ["gpt-5.6"]);
  const { lookupModelForTool } = await import("../src/kiro/client.js");

  const r = lookupModelForTool("claude", "gpt-5.6");
  assert.equal(r.provider.id, "p-anth", "the slot decides, never the model's owner");
  assert.equal(r.model, "gpt-5.6", "and the id is forwarded untouched");

  // Same rule when nobody sells it at all.
  assert.equal(lookupModelForTool("claude", "no-such-model").provider.id, "p-anth");
});

test("with no provider bound, an id another provider sells still resolves to nothing", async () => {
  seed({ routing: {} });
  setProviderModels("p-oai", ["gpt-5.6"]);
  const { lookupModelForTool } = await import("../src/kiro/client.js");
  assert.deepEqual(lookupModelForTool("claude", "gpt-5.6"), { provider: null, model: "gpt-5.6" });
});
