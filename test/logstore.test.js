// Cost estimation, the estimate flag, and swap detection. The $ column used to
// price EVERY unrecognised model at Claude Sonnet rates, which put a confident
// dollar figure on requests that had nothing to do with Anthropic's price list —
// and priced Haiku at 3x its real rate. A blank is honest; a wrong number is not.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "agentos-logstore-test-"));
process.env.AGENTOS_DATA_DIR = dataDir;

writeFileSync(
  join(dataDir, "keys.json"),
  JSON.stringify({
    providers: [
      { id: "p-kiro", name: "Kiro A", type: "kiro", region: "us-east-1", enabled: true, usedCredits: 0 },
      { id: "p-anth", name: "Anth", type: "anthropic-compat", baseUrl: "https://a.example/v1", enabled: true },
    ],
    models: [],
    routing: {},
    modelRoutes: {},
  }),
  { mode: 0o600 }
);

const { logRequest, clearLogs } = await import("../src/config/logStore.js");
const { getProvider } = await import("../src/config/keysStore.js");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const base = {
  tool: "claude",
  providerId: "p-anth",
  providerName: "Anth",
  latencyMs: 1000,
  status: "ok",
};

test("known Claude families are priced at their own rate, not all at Sonnet's", () => {
  clearLogs();
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.equal(logRequest({ ...base, model: "claude-opus-4.6", usage }).cost, 90); // 15 + 75
  assert.equal(logRequest({ ...base, model: "claude-sonnet-4.5", usage }).cost, 18); // 3 + 15
  assert.equal(logRequest({ ...base, model: "claude-haiku-4.5", usage }).cost, 6); // 1 + 5, was 18
});

test("an unknown model gets no cost at all rather than a Claude price", () => {
  clearLogs();
  for (const model of ["moonshotai/kimi-k3-free", "gpt-5.6", "llama-3.3-70b", "glm-5.2"]) {
    const entry = logRequest({ ...base, model, usage: { input_tokens: 1000, output_tokens: 1000 } });
    assert.equal(entry.cost, null, `${model} must not be priced from Anthropic's list`);
  }
});

test("cache reads and writes are priced at their own multiples", () => {
  clearLogs();
  const entry = logRequest({
    ...base,
    model: "claude-sonnet-4.5",
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 1_000_000, cache_write: 1_000_000 },
  });
  assert.equal(entry.cost, 0.3 + 3.75, "cache read is 10% of input, cache write 125%");
});

test("no usage means no cost", () => {
  clearLogs();
  const entry = logRequest({ ...base, model: "claude-sonnet-4.5", status: "error", error: "boom" });
  assert.equal(entry.cost, null);
  assert.equal(entry.usage, null);
  assert.equal(entry.usageEstimated, false);
});

test("Kiro rows are flagged as estimated, other providers are not", () => {
  clearLogs();
  const usage = { input_tokens: 100, output_tokens: 40 };
  // Kiro reports no token counts at all, so its numbers are the gateway's own estimate.
  const kiro = logRequest({ ...base, tool: "codex", providerId: "p-kiro", providerName: "Kiro A", model: "claude-sonnet-4.5", usage, kiroCredits: 0.01 });
  assert.equal(kiro.usageEstimated, true);
  const real = logRequest({ ...base, model: "claude-sonnet-4.5", usage });
  assert.equal(real.usageEstimated, false, "an upstream-reported count is not an estimate");
});

test("tok/s is derived from output tokens and latency, and skipped when either is missing", () => {
  clearLogs();
  assert.equal(logRequest({ ...base, model: "m", usage: { input_tokens: 1, output_tokens: 50 }, latencyMs: 2000 }).tps, 25);
  assert.equal(logRequest({ ...base, model: "m", usage: { input_tokens: 1, output_tokens: 0 }, latencyMs: 2000 }).tps, null);
  assert.equal(logRequest({ ...base, model: "m", usage: { input_tokens: 1, output_tokens: 50 }, latencyMs: 0 }).tps, null);
});

test("a model swap is flagged, cosmetic id differences are not", () => {
  clearLogs();
  // The bait-and-switch check: a reseller answering opus with haiku.
  assert.equal(logRequest({ ...base, model: "claude-opus-4.8", responseModel: "claude-haiku-4.5" }).modelMismatch, true);
  assert.equal(logRequest({ ...base, model: "claude-opus-4.8", responseModel: "claude-opus-4-8" }).modelMismatch, false);
  assert.equal(logRequest({ ...base, model: "claude-opus-4-8", responseModel: "claude-opus-4-8-20250514" }).modelMismatch, false);
  assert.equal(logRequest({ ...base, model: "claude-opus-4.8" }).modelMismatch, false, "no response model = nothing to compare");
});

test("Kiro credits accumulate onto the account, which is what the budget check reads", () => {
  clearLogs();
  // A delta, not an absolute: earlier tests in this file already logged credits, and
  // the accumulator writes through to the provider record on purpose.
  const before = getProvider("p-kiro").usedCredits || 0;
  logRequest({ ...base, providerId: "p-kiro", providerName: "Kiro A", model: "claude-sonnet-4.5", kiroCredits: 0.25 });
  logRequest({ ...base, providerId: "p-kiro", providerName: "Kiro A", model: "claude-sonnet-4.5", kiroCredits: 0.5 });
  assert.equal(Math.round((getProvider("p-kiro").usedCredits - before) * 1e6) / 1e6, 0.75);
  // Non-Kiro providers have no credit accounting, so nothing is written for them.
  assert.equal(getProvider("p-anth").usedCredits, undefined);
});
