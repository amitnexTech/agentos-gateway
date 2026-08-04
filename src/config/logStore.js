// Request log (last N requests), persisted to data/logs.json so it survives restarts.
// For debugging/visibility, not analytics.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { updateProvider, getProvider } from "./keysStore.js";
import { dataDir } from "./envStore.js";
import { appendSpend } from "./spendStore.js";
import { requestContext } from "../lib/requestContext.js";

const MAX_ENTRIES = 200;

function logsPath() {
  return join(dataDir(), "logs.json");
}

function load() {
  try {
    const parsed = JSON.parse(readFileSync(logsPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

const logs = existsSync(logsPath()) ? load() : [];

// ponytail: rewrite the whole file per request — 200 entries is ~80KB, fine at
// personal-gateway volume. Switch to append-only JSONL if it ever gets hot.
function persist() {
  try {
    mkdirSync(dataDir(), { recursive: true });
    const tmp = `${logsPath()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(logs)}\n`, { mode: 0o600 });
    renameSync(tmp, logsPath());
  } catch {
    // Non-fatal: logging must never break a proxied request.
  }
}

// Accumulate credits on provider's usedCredits field (persistent)
function creditAccumulator(providerId, credits) {
  try {
    const p = getProvider(providerId);
    if (p && p.type === "kiro") {
      const current = p.usedCredits || 0;
      updateProvider(providerId, { usedCredits: Math.round((current + credits) * 1000000) / 1000000 });
    }
  } catch {
    // Non-fatal
  }
}

// Normalise a model id so cosmetic differences don't look like a swap.
// "claude-opus-4.8" / "claude-opus-4-8" / "claude-opus-4-8-20250514" all collapse
// to the same key. Anything left over is a genuine difference.
function normalizeModel(m) {
  return String(m || "")
    .toLowerCase()
    .replace(/-\d{8}$/, "")
    .replace(/[._]/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// Approximate per-million-token rates, matched against the model id. Only rates
// that are actually KNOWN are listed. Everything else gets `cost: null` and the log
// shows "—", because the old behaviour — pricing every unrecognised model at Claude
// Sonnet rates — put a confident dollar figure on a Groq or Kimi request that had
// nothing to do with Anthropic's price list. Haiku was priced as Sonnet too, 3x its
// real rate. Anthropic list prices as of 2026-08; a cache read is 10% of input and
// a cache write 125%.
const MODEL_RATES = [
  [/opus/i, { input: 15, output: 75 }],
  [/sonnet/i, { input: 3, output: 15 }],
  [/haiku/i, { input: 1, output: 5 }],
];

function ratesFor(model) {
  const id = String(model || "");
  for (const [pattern, rates] of MODEL_RATES) if (pattern.test(id)) return rates;
  return null;
}

export function logRequest({ tool, rawModel, model, providerId, providerName, latencyMs, status, error, responseModel, responseId, usage, kiroCredits, fallback, contextUsagePercent, historyEntries, payloadChars }) {
  // Kiro reports no token counts at all, so every token number on that path is a
  // ~4-chars-per-token estimate (see kiro/tokens.js). Flagged here so the log can
  // say so instead of presenting an estimate as a measurement.
  let usageEstimated = false;
  try {
    usageEstimated = Boolean(usage) && getProvider(providerId)?.type === "kiro";
  } catch {
    // Non-fatal: logging must never break a proxied request.
  }

  // Approximate cost. On the Kiro path this is an ANALOGY, not a bill: Kiro charges
  // credits, and `kiroCredits` is the real figure. The $ number is still worth
  // showing there because it prices the input side at Anthropic list rates, which is
  // what makes the full-history-per-turn cost legible. Read the credits column for
  // actual spend.
  let cost = null;
  const rates = usage ? ratesFor(model) : null;
  if (rates) {
    cost = (
      (usage.input_tokens || 0) * rates.input / 1_000_000 +
      (usage.output_tokens || 0) * rates.output / 1_000_000 +
      (usage.cache_read || 0) * rates.input * 0.1 / 1_000_000 +
      (usage.cache_write || 0) * rates.input * 1.25 / 1_000_000
    );
    cost = Math.round(cost * 10000) / 10000; // 4 decimal places
  }

  // Accumulate Kiro credits on provider (persistent tracking)
  if (kiroCredits && providerId && creditAccumulator) {
    creditAccumulator(providerId, kiroCredits);
  }

  // Output tokens per second. This is the signal that actually catches a silent
  // swap: a proxy that answers "opus" with haiku still echoes the opus name, but
  // it cannot fake the generation speed. Haiku runs several times faster.
  let tps = null;
  if (usage && usage.output_tokens > 0 && latencyMs > 0) {
    tps = Math.round((usage.output_tokens / (latencyMs / 1000)) * 10) / 10;
  }

  const entry = {
    ts: new Date().toISOString(),
    tool,
    profile: requestContext().profile || null,
    rawModel: rawModel && rawModel !== model ? rawModel : null,
    model,
    providerId,
    providerName,
    latencyMs: Math.round(latencyMs),
    tps,
    status,
    error: error || null,
    responseModel: responseModel || null,
    responseId: responseId || null,
    modelMismatch: Boolean(responseModel) && normalizeModel(responseModel) !== normalizeModel(model),
    usage: usage || null,
    usageEstimated,
    cost,
    kiroCredits: kiroCredits != null ? Math.round(kiroCredits * 1000000) / 1000000 : null,
    // Kiro-only context signals. contextUsagePercent is Kiro's own number — the
    // exact answer to "how full is the context window". historyEntries/payloadChars
    // are ours, measured from the payload we sent, and work even when Kiro omits
    // the percentage. Input growth across a conversation is the main cost driver
    // on Kiro, so these are what make the burn visible.
    contextUsagePercent: contextUsagePercent != null ? Math.round(contextUsagePercent * 10) / 10 : null,
    historyEntries: historyEntries != null ? historyEntries : null,
    payloadChars: payloadChars != null ? payloadChars : null,
    fallback: Boolean(fallback),
  };
  logs.unshift(entry);
  if (logs.length > MAX_ENTRIES) logs.length = MAX_ENTRIES;
  persist();

  // The permanent record. This log only keeps the last 200 requests, which is a few
  // hours of real use — every token measured before this existed was thrown away
  // within the day. spendStore appends one line per request instead, so monthly
  // totals per project / provider / model are answerable. Both estimated tokens and
  // an unknown cost are carried through so a report can say what it does not know.
  const ctx = requestContext();
  appendSpend({
    ts: entry.ts,
    tool,
    profile: entry.profile,
    project: ctx.project || null,
    client: ctx.client || null,
    provider: providerName || null,
    providerId: providerId || null,
    model: model || null,
    status,
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
    cacheReadTokens: usage?.cache_read || 0,
    cacheWriteTokens: usage?.cache_write || 0,
    cost,
    credits: entry.kiroCredits,
    estimated: usageEstimated,
  });

  return entry;
}

export function getLogs({ limit = 50, tool } = {}) {
  let result = logs;
  if (tool) result = result.filter((l) => l.tool === tool);
  return result.slice(0, limit);
}

export function clearLogs() {
  logs.length = 0;
  persist();
}
