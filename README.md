# AgentOS Gateway

A unified AI API gateway that routes Claude Code, Codex, and any OpenAI/Anthropic-compatible tool through a single localhost endpoint with a browser dashboard.

## Features

- **Per-tool routing** — Claude Code, Codex, and OpenAI tools each independently routed to any provider
- **Per-session models** — start a session with `http://localhost:9000/p/<profile>` as its base URL and it runs that profile's provider and model, so parallel sessions can use different models at once (backend on Opus, frontend on Kimi, docs on Sonnet)
- **Protocol bridge** — OpenAI Chat Completions and Anthropic Messages are translated both ways, so any provider can serve any tool: Codex on an Anthropic-format provider, Claude Code on Groq/OpenRouter/Ollama
- **Credit budgets** — a Kiro account past its budget stops serving (HTTP 402) instead of quietly spending past it
- **Model verification** — detects if a provider responds with a different model than requested
- **Token & cost tracking** — input/output/cache tokens with estimated cost per request
- **Live request logs** — see every request's provider, model, latency, tokens in real-time
- **Spend tracking** — permanent monthly totals by project, provider and model, so "what did this month cost and where did it go" is answerable
- **Dashboard** — browser UI for adding providers, configuring models, switching routes
- **Auto /v1 detection** — paste a base URL without /v1, gateway figures it out
- **Zero config files** — everything managed through the dashboard, no YAML/JSON editing

## Quick Start

```bash
git clone <repo-url>
cd agentos-gateway
npm install
npm start
```

Open `http://localhost:9000/admin` in your browser.

## Usage

### Add a provider

1. Open dashboard → Add provider
2. Pick a preset (OpenRouter, Anthropic, Groq, etc.) or enter manually
3. Paste your API key
4. Click "Fetch" to get available models
5. Select models → Save

### Route tools to providers

In the Routing panel at top:
- **Claude Code** → pick which provider handles `/v1/messages`
- **Codex** → pick which provider handles `/v1/responses`
- **OpenAI** → pick which provider handles `/v1/chat/completions`

Or click "Use for all" to route everything to one provider.

### Configure your tools

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://localhost:9000

# Codex
base_url=http://localhost:9000/v1

# Any OpenAI-compatible tool
OPENAI_BASE_URL=http://localhost:9000/v1
```

### View logs

Open `http://localhost:9000/admin/logs` to see:
- Which model was requested vs which actually responded
- Token usage (input/output/cache)
- Estimated cost per request
- Latency with color coding

## Supported Provider Types

| Type | Examples |
|------|----------|
| `openai-compat` | OpenRouter, Requesty, Groq, Together AI |
| `anthropic-compat` | Anthropic direct, and any reseller exposing `/v1/messages` |
| `local-openai` | Ollama, LM Studio (no auth needed) |

## License

MIT
