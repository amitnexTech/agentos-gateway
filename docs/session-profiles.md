# Session Profiles — per-session model routing, parallel sessions, /p/&lt;name&gt; base URL

How one gateway serves several sessions on different models at the same time: a named profile pins a provider and model, and a session selects it through the base URL it was started with. Covers why URL selection was chosen over the alternatives, the resolution order, and the failure rules.

**Status:** v1.0 COMPLETE

## The limitation this removes

Everything in [[architecture]]'s routing section is keyed by **tool slot** and **model id**, and both are global to the gateway. Bind the `claude` slot to an account, or set its force route, and *every* Claude Code session on the machine follows it. There was no way to express the normal working day:

- backend work on Opus,
- a parallel frontend session on Kimi K3,
- a third session writing documentation on Sonnet,

all at the same time, through one gateway. Whatever the dashboard said, that was what every session got.

A profile is the same "this provider, this model" pairing as a force route, scoped to **one session** instead of to the whole gateway.

## Using it

```jsonc
// data/keys.json
"profiles": {
  "backend":  { "providerId": "provider-1a2b3c4d", "model": "claude-opus-4.5" },
  "frontend": { "providerId": "provider-5e6f7a8b", "model": "kimi-k3" },
  "docs":     { "providerId": "provider-1a2b3c4d", "model": "claude-sonnet-4.5" },
  "loose":    { "providerId": "provider-5e6f7a8b" }   // pin the account only
}
```

Each session picks one with its base URL — one env var per terminal, nothing else:

```bash
# terminal 1 — backend
export ANTHROPIC_BASE_URL=http://localhost:9000/p/backend
# terminal 2 — frontend, at the same time
export ANTHROPIC_BASE_URL=http://localhost:9000/p/frontend
```

```toml
# ~/.codex/config.toml — Codex keeps its own /v1 suffix
base_url = "http://localhost:9000/p/docs/v1"
```

Un-prefixed traffic on `/v1/...` is untouched: it follows the global slots exactly as before, so nothing has to be migrated and the dashboard's routing stays the default for anything that does not opt in.

Dashboard: **Session profiles**, under Routing. Each row shows the base URL to paste, and `GET`/`POST /admin/profiles` is the same thing over the API (`{ name, providerId, model? }`; `providerId: null` deletes).

`model` is optional. Omit it to pin only the account and let the client's own model id through.

## Why the base URL, and not the alternatives

| selector | why not |
|---|---|
| **model id** (a different `ANTHROPIC_MODEL` per terminal, routed with `modelRoutes`) | Works today with no code, and was rejected for one reason: it cannot follow a session's *background* traffic. Claude Code sends topic detection, its subagent and its auto-mode classifier under **different model ids** (measured: 64 of 200 requests, see [[architecture]]), so those calls would keep resolving globally while only the foreground turns followed the session. It also depends on the client accepting an arbitrary id, which Claude Code does not always do. |
| **project / cwd** (already resolved for [[spend-tracking]]) | Free, automatic, and wrong for the requirement: two parallel sessions **in the same repo** — backend work and documentation — cannot be told apart. Attribution is also best-effort, so a wording change in Claude Code's system prompt would silently drop a session onto the default account. |
| **custom header** (`ANTHROPIC_CUSTOM_HEADERS`, Codex `http_headers`) | Equivalent in precision, but it is a different mechanism per client to verify and maintain. Base URL is the one setting every client already has. Kept as the fallback if a client ever refuses a path prefix. |
| **a second gateway process per model** | A whole process, port, dashboard and log per session type. |

A URL prefix is per-process, so **all** traffic from that session carries the profile — foreground turns, subagents, classifier calls, everything. That is the property the model-id approach cannot have.

**Verified against the real client (Claude Code 2.1.220, 2026-08-04):** the CLI appends its own path to `ANTHROPIC_BASE_URL`, so the gateway receives `POST /p/backend/v1/messages?beta=true`. Two isolated CLI sessions on two profiles reached two different providers with two different pinned models in the same run.

## Resolution order

`lookupModelForTool(tool, rawModel)` in `src/kiro/client.js` is still the single funnel. Profiles slot into it:

1. an exact `{ exempt: true }` entry for this model id → the tool's own provider, the client's own id;
2. **the request's session profile** → its provider, its pinned model (or the client's id if none is pinned);
3. a per-model override / force route (`modelRoutes`);
4. the tool's slot (`routing[tool]`).

Everything after resolution is unchanged: the provider must be enabled, the route re-checks that the provider type can serve it, Kiro still gates on its configured catalog, and [[protocol-bridge]] still translates whatever pairing results.

**Why `exempt` outranks a profile.** Those entries exist to keep Claude Code's auto-mode and subagent classifier ids on a provider that actually serves them. A profile that forced those onto one pinned model would break auto mode in the sessions that opted in — the exact failure `exempt` was added to prevent.

## Failure rules

An unknown profile, or one whose provider has been deleted or disabled, is **refused with 404 before anything is sent upstream** (`profileGate` in `src/app.js`). It deliberately does *not* fall through to the global routing: a typo in a base URL would then spend real money on whatever account the dashboard happens to point at, and look like it worked. The error names the profile and lists the configured ones.

The name is validated (`a-z 0-9 _ -`, max 32 chars) because it arrives as a URL path segment.

`deleteProvider()` drops any profile naming that provider, the same way it already drops routing entries and per-model overrides — otherwise those sessions would be refused with no visible cause.

## What is recorded

`profile` is written on every log entry and every `data/spend.jsonl` line, so the log page badges which session served a request and [[spend-tracking]] answers **"what did the backend sessions cost this month"** through a `byProfile` breakdown. Profiles also make it possible to spread spend across accounts deliberately, which is part of what proactive account rotation was wanted for.

## Related

- [[index]]
- [[architecture]]
- [[spend-tracking]]
- [[protocol-bridge]]
- [[fallback-and-verification]]
