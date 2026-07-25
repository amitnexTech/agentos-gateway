// In-memory request log (last N requests). Not persisted — resets on restart.
// For debugging/visibility, not analytics.

const MAX_ENTRIES = 200;
const logs = [];

export function logRequest({ tool, model, providerId, providerName, latencyMs, status, error, responseModel, usage }) {
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
  };
  logs.unshift(entry);
  if (logs.length > MAX_ENTRIES) logs.length = MAX_ENTRIES;
  return entry;
}

export function getLogs({ limit = 50, tool } = {}) {
  let result = logs;
  if (tool) result = result.filter((l) => l.tool === tool);
  return result.slice(0, limit);
}

export function clearLogs() {
  logs.length = 0;
}
