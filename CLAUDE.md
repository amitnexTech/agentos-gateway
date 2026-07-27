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

## What This Is

Unified AI API gateway — one `localhost:9000` for Claude Code, Codex, Kiro, any tool. Per-tool routing: each agent can use a different provider.

## Current State (working)

- ✅ 3 provider types: openai-compat, anthropic-compat, local-openai
- ✅ Per-tool routing (claude/codex/openai → independent provider each)
- ✅ Model alias mapping (dated names → short names, Kiro-only — `src/kiro/client.js`)
- ✅ Auto /v1 detection in base URLs
- ✅ Model verification (see "Model swap detection" below)
- ✅ Token tracking (input/output/cache_read/cache_write)
- ✅ Cost estimation per request
- ✅ Request log page with live auto-refresh
- ✅ Enable/disable providers, edit, manual model add
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

Known gap: the `kiro` provider path under-reports `output_tokens` (13 reported for
a ~50-token reply), so `tps` and `cost` are both understated there. Anthropic-compat
providers are unaffected — their usage comes straight from upstream. Fix would be in
`src/kiro/stream.js`.

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

## What NOT To Do

- Do NOT add OAuth — unnecessary complexity
- Do NOT add provider-specific adapters — openai-compat/anthropic-compat cover all
- Do NOT add React dashboard — inline HTML, zero build step
- Do NOT add caching layer — passthrough proxy is the design
- Do NOT modify data/keys.json manually — use dashboard API

## Key Technical Constraints

- Codex requires `/v1/responses` endpoint
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
