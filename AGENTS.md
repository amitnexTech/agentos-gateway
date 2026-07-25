# AgentOS Gateway — Agent Guide

Unified AI API gateway with a browser dashboard. One `localhost` URL for Claude Code, Codex, and any OpenAI/Anthropic-compatible tool.

## Architecture

```
Claude Code ─→ localhost:9000/v1/messages    (Anthropic format)  ─→ routing["claude"] provider
Codex       ─→ localhost:9000/v1/responses   (OpenAI Responses)  ─→ routing["codex"] provider
Kiro/Any    ─→ localhost:9000/v1/chat/completions (OpenAI Chat)  ─→ routing["openai"] provider
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
│   ├── proxy.js           # /v1/chat/completions (OpenAI)
│   ├── anthropic.js       # /v1/messages (Claude Code) + model alias
│   └── responses.js       # /v1/responses (Codex)
├── config/
│   ├── keysStore.js       # Provider + model + routing registry (keys.json)
│   ├── envStore.js        # Secrets store (data/.env)
│   ├── usageStore.js      # Request/token tracking
│   └── logStore.js        # In-memory request log (last 200)
├── adapters/
│   ├── base.js            # Abstract adapter
│   ├── openaiCompat.js    # OpenAI-compatible providers
│   ├── anthropicCompat.js # Anthropic-compatible providers
│   └── localOpenAI.js     # Local providers (no auth)
├── lib/
│   ├── errors.js          # Error handling
│   ├── stream.js          # SSE stream piping
│   ├── modelFetch.js      # Auto-fetch models (with /v1 auto-detection)
│   ├── upstreamError.js   # Upstream error extraction
│   └── providerProbe.js   # Provider health check
data/                      # Runtime data (gitignored)
├── keys.json              # Provider + routing config
├── .env                   # API keys (secrets)
└── usage.json             # Usage stats
```

## Provider Types (3 only)

| Type | Use For | Auth |
|------|---------|------|
| `openai-compat` | OpenRouter, Requesty, Groq, Together, any OpenAI-format API | API key |
| `anthropic-compat` | Anthropic direct, Lumosel, any Anthropic-format API | API key |
| `local-openai` | Ollama, LM Studio, llama.cpp | None |

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
