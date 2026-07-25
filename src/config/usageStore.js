import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./envStore.js";

export function usagePath() {
  return join(dataDir(), "usage.json");
}

function readAll() {
  if (!existsSync(usagePath())) return {};
  try {
    return JSON.parse(readFileSync(usagePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeAll(data) {
  mkdirSync(dataDir(), { recursive: true });
  const tmp = `${usagePath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, usagePath());
  chmodSync(usagePath(), 0o600);
}

function ensureEntry(data, modelId) {
  if (!data[modelId]) {
    data[modelId] = { requests: 0, errors: 0, lastUsedAt: null };
  }
  return data[modelId];
}

export function recordRequest(modelId) {
  const data = readAll();
  const entry = ensureEntry(data, modelId);
  entry.requests += 1;
  entry.lastUsedAt = new Date().toISOString();
  writeAll(data);
}

export function recordError(modelId) {
  const data = readAll();
  const entry = ensureEntry(data, modelId);
  entry.errors += 1;
  entry.lastUsedAt = new Date().toISOString();
  writeAll(data);
}

export function getStats() {
  return readAll();
}
