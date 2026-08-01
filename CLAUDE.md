# AgentOS Gateway — CLAUDE.md

Read `AGENTS.md` for full architecture. This file has operational instructions.

## ⚠️ Long-Running Processes — DO NOT KILL

Two things are expected to be running. Check before killing any node/bash process
or running a broad `pkill`.

| What | Command | Started | Purpose |
|---|---|---|---|
| Gateway | `node src/server.js` on :9000 | 2026-07-26 | The gateway itself. Restart with `npm start` if down. |
| Lumosel baseline monitor | `bash ./scripts/baseline.sh lemosol 1800` | 2026-07-26 ~21:16 IST | Samples Lumosel throughput every 30 min for a buy/skip decision. **Must keep running ~24h.** |

The baseline monitor is detached (`nohup setsid`) and survives terminal close.
It appends to `data/baseline-lemosol.log`. Read it with:

```bash
python3 scripts/baseline-summary.py
```

Stop it only once ~48 samples per model are collected (i.e. after 2026-07-27
~21:00 IST), with `pkill -f baseline.sh`. Killing it early throws away the data
and the sampling has to start over.

## Agent Config In This Repo — Do Not Delete

- `.kiro/hooks/trailmem-session-start.json` — SessionStart briefing. Prints
  `[trailmem hook: PROJECT-level fired]` before the briefing, so it can be told
  apart from the global hook at `~/.kiro/hooks/` (which only prints a GLOBAL
  marker). This pair is a live experiment: whichever marker appears next session
  tells us whether Kiro CLI reads global hooks. See TrailMem #167.
- `.kiro/steering/global-rules.md` — a **hardlink** (not a copy, not a symlink) to
  `~/.config/agents-global.md`, inode shared. Editing either path edits both. An
  editor that saves by unlink-and-recreate will break the link; re-make it with
  `ln -f ~/.config/agents-global.md .kiro/steering/global-rules.md`.

## Auto-Fallback (2026-07-27)

Opt-in (default OFF). When a tool's bound provider fails with a retriable upstream
error (429/401/403/408/5xx/timeout), the same request retries on another enabled
provider that speaks the **same protocol** — so the execution path (executeKiro vs
anthropic SSE vs OpenAI chat SSE) is unchanged and the fallback speaks the right
wire format.

- **Toggle:** Dashboard Routing panel "Auto-fallback" checkbox, or
  `POST /admin/routing/fallback {enabled:bool}`; `GET /admin/routing` returns
  `fallbackEnabled`. Stored as `routing.fallbackEnabled` in keys.json.
- **Chain** (`keysStore.fallbackProviders`): Kiro→Kiro (executeKiro path);
  openai slot→openai-compat+local-openai (OpenAI chat SSE);
  claude/codex passthrough→anthropic-compat (anthropic SSE). Protocol group follows
  the execution path, not raw type equality.
