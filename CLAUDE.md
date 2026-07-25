# AgentOS Gateway — CLAUDE.md

Read `AGENTS.md` for full architecture. This file has operational instructions.

## What This Is

Unified AI API gateway — one `localhost:9000` for Claude Code, Codex, Kiro, any tool. Per-tool routing: each agent can use a different provider.

## Current State (working)

- ✅ 3 provider types: openai-compat, anthropic-compat, local-openai
- ✅ Per-tool routing (claude/codex/openai → independent provider each)
- ✅ Model alias mapping (dated names → short names)
- ✅ Auto /v1 detection in base URLs
- ✅ Model verification (detect provider model bait-and-switch)
- ✅ Token tracking (input/output/cache_read/cache_write)
- ✅ Cost estimation per request
- ✅ Request log page with live auto-refresh
- ✅ Enable/disable providers, edit, manual model add
- ✅ Dashboard with routing dropdowns, presets, inline test results

## Next: Kiro Auth Merge

Bring Kiro SQLite token management into this gateway:
- Reference: `/home/amit/kiro-gateway/` (Python, SQLite-based tokens)
- Goal: eliminate need for separate kiro-gateway processes on ports 8000/8001
- Single process serves everything
- Multiple Kiro accounts supported (different profileArn per account)

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
- Log is in-memory (200 entries max, resets on restart)
