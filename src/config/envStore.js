import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";

export function dataDir() {
  return process.env.AGENTOS_DATA_DIR || join(process.cwd(), "data");
}

export function envPath() {
  return join(dataDir(), ".env");
}

// Parse existing .env into a plain object (KEY=VALUE lines).
function readEnvFile() {
  if (!existsSync(envPath())) return {};
  const obj = {};
  for (const line of readFileSync(envPath(), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    obj[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return obj;
}

function writeEnvFile(obj) {
  mkdirSync(dataDir(), { recursive: true });
  const content = Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const tmp = `${envPath()}.tmp`;
  writeFileSync(tmp, content + "\n", { mode: 0o600 });
  renameSync(tmp, envPath());
  chmodSync(envPath(), 0o600);
}

export function envGet(key) {
  if (process.env[key] !== undefined) return process.env[key];
  const value = readEnvFile()[key];
  if (value !== undefined) process.env[key] = value;
  return value;
}

export function envSet(key, value) {
  const obj = readEnvFile();
  obj[key] = value;
  writeEnvFile(obj);
  process.env[key] = value;
}

export function envDelete(key) {
  const obj = readEnvFile();
  delete obj[key];
  writeEnvFile(obj);
  delete process.env[key];
}

export function envSnapshot() {
  return readEnvFile();
}

export function envReplace(obj = {}) {
  writeEnvFile(obj);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENTOS_KEY_")) delete process.env[key];
  }
  for (const [key, value] of Object.entries(obj)) {
    process.env[key] = value;
  }
}
