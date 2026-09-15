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
- **Dashboard** — a seven-page browser UI (routing, providers, logs, spend, Kiro accounts, setup guide) with no build step
- **Auto /v1 detection** — paste a base URL without /v1, gateway figures it out
- **Zero config files** — everything managed through the dashboard, no YAML/JSON editing

## Quick Start

```bash
git clone https://github.com/amitnexTech/agentos-gateway.git
cd agentos-gateway
npm install
npm start
```

Open `http://localhost:9000/admin` in your browser. The gateway binds to
127.0.0.1 and prints a generated admin token on first boot — the dashboard asks
for it over HTTP Basic auth (any username, the token as the password).

## Dashboard

Every page shares a left sidebar, and all of them render from live state at
request time:

| Page | URL | What it does |
|---|---|---|
| Dashboard | `/admin` | Overview: which provider serves each tool, recent activity, health |
| Routing | `/admin/routing-panel` | Assign a provider to each tool slot, toggle auto-fallback, manage session profiles |
| Providers | `/admin/providers-panel` | Add, edit, test, enable/disable providers; fetch their model lists |
| Logs | `/admin/logs` | Live request log: requested vs answered model, tokens, latency, cost |
| Spend | `/admin/spend` | Monthly totals broken down by project, provider and model |
| Kiro | `/admin/kiro` | Kiro accounts: credit usage, budgets, key rotation |
| Setup guide | `/admin/guide` | Copy-paste base URLs, admin token and profile URLs for each client |

`/admin/classic` still serves the earlier single-page dashboard as a rollback.

Note that `GET /admin/routing` and `GET /admin/providers` are JSON APIs, not
pages — that is why the two panels sit on `-panel` URLs.

## Usage

### Add a provider

1. Open **Providers** → Add provider
2. Pick a preset (OpenRouter, Anthropic, Groq, etc.) or enter manually
3. Paste your API key
4. Click "Fetch" to get available models
5. Select models → Save

### Route tools to providers

On the **Routing** page:
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

### Watch what it costs

**Logs** shows each request as it happens: which model was requested versus which
actually responded, token usage split by input/output/cache, estimated cost, and
latency with colour coding. **Spend** keeps the permanent record — monthly totals
by project, provider and model, so a month's bill can be traced to the work that
caused it.

## Supported Provider Types

| Type | Examples |
|------|----------|
| `openai-compat` | OpenRouter, Requesty, Groq, Together AI |
| `anthropic-compat` | Anthropic direct, and any reseller exposing `/v1/messages` |
| `local-openai` | Ollama, LM Studio (no auth needed) |

## Documentation

The dashboard's own **Setup guide** (`/admin/guide`) is the fastest way to point a
client at a running gateway — it renders the base URLs, admin token and profile
URLs from live state, with a copy button on each.

Design notes and rationale live in [`docs/`](docs/index.md):

| Doc | Covers |
|---|---|
| [architecture](docs/architecture.md) | Directory layout, provider types, adapter hierarchy, routing resolution, Codex wire format |
| [protocol-bridge](docs/protocol-bridge.md) | OpenAI Chat ↔ Anthropic Messages translation both ways, and what is dropped vs refused |
| [session-profiles](docs/session-profiles.md) | Per-session provider/model selection via a `/p/<name>` base URL |
| [kiro-integration](docs/kiro-integration.md) | Kiro accounts, auth, model aliasing, credit budgets |
| [codex-integration](docs/codex-integration.md) | The Codex `/v1/responses` path and synthetic SSE |
| [security](docs/security.md) | Dashboard auth, loopback binding, why `/v1` stays unauthenticated |
| [cost-and-context](docs/cost-and-context.md) | Token/credit measurement and model-swap detection |
| [spend-tracking](docs/spend-tracking.md) | The permanent monthly record and project attribution |
| [fallback-and-verification](docs/fallback-and-verification.md) | Auto-fallback design and the CLI verification playbook |

## Tests

```bash
npm test
```

`node --test` units plus a single-file integration harness that boots the gateway
against a fake upstream. Zero devDependencies. The harness also guards the
dashboard, which has no build step: it checks that every page's inline script
parses, that each one's element references resolve, that a page script cannot
collide with the shared layout shell, and that the setup guide's URLs still match
what the gateway serves.

## License

MIT — see [LICENSE](LICENSE).
