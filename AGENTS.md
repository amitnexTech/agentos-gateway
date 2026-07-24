# AgentOS Gateway — Agent Guide

Unified AI API gateway with a browser dashboard. One `localhost` URL for Claude Code, Codex, and any OpenAI/Anthropic-compatible tool.

## Architecture

```
Claude Code ─→ localhost:9000/v1/messages (Anthropic)
Codex       ─→ localhost:9000/v1/responses (OpenAI Responses)
Any tool    ─→ localhost:9000/v1/chat/completions (OpenAI Chat)
Dashboard   ─→ localhost:9000/admin (browser)
```

## Directory Structure

```
src/
├── server.js          # Entry point
├── app.js             # Express app setup
├── routes/
│   ├── admin.js       # Dashboard API + HTML
│   ├── proxy.js       # /v1/chat/completions (OpenAI)
│   ├── anthropic.js   # /v1/messages (Claude Code)
│   └── responses.js   # /v1/responses (Codex)
├── config/
│   ├── keysStore.js   # Provider + model registry (keys.json)
│   ├── envStore.js    # Secrets store (.env)
│   └── usageStore.js  # Request/token tracking
├── adapters/
│   ├── base.js        # Abstract adapter
│   ├── openaiCompat.js # Generic OpenAI-compat providers
│   └── ...            # Per-provider adapters
├── kiro/
│   └── auth.js        # Kiro OAuth/SSO token management
├── lib/
│   ├── errors.js      # Error handling
│   ├── stream.js      # SSE stream piping
│   └── modelFetch.js  # Auto-fetch models from provider
dashboard/             # React admin UI (future)
data/                  # Runtime data (gitignored)
├── keys.json          # Provider registry
├── .env               # API keys (secrets)
└── usage.json         # Usage stats
```

## Key Design Decisions

1. **Manual routing only** — no auto-switch between providers. User controls which provider serves which tool.
2. **Per-tool config** — Claude Code and Codex can use different providers/models independently.
3. **Dashboard-driven** — all config changes via browser UI, no file editing needed.
4. **Plug and play** — add provider URL + key → auto-fetch models → enable → done.
5. **Kiro native** — built-in Kiro account management (SQLite auth, token refresh, multi-account).

## Running

```bash
npm install
npm start         # port 9000
# or
npm run dev       # with --watch
```

## Provider Types

- `openai-compat` — any OpenAI-compatible API (OpenRouter, Requesty, etc.)
- `kiro` — Kiro/AWS accounts with OAuth token management
- `local-openai` — Ollama, LM Studio, llama.cpp
- `gemini` — Google Gemini (translated)

## For Open Source Release

- MIT licensed
- No vendor lock-in
- Works with any provider that speaks OpenAI or Anthropic protocol
- Dashboard is self-contained (no external dependencies)
