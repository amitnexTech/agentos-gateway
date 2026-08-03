# AgentOS Gateway — Agent Guide

Unified AI API gateway with a browser dashboard. One `localhost` URL for Claude Code, Codex, and any OpenAI/Anthropic-compatible tool.

## Architecture

```
Claude Code ─→ localhost:9000/v1/messages    (Anthropic format)  ─→ routing["claude"] provider
Codex       ─→ localhost:9000/v1/responses   (OpenAI Responses)  ─→ routing["codex"] provider
Any OpenAI  ─→ localhost:9000/v1/chat/completions (OpenAI Chat)  ─→ routing["openai"] provider
Dashboard   ─→ localhost:9000/admin
Logs        ─→ localhost:9000/admin/logs
Spend       ─→ localhost:9000/admin/spend        (monthly tokens + cost by project)
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
│   ├── spendPage.js       # Spend page HTML (monthly tokens/cost by project, provider, model)
│   ├── kiroAccount.js     # Kiro account CRUD (Kiro-specific façade over providers)
│   ├── proxy.js           # /v1/chat/completions (OpenAI Chat) — protocol glue
│   ├── anthropic.js       # /v1/messages (Claude Code) — protocol glue only
│   └── responses.js       # /v1/responses (Codex) — protocol glue only
├── kiro/                  # Kiro provider: Anthropic-shaped requests over its own wire protocol
│   ├── client.js          # Kiro execution + Kiro-only model-id alias resolution
│   ├── converter.js       # Anthropic Messages → Kiro payload (shared payload builder)
│   ├── codexConverter.js  # Codex Responses API → Kiro payload (direct, no Anthropic detour)
│   ├── stream.js          # Kiro stream → Anthropic SSE converter
│   ├── codexStream.js     # Kiro stream → Codex Responses items / SSE
│   ├── api.js             # Kiro header construction + management-plane calls
│   └── config.js          # Kiro hosts, regions, x-amz-target constants
├── config/
│   ├── keysStore.js       # Provider + model + routing registry (keys.json)
│   ├── envStore.js        # Secrets store (data/.env)
│   ├── usageStore.js      # Per-model request/error counters
│   ├── spendStore.js      # Permanent spend record (spend.jsonl) — monthly totals by project/provider/model
│   └── logStore.js        # Request log (last 200, persisted to logs.json)
├── adapters/
│   ├── base.js            # Abstract adapter
│   ├── openaiCompat.js    # OpenAI-compatible providers
│   ├── anthropicCompat.js # Anthropic-compatible providers (passthrough /v1/messages)
│   ├── bridge.js          # Bridged adapters: chatOverAnthropic / anthropicOverChat mixins
│   ├── localOpenAI.js     # Local providers (no auth)
│   └── kiro.js            # Kiro adapter (URLs/headers; protocol handled by kiro/)
├── lib/
│   ├── proxyExecute.js    # Shared upstream fetch + timeout + error map + SSE headers + JSON read
│   ├── requestContext.js  # Per-request project/client attribution (AsyncLocalStorage)
│   ├── protocolBridge.js  # OpenAI Chat <-> Anthropic Messages translation, both directions + streaming
│   ├── anthropicSse.js    # Anthropic SSE parser/passthrough + model/usage extraction
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
├── spend.jsonl            # Permanent spend record, one line per request (append-only)
└── usage.json             # Usage stats
test/                      # node --test unit tests (no devDependencies)
scripts/                   # bridge-verify.mjs (integration), bridge-live-probe.mjs (real providers), dump-proxy.mjs (capture CLI traffic)
```

## Provider Types (4)

| Type | Use For | Auth |
|------|---------|------|
| `openai-compat` | OpenRouter, Requesty, Groq, Together, any OpenAI-format API | API key |
| `anthropic-compat` | Anthropic direct, Lumosel, any Anthropic-format API | API key |
| `local-openai` | Ollama, LM Studio, llama.cpp | None |
| `kiro` | Kiro (AWS CodeWhisperer) via `ksk_` API key — Anthropic-shaped requests over its own wire protocol; per-account credit budget enforced | API key |

A `kiro` provider is now reachable from all three slots. On `claude` and `codex` it
uses its own converters; on `openai` the chat body is mapped to Anthropic Messages
by the protocol bridge first, because that is the shape `anthropicToKiro` already
consumes. Every other pairing works too: `src/lib/protocolBridge.js` maps OpenAI
Chat Completions <-> Anthropic Messages in both directions (request, response and
streaming), so an `anthropic-compat` provider serves `/v1/chat/completions` and
`/v1/responses`, and an `openai-compat` / `local-openai` provider serves
`/v1/messages`. `createAdapter(provider, { speaks })` wraps the adapter in a
translation mixin (`src/adapters/bridge.js`) when the route's protocol differs
from the provider's. Model-id aliasing (dated Claude names → Kiro's short catalog
names) is Kiro-only and lives in `kiro/client.js`; non-Kiro providers receive the
raw model id the client sent, untouched.