- **Kiro fallback is strict** — a candidate is only tried if it advertises the
  resolved model (unconfigured id = ban risk). Passthrough fallback forwards the
  raw id untouched (#171 item 3).
- **Pre-stream only** — `callUpstream`/`executeKiro` throw before any byte is
  streamed, so retry is clean; mid-stream failures are NOT recovered.
- Each failed attempt is logged as an error entry; `logPage.js` shows a "fallback"
  badge by the provider name. `logRequest` captures a `fallback` (bool) field.

## What This Is

Unified AI API gateway — one `localhost:9000` for Claude Code, Codex, Kiro, any tool. Per-tool routing: each agent can use a different provider.

## Current State (working)

- ✅ 3 provider types: openai-compat, anthropic-compat, local-openai
- ✅ Per-tool routing (claude/codex/openai → independent provider each)
- ✅ Model alias mapping (dated names → short names, Kiro-only — `src/kiro/client.js`)
- ✅ Auto /v1 detection in base URLs
- ✅ Model verification (see "Model swap detection" below)
- ✅ Token tracking (input/output/cache_read/cache_write)
- ✅ Kiro context-window % + re-sent history size per request (see "Kiro Cost &
  Context Visibility")
- ✅ Cost estimation per request
- ✅ Request log page with live auto-refresh
- ✅ Auto-fallback (opt-in, default OFF — same-protocol retry on retriable errors)
- ✅ Dashboard with routing dropdowns, presets, inline test results

## Model Swap Detection (2026-07-26)

A reseller that quietly serves a cheaper model **echoes back the model name you
asked for**, so comparing names proves nothing on its own. Name comparison only
catches careless proxies. The behavioural signals are what actually decide it.

`src/config/logStore.js`
- `normalizeModel()` — collapses date suffixes and `.`/`_`/`-` differences before
  comparing, so `claude-opus-4.8` vs `claude-opus-4-8` is no longer a false alarm
- `tps` — output tokens per second. **The real detector**: a model's generation
  speed cannot be faked. A sudden 2x+ jump over baseline means a cheaper model ran.
- `rawModel` — what the client asked for, before alias mapping. Without this you
  cannot tell whether a mismatch came from our own alias map or from the provider.
  (Alias mapping is now Kiro-only — `src/kiro/client.js` — so non-Kiro providers
  forward the raw id untouched; only Kiro's short-name catalog needs it.)
- `responseId` — real Anthropic ids look like `msg_01…`; a synthetic shape means a
  proxy generated the envelope itself.

The anthropic-compat path captures `rawModel` (in `src/routes/anthropic.js`) plus
`responseModel`/`responseId`/`usage` — streaming via `src/lib/anthropicSse.js`
(line-buffered SSE sniff), non-streaming inline. `src/routes/logPage.js` shows a
`tok/s` column and the id under the model cell.

Known gap: the `kiro` provider path estimates tokens at ~4 chars/token rather than
counting them (Kiro reports no token counts at all), so `tps` and `cost` are
approximations there. Anthropic-compat providers are unaffected — their usage comes
straight from upstream.

## Kiro Cost & Context Visibility (2026-08-01)

Input is the cost on Kiro. The protocol keeps no server-side conversation state, so
`buildKiroConversation` re-sends the full history every turn and Kiro bills the whole
payload again. Measured on a real 51-minute session: **~83 credits/hour**, and a
fixed-shape 5-output-token request climbed 0.116 → 0.321 cr as history grew, then
reset when a new conversation started.

The Kiro routes used to log `input_tokens: 0`, which hid exactly that. Now:

- `src/kiro/tokens.js` — `measureKiroPayload()` measures the outgoing payload
  (`inputTokens` ~4 chars/token, `historyEntries`, `payloadChars`). Rough by design:
  it shows growth and scale, not a bill.
- `contextUsagePercent` — Kiro's own context-window figure. It was already being
  parsed and then **discarded**; it now reaches `logRequest` and the log page shows
  it as a bar with the re-sent turn count under it. This is the answer to "how full
  is the context window".
- Tool-call JSON now counts as output tokens (`stream.js`, `codexStream.js`).
  Previously only text deltas counted, so tool-only turns reported `output_tokens: 0`
  — 30% of a measured session's spend looked free.
- The `$ cost` column on Kiro is an **analogy** at Anthropic list rates, useful for
  making input cost legible. `kiroCredits` is the real spend.

Spending less is behavioural, not a code fix: fewer turns, `/clear` more often, and
don't route Claude Code's tiny utility calls (38% of requests) to an expensive
account. See TrailMem #198.

## Connect Timeouts — Happy Eyeballs (2026-08-01)

Repeated `Kiro API error ... connection timed out` with a **~765ms** latency was not
a provider outage. Node gives each candidate address 250ms to finish its TCP
handshake before racing the next one; every AWS address behind
`runtime.us-east-1.kiro.dev` needs ~310–400ms from here, so no address ever won
inside the budget and Node rejected with `AggregateError [ETIMEDOUT]` after walking
the whole list.

`src/server.js` raises it via `setDefaultAutoSelectFamilyAttemptTimeout(2000)`
(override with `AGENTOS_CONNECT_ATTEMPT_TIMEOUT_MS`). Measured effect on healthy
requests: 2560ms → 321ms. A 765ms "timeout" is the fingerprint of this bug, not of a
slow provider.

`src/lib/netError.js` maps connect-level failures (`ENOTFOUND`, `ETIMEDOUT`,
`ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`, …) to readable `ApiError`s. Before, they
reached the express handler as `unhandled error` and dumped a full undici stack per
failed request, were invisible in the request log, and could not trigger
auto-fallback (which only retries an `ApiError`). Genuine bugs still keep their
stack trace.

## Provider Evaluation Scripts

```bash
node scripts/swap-probe.mjs <providerId|providerName> [model ...]
python3 scripts/baseline-summary.py [logfile]
./scripts/baseline.sh [provider] [interval_s] [model ...]
```

`swap-probe.mjs` sends one deterministic prompt (temperature 0) per model and
reports tok/s, latency, name mismatch, id shape, whether cache fields are present,
and any leaking upstream headers. It reads the key from `data/.env` via the
provider's `apiKeyRef` and never prints it.

Decision thresholds for baseline data: median **40+ tok/s** is good, 20–40 usable,
under 20 painful for coding. Stall rate (>10s latency) under 10% is fine, 25%+ means
ask the provider about priority tiers before paying.

## Kiro Auth — Done (2026-07-26)

Kiro auth was merged into this gateway via `ksk_` API keys; the SQLite/OIDC token
juggling and the old Python kiro-gateway on ports 8000/8001 are gone. A single
process on :9000 serves everything. Multiple Kiro accounts are supported — each
added by pasting a key in the dashboard (`src/routes/kiroAccount.js`), identified
by `profileArn`. See TrailMem #161.

## Build & Run

```bash
npm install
npm start           # port 9000
npm run dev         # with --watch
```

## Verifying a Codex or Claude path change

A hand-written curl proves nothing here: it matches the gateway's own assumptions, so it
passes even when the real CLI is broken. This is how the "Codex has no tools" bug survived
a *verified live* claim. Always verify with the real CLI, and always through a **multi-turn**
tool round trip (call → output fed back → answer); turn 1 alone hides dropped tool history.

To see what the CLI actually sends, put a transparent dump proxy in front of the gateway
(listen on 9010, dump each body, forward to 127.0.0.1:9000) and point only the client at it
for one run — no gateway restart, no config edits:

```
codex exec --skip-git-repo-check -c 'model_providers.kiro-codex.base_url="http://localhost:9010/v1"' "<prompt>"
```

Start such helpers with `setsid nohup … &`; a plain `&` from an agent tool call dies with the
call. To confirm which SSE event names / item types a CLI accepts, read them out of its
binary instead of guessing: `strings -n 10 <codex-binary> | grep -oE "response\.[a-z_.]+" | sort -u`.

Two traps when driving `codex exec` from a tool call: it reads stdin and will **hang**
waiting for it, so redirect `< /dev/null`; and a `stream disconnected / Reconnecting 1-5`
error usually means the gateway process died or was mid-restart, not that the SSE format is
wrong — check the process is alive before debugging the wire format.

This is not hypothetical. On 2026-08-01 a curl test passed while every real Codex reply
printed blank: `streamKiroToCodex` streamed the text deltas correctly but sent the terminal
`*.done` events with `text: ""` and `response.completed` with `output: []`. Codex takes the
message content from the completed item, not the deltas, so the answer was discarded (and
dropped from the next turn's history). curl concatenates whatever arrives, so it saw nothing
wrong. Fixed in `90eeccf`.

## What NOT To Do

- Do NOT add OAuth — unnecessary complexity
- Do NOT add provider-specific adapters — openai-compat/anthropic-compat cover all
- Do NOT add React dashboard — inline HTML, zero build step
- Do NOT add caching layer — passthrough proxy is the design
- Do NOT modify data/keys.json manually — use dashboard API

## Key Technical Constraints

- Codex requires `/v1/responses` endpoint
- Codex CLI ≥ 0.145 sends tools inside an `additional_tools` input item and no
  `instructions` field — see the "Codex wire format" section in `AGENTS.md`
- Claude Code uses `/v1/messages` (Anthropic format, streamed SSE)
- Model alias in `routes/anthropic.js`: dated names → short names
- Secrets in `data/.env`, config in `data/keys.json` (both gitignored)
- Request log persists to `data/logs.json` (last 200 entries, survives restart).
  The log page header still says "resets on restart" — that text is stale.

## Provider Findings (2026-07-26)

Third-party resellers currently configured. Both are very new — first TLS cert
from Certificate Transparency logs: **aerolink.lat 2026-05-31**, **lumosel.vip
2026-07-11**. Treat this whole category as short-lived: never prepay more than a
month, prefer monthly plans over prepaid balance (bounded loss).

**Lumosel** (`https://api.lumosel.vip/v1`, anthropic-compat, `lemosol` in keys.json)
- Live `GET /v1/models` is ahead of their public docs page — trust the endpoint:
  `claude-fable-5`, `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5`,
  `glm-5.2`, `gpt-5.6`, `gpt-5.6-sol`
- On the $10 Builder plan only 2 of 7 work. `claude-opus-5` → 403 "your plan does
  not include this model"; `claude-opus-4-8` → 503; the glm/gpt routes → 502 with a
  raw Cloudflare HTML body instead of a JSON error.
- **`claude-fable-5` is not a Claude model.** A 2026-07-27T00:18 error leaked the
  real target: `No available channel for model kat-coder-pro-v2.5 under…`.
  KAT-Coder-Pro V2.5 is a Kwaipilot (Kuaishou) coding model. The `claude-` prefix
  on that route is misleading.
- **Upstream chain leaked** in the same window: `claude-sonnet-5` →
  `404 model 'accounts/euromodels/models/claude-sonnet-5' not found`, a Fireworks-AI
  style path. "No available channel" phrasing is characteristic of the one-api /
  new-api reseller panels. Chain is at least: client → Lumosel → reseller panel →
  Fireworks-style provider → model.
- **Backend switching confirmed.** Same prompt at temperature 0, `claude-sonnet-5`:
  135 output tokens with an `msg_01…` id and cache fields present at 21:16 and
  01:0x, but 300 output tokens (hit the ceiling) with a SYNTHETIC id and cache
  ABSENT at 00:48. Different model served that window.
- **Availability is the real problem, not speed.** 22:18–23:48 was a full outage
  (`503 overloaded_error "Gateway is offline"`, 4 consecutive samples). `opus-5`
  sometimes returns a raw Cloudflare 502 HTML page. A 429 revealed the $10 plan
  enforces a **6-hour** window, not the 4-hour window advertised on their pricing
  page. When healthy, throughput is fine — sonnet-5 has hit 52 tok/s.

**Detection lesson:** output token count on a fixed prompt at temperature 0 is the
cheapest and most decisive swap signal, ahead of tok/s. And short probe bursts prove
nothing — the first 8 probes found no swapping, which was wrong. Only the long
series caught it. Never truncate upstream error bodies; both leaks above came from
error text that the probe originally cut at 120 chars.

**Aerolink** (`aerolink.lat`) — repriced within 2 months of launch: Ultra went from
~₹9,550 with $200/5h + $1400/week to ₹9,999 with $100/5h + $700/week, and the old
allowance moved to a new $200 "Power" tier. Effective rate got ~2.1x worse. All
tiers now bill at the same rate (no volume discount). Balance top-ups are USD and
never expire; burn order is plan allowance → bonus credits (expire) → wallet balance.

Note: the two dashboards are structurally near-identical (same six plan names, same
window model, the same "4.8 and 4.6 model routes" string, Telegram verification).
Likely the same white-label panel, so redundancy across them is operator-level only,
not upstream-level.
