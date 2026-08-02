# AgentOS Gateway — CLAUDE.md

Read `AGENTS.md` for architecture. This file has operational instructions only —
for design rationale and detailed write-ups see `docs/` (start at `docs/index.md`).

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

Do not kill the gateway on :9000 without asking Amit first — Claude Code's own
session usually routes through it. Test path changes on an isolated port instead:
copy `data/keys.json` + `data/.env` into `/tmp/x`, then
`setsid nohup env AGENTOS_DATA_DIR=/tmp/x PORT=9004 node src/server.js &`.
`lsof -t -i:9000` also lists client processes (browsers, claude) — confirm the
actual listener with `lsof -i:9000 -sTCP:LISTEN`.

## Agent Config In This Repo — Do Not Delete

- `.kiro/hooks/trailmem-session-start.json` — SessionStart briefing hook.
- `.kiro/steering/global-rules.md` — a **hardlink** (not a copy, not a symlink) to
  `~/.config/agents-global.md`, inode shared. Editing either path edits both. An
  editor that saves by unlink-and-recreate will break the link; re-make it with
  `ln -f ~/.config/agents-global.md .kiro/steering/global-rules.md`.
- `docs/` — project documentation (know-hub format). See `docs/index.md`.

## Build & Run

```bash
npm install
npm start           # port 9000
npm run dev         # with --watch
```

Dashboard changes are served from `src/routes/adminPage.js` at request time but
the module is loaded once at boot, so the gateway process must be restarted for
UI edits to appear.

Operational trap: `pkill -f "node src/server.js"` matches the invoking shell's
own command line and kills it. Even the bracketed form
`pkill -f "[n]ode src/server.js"` self-matches if the same shell command also
contains the literal string `node src/server.js` (e.g. a kill-then-restart
one-liner). Safer to resolve the PID first with `pgrep`, confirm it with
`ps -o cmd`, then kill by PID — `pgrep -f "server[.]js"` on this machine also
matches Kiro's own `acp-server.js` processes, which must not be killed.

## Verifying a Codex or Claude path change

Always verify with the real CLI through a multi-turn tool round trip, never a
hand-written curl — curl matches the gateway's own assumptions and will pass
even when the real client is broken. Full playbook (dump proxy, binary string
extraction, past incidents) in [[fallback-and-verification]] → see
`docs/fallback-and-verification.md`.

Quick traps: `codex exec` reads stdin and hangs unless redirected `< /dev/null`;
a "Reconnecting 1-5" error usually means the gateway process died, not a bad SSE
format — check the process is alive first.

## Key Technical Constraints

- Codex requires `/v1/responses` endpoint
- Codex CLI ≥ 0.145 sends tools inside an `additional_tools` input item and no
  `instructions` field — see "Codex wire format" in `AGENTS.md` and
  `docs/architecture.md`
- Claude Code uses `/v1/messages` (Anthropic format, streamed SSE)
- Model alias in `routes/anthropic.js`: dated names → short names
- Secrets in `data/.env`, config in `data/keys.json` (both gitignored)
- Request log persists to `data/logs.json` (last 200 entries, survives restart).
  The log page header still says "resets on restart" — that text is stale.

## What NOT To Do

- Do NOT add OAuth — unnecessary complexity
- Do NOT add provider-specific adapters — openai-compat/anthropic-compat cover all
- Do NOT add React dashboard — inline HTML, zero build step
- Do NOT add caching layer — passthrough proxy is the design
- Do NOT send Kiro `cachePoint` markers — measured 2026-08-01: a cache write costs ~1.9x and the following read gets no discount, so it only raises the bill (`docs/cost-and-context.md`)
- Do NOT modify data/keys.json manually — use dashboard API

## Provider Evaluation Scripts

```bash
node scripts/swap-probe.mjs <providerId|providerName> [model ...]
node scripts/kiro-cache-probe.mjs <providerId|nameSubstring> [model]   # burns real credits
python3 scripts/baseline-summary.py [logfile]
./scripts/baseline.sh [provider] [interval_s] [model ...]
```

See `docs/provider-findings.md` for what these scripts have found so far
(Lumosel/Aerolink reliability, backend-switching evidence) and
`docs/cost-and-context.md` for the model-swap detection methodology.

## Further reading

- `docs/architecture.md` — directory structure, provider types, adapter hierarchy, tool-slot routing/resolution, Codex wire format, key features
- `docs/kiro-integration.md` — Kiro auth, account management, model aliasing, connect-timeout fix
- `docs/codex-integration.md` — Codex non-Kiro path: Responses↔Chat-Completions translation, synthetic SSE
- `docs/security.md` — dashboard auth, loopback binding, admin token rationale
- `docs/cost-and-context.md` — Kiro credit/token measurement, model-swap detection
- `docs/fallback-and-verification.md` — auto-fallback design, CLI verification playbook
- `docs/provider-findings.md` — Lumosel/Aerolink reseller findings