Kiro credit budgets are ENFORCED in `executeKiro()` — an account past its
`creditBudget` is refused with HTTP 402 before anything is spent (the refusal is
logged), and with auto-fallback ON the request moves to another Kiro account that
still has room. `isOverBudget()` lives in `keysStore.js`.

Hard rule for every pairing: never answer HTTP 200 with an empty body. An
untranslatable client field is a 400 with nothing sent upstream; an unusable
upstream reply (no content blocks, no `choices`, a non-JSON 200) is a 502 naming
the provider; a stream that carried nothing ends in an explicit error event and
is logged as an error. Verify with `node scripts/bridge-verify.mjs` (27 checks,
fake upstreams) and `node scripts/bridge-live-probe.mjs` (real provider).

## Codex wire format (`/v1/responses`)

Codex CLI ≥ 0.145 does **not** send `tools` or `instructions` at the top level:

- tools arrive as an input item `{type:"additional_tools", role:"developer", tools:[…]}`
- the system prompt, `AGENTS.md` and hook output arrive as `role:"developer"` message items
- tool types include `custom` (freeform text input, e.g. `exec` — the code-mode tool that
  reaches shell and every MCP tool), `function`, and `namespace` (a GROUP of tools)

`kiro/codexConverter.js` reads both wire shapes (`collectCodexTools`), folds
developer/system turns into user turns and merges same-role neighbours. Freeform tools
are advertised to Kiro as `{ input: string }` because Kiro's `toolSpecification` requires
a JSON schema, then unwrapped on the way back into a `custom_tool_call` item with raw
text.

`namespace` tools are HOISTED into the flat tool list, and the reply restores
`{namespace, name}` on the `function_call` item. This matters far beyond sub-agents:
every configured MCP server arrives as a namespace (`mcp__trailmem`, `mcp__graphify`, …)
alongside `multi_agent_v1`. Skipping the type — which the converter did until
2026-08-03 — stripped every MCP tool from the request, so the model was told it had no
MCP tools at all. Reading tools from only the old wire shape is what left Codex able to
chat but unable to call any tool at all (fixed 2026-07-29). Both are the same failure
class: the model looks uncooperative instead of the request looking broken.

## Key Features

1. **Per-tool routing** — Claude Code, Codex, OpenAI tools each independently routed to any provider, with a per-slot *Model* dropdown that pins which of that provider's models actually runs
2. **Protocol bridge** — OpenAI Chat Completions <-> Anthropic Messages translated both ways (`src/lib/protocolBridge.js`), so every provider type serves every route: Codex on Anthropic providers, Claude Code on Groq/OpenRouter/Ollama, Kiro on `/v1/chat/completions`
3. **Kiro credit budget enforcement** — an account past its `creditBudget` is refused with 402 before spending, and auto-fallback hands over to an account with room
4. **Per-model routes + force route** — one model id can go to a different provider than its tool's slot, optionally renamed upstream (`claude-sonnet-5` → aeorlink as `claude-sonnet-4-5-20250929`); `"*"` forces every model onto one target so the dashboard decides what actually runs, and `exempt` keeps a model id out of that force route (dashboard: Routing → Model overrides; API: `GET`/`POST /admin/routing/models`)
5. **Model verification** — detects if provider responds with a different model than requested (bait-and-switch detection)
6. **Token tracking** — input/output/cache_read/cache_write per request; Kiro rows are marked `~` because Kiro reports no token counts at all (estimate at ~4 chars/token)
7. **Cost estimation** — approximate $ per request at Anthropic list rates for known Claude families; an unrecognised model shows `—` rather than a guessed price
8. **Model alias mapping** — Claude Code dated names auto-resolved (claude-sonnet-4-20250514 → claude-sonnet-4.5)
9. **Auto /v1 detection** — base URL auto-corrected if user doesn't add /v1
10. **Enable/Disable** — per-provider toggle, disabled providers don't route
11. **Manual model add** — when /models endpoint fails, add models manually
12. **Request logs** — live log page with latency, tokens, cost, model verification
13. **Spend tracking** — permanent append-only record (`data/spend.jsonl`, written from `logRequest`), monthly totals by project / provider / model / tool / client at `/admin/spend`; project attribution from Codex's workspace metadata, Claude Code's working directory, or an `x-agentos-project` header

## Running

```bash
npm install
npm start         # port 9000
npm run dev       # with --watch
npm test          # 44 unit tests (node --test) + 27 integration checks
```

## Dashboard Presets

Quick-add: OpenRouter, Requesty, Groq, Together, Ollama, Anthropic

## Design Principles

- No OAuth — API key auth only
- No build step — inline HTML dashboard
- No external dependencies beyond express
- No cache layer — passthrough proxy
- MIT licensed, open-source ready
