// Per-request context (which project, which client) made available to code that
// never sees the HTTP request.
//
// `logRequest` is called from 17 places, several of them deep in kiro/client.js and
// lib/proxyExecute.js which have no `req` in scope. Threading a `project` argument
// through all of them would be a lot of noise for one field, so the project is
// resolved ONCE per request by the middleware below and read back where it is
// needed. AsyncLocalStorage is stdlib (node:async_hooks) — no dependency.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function requestContext() {
  return storage.getStore() || {};
}

// Tag the current request with the session profile taken from its URL prefix
// (/p/<name>/v1/...). Mutating the store is deliberate: the profile is only known
// after express has matched the mount path, which is after the middleware below
// has already opened the context.
export function tagProfile(name) {
  const store = storage.getStore();
  if (store) store.profile = name;
}

// Run `fn` inside a context — for tests and for anything that needs to simulate a
// request without one.
export function runWithContext(ctx, fn) {
  return storage.run({ ...ctx }, fn);
}

/**
 * Which project a request belongs to. Attribution is best-effort by design: an
 * unattributed request is recorded as "unknown" rather than guessed at, and the
 * client name is kept either way so the gap is visible instead of silent.
 *
 * Signals, in order of trust:
 *  1. `x-agentos-project` — an explicit label. Anything can identify itself, and
 *     this is the escape hatch for clients the two heuristics below do not cover.
 *  2. Codex: `x-codex-turn-metadata` (also mirrored in the body's
 *     `client_metadata`) carries `workspaces: { "/abs/path": {...} }`. Verified
 *     against real Codex 0.146 traffic on 2026-08-03.
 *  3. Claude Code: its system prompt carries an environment block with
 *     "Working directory: /abs/path". Cheap to read, and if the wording ever
 *     changes attribution simply falls back to unknown — nothing breaks.
 */
export function projectFromRequest(req) {
  const explicit = req.headers?.["x-agentos-project"];
  if (explicit) return String(explicit).slice(0, 300);

  const fromCodex = codexWorkspace(req.headers?.["x-codex-turn-metadata"]) ||
    codexWorkspace(req.body?.client_metadata?.["x-codex-turn-metadata"]);
  if (fromCodex) return fromCodex;

  const system = req.body?.system;
  const systemText = Array.isArray(system)
    ? system.map((block) => (typeof block === "string" ? block : block?.text || "")).join("\n")
    : typeof system === "string"
      ? system
      : "";
  const cwd = /working directory:\s*(\S+)/i.exec(systemText);
  if (cwd) return cwd[1];

  return null;
}

function codexWorkspace(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const paths = Object.keys(JSON.parse(raw).workspaces || {});
    return paths[0] || null;
  } catch {
    return null;
  }
}

// The client that sent the request, e.g. "codex_exec/0.146.0" or "claude-cli/2.1.0".
// Kept short: it is a label, not a fingerprint.
export function clientFromRequest(req) {
  const ua = req.headers?.["user-agent"];
  if (!ua) return null;
  return String(ua).split(/\s+/)[0].slice(0, 60);
}

export function requestContextMiddleware(req, res, next) {
  // express's body parser has already run, so the body-based signals are available.
  storage.run({ project: projectFromRequest(req), client: clientFromRequest(req), profile: null }, next);
}
