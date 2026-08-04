# Spend Tracking — monthly tokens and cost by project, provider and model

The permanent usage record: how many tokens went out this month, on which project, through which provider and model, and what it cost. Covers the append-only store, how a request is attributed to a project, and what the numbers do and do not claim.

**Status:** v1.0 COMPLETE

## Why a second store

`logStore` keeps the **last 200 requests** for the log page. That is the right size for debugging and useless for "what did this month cost": on a normal working day it is a few hours of history. Tokens were being measured on every request and then discarded within the day — the gateway could tell you about the last hour and nothing else.

`src/config/spendStore.js` appends one line per request to `data/spend.jsonl` and never rewrites it.

**Append-only lines rather than maintained aggregates**, because appending is less code than a read-modify-write of nested counters, cannot be corrupted by a crash halfway through an update, and answers questions nobody has asked yet (per day, per client, per session) instead of only the ones designed for today. The cost is file size and a scan on read: ~250 bytes per request, so a heavy month is a couple of MB and aggregating it takes milliseconds. If it ever gets big the fix is to drop old lines; nothing else touches the file.

One line looks like this:

```json
{"ts":"2026-08-03T08:54:45.383Z","tool":"claude","project":"/home/amit/project/agentos-gateway",
 "client":"claude-cli/2.1.0","provider":"Kiro: amit pro+","providerId":"provider-2968eb5c",
 "model":"claude-sonnet-4.5","status":"ok","inputTokens":29469,"outputTokens":31,
 "cacheReadTokens":0,"cacheWriteTokens":0,"cost":0.0889,"credits":0.156544,"estimated":true}
```

The write happens inside `logRequest()`, so **every** route and both the success and failure paths are covered by construction — there is no second place to remember to update.

## Where it shows up

| surface | what it gives |
|---|---|
| `/admin/spend` | month picker, totals cards, and breakdowns by project / session profile / provider / model / tool / client / day |
| `GET /admin/spend/data?month=YYYY-MM` | the same aggregates as JSON (omit `month`, or pass `all`, for everything) |
| `data/spend.jsonl` | the raw record, one JSON object per line — grep-able, no tooling needed |

Each bucket carries `requests`, `errors`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `cost`, `credits`, plus two honesty counters: `estimatedRequests` and `costedRequests`.

## Project attribution

The gateway is not told which project a request belongs to, so it reads it out of the traffic. Best-effort by design: an unattributed request is recorded as `unknown` rather than guessed at, and the client name is kept either way so the gap is visible instead of silent. `src/lib/requestContext.js`, in order of trust:

1. **`x-agentos-project` header** — an explicit label, and the escape hatch for any client the heuristics below do not cover.
2. **Codex** sends `x-codex-turn-metadata` (mirrored in the body's `client_metadata`) carrying `workspaces: {"/abs/path": {...}}`. Captured from real Codex 0.146 traffic on 2026-08-03; it also holds `session_id`, `thread_id`, `turn_id` and the workspace's git commit.
3. **Claude Code** carries an environment block in its system prompt with `Working directory: /abs/path`.

The project is resolved **once per request** by a middleware and read back through `AsyncLocalStorage` (stdlib `node:async_hooks`). `logRequest` is called from 17 places, several of them deep in `kiro/client.js` and `lib/proxyExecute.js` which have no `req` in scope — threading an argument through all of them would have been a lot of noise for one field.

The same context also carries the **session profile** the request arrived on, when it came in through a `/p/<name>/v1` base URL. Unlike the project, that one is not a heuristic — the session named it explicitly — so `byProfile` answers "what did the backend sessions cost this month" exactly. See [[session-profiles]].

## What the numbers claim

- **`~` on tokens** means the gateway estimated them at ~4 chars per token because the provider reported none. That is **every Kiro request** — Kiro's stream carries no token counts at all (see [[cost-and-context]]). `estimatedRequests` says how many rows in a bucket are like that.
- **`*` on a cost** means the figure covers only the requests whose model has a known rate. Summing a column where half the rows are unpriced understates the total, so the count is shown rather than hidden. Rates live in `MODEL_RATES` in `logStore.js`.
- **`credits`** is the only real spend figure on Kiro accounts; the `$` column there is an analogy at Anthropic list rates.
- **Errors are recorded too.** A failure that happened *after* the upstream call — an unusable reply, a body that is not JSON — still cost an upstream call and sometimes money. Those used to be logged nowhere at all: the route's `catch` simply forwarded the error. Each route now logs what it knows, and lower layers set `err.logged` on failures they have already written so nothing is double-counted.

## Verifying it

Covered in both layers (see [[fallback-and-verification]]):

- `test/spend.test.js` — aggregation across every dimension, month scoping, the honesty counters, `unknown` attribution, a torn last line from a kill mid-append, and each attribution signal including malformed Codex metadata.
- `scripts/bridge-verify.mjs` — a Codex request with a workspace header and a Claude Code request with a working directory in its system prompt, asserted through the real gateway (this is the only layer that exercises the middleware), plus an error row landing in the record as `unknown`.
- The same harness now parses the inline script of **every** dashboard page. The dashboard has no build step, so nothing else would catch a syntax error in it — the page would just render dead. That check immediately found an unescaped apostrophe in a log-page tooltip.

## Related

- [[index]]
- [[cost-and-context]]
- [[architecture]]
- [[kiro-integration]]
- [[fallback-and-verification]]
