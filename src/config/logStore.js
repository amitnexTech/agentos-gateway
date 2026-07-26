// Request log (last N requests), persisted to data/logs.json so it survives restarts.
// For debugging/visibility, not analytics.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { updateProvider, getProvider } from "./keysStore.js";
import { dataDir } from "./envStore.js";

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

export function logRequest({ tool, model, providerId, providerName, latencyMs, status, error, responseModel, usage, kiroCredits }) {
  // Approximate cost calculation (per million tokens)
  // Claude Sonnet: $3/M input, $15/M output, cache read 90% off
  // Claude Opus: $15/M input, $75/M output
  // Others: estimate $2/M input, $10/M output
  let cost = null;
  if (usage) {
    const isOpus = (model || "").includes("opus");
    const inputRate = isOpus ? 15 : 3; // $/M tokens
    const outputRate = isOpus ? 75 : 15;
    const cacheRate = inputRate * 0.1; // 90% discount
    cost = (
      (usage.input_tokens || 0) * inputRate / 1_000_000 +
      (usage.output_tokens || 0) * outputRate / 1_000_000 +
      (usage.cache_read || 0) * cacheRate / 1_000_000 +
      (usage.cache_write || 0) * inputRate * 1.25 / 1_000_000
    );
    cost = Math.round(cost * 10000) / 10000; // 4 decimal places
  }

  // Accumulate Kiro credits on provider (persistent tracking)
  if (kiroCredits && providerId && creditAccumulator) {
    creditAccumulator(providerId, kiroCredits);
  }

  const entry = {
    ts: new Date().toISOString(),
    tool,
    model,
    providerId,
    providerName,
    latencyMs: Math.round(latencyMs),
    status,
    error: error || null,
    responseModel: responseModel || null,
    modelMismatch: responseModel && responseModel !== model ? true : false,
    usage: usage || null,
    cost,
    kiroCredits: kiroCredits != null ? Math.round(kiroCredits * 1000000) / 1000000 : null,
  };
  logs.unshift(entry);
  if (logs.length > MAX_ENTRIES) logs.length = MAX_ENTRIES;
  persist();
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
