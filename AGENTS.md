# AgentOS Gateway — Agent Guide

Unified AI API gateway with a browser dashboard. One `localhost` URL for Claude Code, Codex, and any OpenAI/Anthropic-compatible tool.

## Architecture

```
Claude Code ─→ localhost:9000/v1/messages    (Anthropic format)  ─→ routing["claude"] provider
Codex       ─→ localhost:9000/v1/responses   (OpenAI Responses)  ─→ routing["codex"] provider
Any OpenAI  ─→ localhost:9000/v1/chat/completions (OpenAI Chat)  ─→ routing["openai"] provider
Dashboard   ─→ localhost:9000/admin
Logs        ─→ localhost:9000/admin/logs
```

Each tool can use a different provider — or all the same. Switch in dashboard dropdown, no restart.

## Directory Structure

```
src/
├── server.js              # Entry point
├── app.js                 # Express app setup
├── registry.js            # Adapter registry + factory
├── routes/
│   ├── admin.js           # Dashboard API + routing + provider CRUD
│   ├── adminPage.js       # Dashboard HTML (inline, no build step)
│   ├── logPage.js         # Request log page HTML
│   ├── kiroAccount.js     # Kiro account CRUD (Kiro-specific façade over providers)
│   ├── proxy.js           # /v1/chat/completions (OpenAI Chat) — protocol glue
│   ├── anthropic.js       # /v1/messages (Claude Code) — protocol glue only
│   └── responses.js       # /v1/responses (Codex) — protocol glue only
├── kiro/                  # Kiro provider: Anthropic-shaped requests over its own wire protocol
│   ├── client.js          # Kiro execution + Kiro-only model-id alias resolution
│   ├── converter.js       # Anthropic Messages → Kiro payload
│   ├── stream.js          # Kiro stream → Anthropic SSE converter
│   ├── api.js             # Kiro header construction + management-plane calls
│   └── config.js          # Kiro hosts, regions, x-amz-target constants
├── config/
│   ├── keysStore.js       # Provider + model + routing registry (keys.json)
│   ├── envStore.js        # Secrets store (data/.env)
│   ├── usageStore.js      # Request/token tracking
│   └── logStore.js        # Request log (last 200, persisted to logs.json)
├── adapters/
│   ├── base.js            # Abstract adapter
│   ├── openaiCompat.js    # OpenAI-compatible providers
│   ├── anthropicCompat.js # Anthropic-compatible providers (passthrough /v1/messages)
│   ├── localOpenAI.js     # Local providers (no auth)
│   └── kiro.js            # Kiro adapter (URLs/headers; protocol handled by kiro/)
├── lib/
│   ├── proxyExecute.js    # Shared upstream fetch + timeout + error map + SSE headers
│   ├── anthropicSse.js    # Anthropic SSE passthrough + model/usage extraction
│   ├── stream.js          # Generic OpenAI SSE stream piping
│   ├── errors.js          # Error handling
│   ├── modelFetch.js      # Auto-fetch models (with /v1 auto-detection)
│   ├── upstreamError.js   # Upstream error extraction
│   ├── providerProbe.js   # Provider health check
│   └── adminAuth.js       # Dashboard HTTP-Basic auth (admin token)
data/                      # Runtime data (gitignored)
├── keys.json              # Provider + routing config
├── .env                   # API keys (secrets)
├── logs.json              # Request log (last 200, survives restart)
└── usage.json             # Usage stats
```

## Provider Types (4)

| Type | Use For | Auth |
|------|---------|------|
| `openai-compat` | OpenRouter, Requesty, Groq, Together, any OpenAI-format API | API key |
| `anthropic-compat` | Anthropic direct, Lumosel, any Anthropic-format API | API key |
| `local-openai` | Ollama, LM Studio, llama.cpp | None |
| `kiro` | Kiro (AWS CodeWhisperer) via `ksk_` API key — Anthropic-shaped requests over its own wire protocol | API key |

A `kiro` provider is reachable only via the `claude` (`/v1/messages`) and `codex`
(`/v1/responses`) slots — its protocol is not OpenAI chat, so the `openai` slot
rejects it. Model-id aliasing (dated Claude names → Kiro's short catalog names)
is Kiro-only and lives in `kiro/client.js`; non-Kiro providers receive the raw
model id the client sent, untouched.

## Key Features

1. **Per-tool routing** — Claude Code, Codex, OpenAI tools each independently routed to any provider
2. **Model verification** — detects if provider responds with a different model than requested (bait-and-switch detection)
3. **Token tracking** — input/output/cache_read/cache_write per request
4. **Cost estimation** — approximate $ cost per request based on Anthropic pricing
5. **Model alias mapping** — Claude Code dated names auto-resolved (claude-sonnet-4-20250514 → claude-sonnet-4.5)
6. **Auto /v1 detection** — base URL auto-corrected if user doesn't add /v1
7. **Enable/Disable** — per-provider toggle, disabled providers don't route
8. **Manual model add** — when /models endpoint fails, add models manually
9. **Request logs** — live log page with latency, tokens, cost, model verification

## Running

```bash
npm install
npm start         # port 9000
npm run dev       # with --watch
```

## Dashboard Presets

Quick-add: OpenRouter, Requesty, Groq, Together, Ollama, Anthropic

## Design Principles

- No OAuth — API key auth only
- No build step — inline HTML dashboard
- No external dependencies beyond express
- No cache layer — passthrough proxy
- MIT licensed, open-source ready
