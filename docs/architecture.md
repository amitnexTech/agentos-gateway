# Architecture — gateway design, directory structure, provider types, key features

How AgentOS Gateway is put together: request flow, directory layout, provider types, and what it does out of the box.

**Status:** v1.0 COMPLETE

## Request flow

```
Claude Code ─→ localhost:9000/v1/messages    (Anthropic format)  ─→ routing["claude"] provider
Codex       ─→ localhost:9000/v1/responses   (OpenAI Responses)  ─→ routing["codex"] provider
Any OpenAI  ─→ localhost:9000/v1/chat/completions (OpenAI Chat)  ─→ routing["openai"] provider
Dashboard   ─→ localhost:9000/admin
Logs        ─→ localhost:9000/admin/logs
```

Each tool can use a different provider — or all the same. Switch in the dashboard dropdown, no restart needed for routing changes. Dashboard UI edits (`src/routes/*Page.js`, `layoutTemplate.js`) DO need a gateway restart — the modules are loaded once at boot (see `CLAUDE.md`).

The dashboard is split into one page per concern, sharing a left-sidebar shell from `layoutTemplate.js`: `/admin` (overview), `/admin/routing-panel`, `/admin/providers-panel`, `/admin/logs`, `/admin/spend`, `/admin/kiro`. The JSON APIs keep their original paths — `GET /admin/routing` and `GET /admin/providers` still return JSON, which is why the pages live on `-panel` URLs rather than taking those over. `/admin/classic` still serves the previous single-page dashboard as a rollback.

## Directory structure

```
src/
├── server.js              # Entry point
├── app.js                 # Express app setup
├── registry.js            # Adapter registry + factory
├── routes/
│   ├── admin.js           # Dashboard API + routing + provider CRUD
│   ├── layoutTemplate.js  # Shared shell: sidebar nav + common CSS for every page
│   ├── dashboardPage.js   # /admin — overview
│   ├── routingPage.js     # /admin/routing-panel — slots, force route, overrides, profiles
│   ├── providersPage.js   # /admin/providers-panel — provider CRUD + model selection
│   ├── logsPage.js        # /admin/logs — request log
│   ├── spendAnalyticsPage.js # /admin/spend — monthly tokens/cost
│   ├── kiroPage.js        # /admin/kiro — Kiro account management
│   ├── adminPage.js       # /admin/classic — the old single-page dashboard (rollback)
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
│   ├── tokens.js          # Outgoing payload measurement (chars→token estimate, history size)
│   ├── api.js              # Kiro header construction + management-plane calls
│   └── config.js          # Kiro hosts, regions, x-amz-target constants
├── config/
│   ├── keysStore.js        # Provider + model + routing registry (keys.json)
│   ├── envStore.js         # Secrets store (data/.env)
│   ├── usageStore.js       # Request/token tracking
│   └── logStore.js         # Request log (last 200, persisted to logs.json)
├── adapters/
│   ├── base.js             # Abstract adapter
│   ├── openaiCompat.js     # OpenAI-compatible providers
│   ├── anthropicCompat.js  # Anthropic-compatible providers (passthrough /v1/messages)
│   ├── localOpenAI.js      # Local providers (no auth)
│   └── kiro.js             # Kiro adapter (URLs/headers; protocol handled by kiro/)
├── lib/
│   ├── proxyExecute.js     # Shared upstream fetch + optional timeout + error map + SSE headers
│   ├── fetchTimeouts.js    # Disables undici's own 300s headers/body timeout (the second five-minute wall)
│   ├── anthropicSse.js     # Anthropic SSE passthrough + model/usage extraction
│   ├── stream.js           # Generic OpenAI SSE stream piping
│   ├── errors.js           # Error handling
│   ├── netError.js         # Connect-level failure → readable ApiError mapping
│   ├── modelFetch.js       # Auto-fetch models (with /v1 auto-detection)
│   ├── upstreamError.js    # Upstream error extraction
│   ├── providerProbe.js    # Provider health check
│   └── adminAuth.js        # Dashboard HTTP-Basic auth (admin token)
data/                        # Runtime data (gitignored)
├── keys.json                # Provider + routing config
├── .env                      # API keys (secrets)
├── logs.json                 # Request log (last 200, survives restart)
└── usage.json                 # Usage stats
```

## Provider types (4)

| Type | Use For | Auth |
|------|---------|------|
| `openai-compat` | OpenRouter, Requesty, Groq, Together, any OpenAI-format API | API key |
| `anthropic-compat` | Anthropic direct, Lumosel, any Anthropic-format API | API key |
| `local-openai` | Ollama, LM Studio, llama.cpp | None |
| `kiro` | Kiro (AWS CodeWhisperer) via `ksk_` API key — Anthropic-shaped requests over its own wire protocol | API key |

A `kiro` provider is reachable only via the `claude` (`/v1/messages`) and `codex` (`/v1/responses`) slots — its protocol is not OpenAI chat, so the `openai` slot rejects it. Model-id aliasing (dated Claude names → Kiro's short catalog names) is Kiro-only and lives in `kiro/client.js`; non-Kiro providers receive the raw model id the client sent, untouched. See [[kiro-integration]] for the full Kiro picture and [[codex-integration]] for how `/v1/responses` is served for the other three types.

## Adapter class hierarchy (`src/adapters/`)

Every provider type maps to an adapter class via a flat registry (`src/registry.js`):

```js
const REGISTRY = {
  "openai-compat": OpenAICompatAdapter,
  "anthropic-compat": AnthropicCompatAdapter,
  "local-openai": LocalOpenAIAdapter,
  "kiro": KiroAdapter,
};
```

All adapters extend the abstract `ProviderAdapter` (`src/adapters/base.js`), which defines the contract every route relies on: `getRequestUrl(model, options)`, `getRequestHeaders(options)`, `translateRequest(body)` / `translateResponse(body)` (both identity by default — only overridden where a provider's shape differs), `translateStreamChunk(rawLine)` (parses one SSE `data:` line), and `getModelsUrl()` / `translateModelsResponse(body)` (normalizes OpenAI `{data:[{id}]}`, Gemini `{models:[{name}]}`, and bare-array model-list shapes).

Per-type specialization is intentionally thin:

- `OpenAICompatAdapter` — only overrides `getRequestUrl` → `${baseUrl}/chat/completions`. Everything else (headers, translation, model-list parsing) is inherited from the base as-is.
- `LocalOpenAIAdapter extends OpenAICompatAdapter` — same URL, but `getRequestHeaders()` drops the `Authorization` header entirely (Ollama/LM Studio need no auth).
- `AnthropicCompatAdapter` — overrides `getRequestUrl` → `${baseUrl}/messages`, and `getRequestHeaders({anthropicVersion})` to send both `x-api-key` and (if present) `Authorization: Bearer`, plus the client's own `anthropic-version` header value forwarded through rather than hardcoded — this is how `/v1/messages` passthrough preserves the exact protocol version Claude Code asked for. `translateModelsResponse` reads Anthropic's `{data:[{id}]}` shape.
- `KiroAdapter` — the odd one out. Its `baseUrl` is not user-supplied; the constructor derives it from `region` via `getRuntimeHost(region)` (`src/kiro/config.js`). `getRequestUrl` always returns the runtime host's root path (`${baseUrl}/`) — Kiro has one chat endpoint, not a per-model or per-action path. `getRequestHeaders()` delegates to `chatHeaders(apiKey)` in `src/kiro/api.js` for the full reverse-engineered header set (see [[kiro-integration]]). It also exposes `fetchModels()` and `getProfile()`, management-plane calls the other three adapter types don't need because their model lists come from a plain `/models` GET.

None of the four adapter classes do request/response *protocol* translation on their own — that logic lives in the routes (`anthropic.js`, `responses.js`), in `src/lib/protocolBridge.js` for the OpenAI↔Anthropic pairings, and in `src/kiro/converter.js` / `codexConverter.js` / `stream.js` / `codexStream.js` for Kiro. The four base adapters only know how to reach the provider (URL + headers + auth) and how to speak its *native* shape when one is forwarded directly (Chat Completions for openai-compat/local-openai, Messages for anthropic-compat).

**Two bridged variants exist on top of them** (`src/adapters/bridge.js`): `chatOverAnthropic(Base)` and `anthropicOverChat(Base)` are mixins that override only `translateRequest` / `translateResponse` and set a `bridge` marker the routes read to pick a streaming pipe. They are mixins rather than fixed subclasses so a bridged adapter keeps its base's URL and headers — `anthropicOverChat(LocalOpenAIAdapter)` must keep the *no-auth* headers. `createAdapter(provider, { speaks })` applies one when the calling route's protocol differs from the provider's; see [[protocol-bridge]].

## Provider resolution: tool slots → provider → adapter

A slot can be pointed at any provider whose protocol that route either speaks natively or can be translated into. This mirrors the execution paths, it is not a policy:

| slot | route | provider types | native | via [[protocol-bridge]] |
|---|---|---|---|---|
| `claude` | `/v1/messages` | `anthropic-compat`, `kiro`, `openai-compat`, `local-openai` | `anthropic-compat`, `kiro` | `openai-compat`, `local-openai` |
| `codex` | `/v1/responses` | `kiro`, `openai-compat`, `local-openai`, `anthropic-compat` | `kiro`, `openai-compat`, `local-openai` | `anthropic-compat` |
| `openai` | `/v1/chat/completions` | `openai-compat`, `local-openai`, `anthropic-compat`, `kiro` | `openai-compat`, `local-openai` | `anthropic-compat`, `kiro` |

Every pairing has a real path now. Kiro is the indirect case on the `openai` slot: it accepts Anthropic-*shaped* input over its own transport, so the chat body is bridged to Anthropic Messages first and then handed to Kiro's own converter (see [[kiro-integration]]).

`toolSupportsProviderType(tool, type)` in `keysStore.js` owns the table; `setToolProvider`, `setAllToolsProvider` (which skips unsupported slots and reports them) and `setModelRoute` all refuse an unsupported pairing, all three routes re-check at request time, and the dashboard only offers compatible providers — an already-configured incompatible slot still shows, labelled *cannot serve this route*, rather than silently reading as `(none)`.

**Why the enforcement exists (measured 2026-08-02).** The restriction was documented but never enforced, and an `anthropic-compat` provider on the wrong slot failed in the two worst possible ways:

- `/v1/chat/completions` → the OpenAI-shaped body was posted to `/messages` with no `max_tokens`, which a real provider answers with `400 max_tokens: field required`.
- `/v1/responses` → the same mismatched body went upstream, the Anthropic-shaped reply had no `choices`, and `chatToResponsesFormat` produced **HTTP 200 with `output: []`** — an empty answer that looks like a completed turn. Exactly the silent-success class of failure [[fallback-and-verification]] exists to prevent.

Both pairings are now *translated* rather than refused (see [[protocol-bridge]]), and both of those failure modes are covered by explicit checks. Anything still outside the table fails fast with a message naming the provider, its type, and the types the route needs.


Routing is not per-request — it is a fixed assignment stored in `data/keys.json`, resolved once per incoming request:

```
routing     = { claude: "provider-xxx", codex: "provider-yyy", openai: "provider-zzz" }
modelRoutes = { claude: { "*":                   { providerId, model },   // force route
                          "claude-sonnet-5":     { providerId, model },   // one model
                          "claude-sonnet-5[1M]": { exempt: true } } }     // opted out
```

`src/config/keysStore.js` owns this file and exposes the three tool slots as a constant (`TOOL_SLOTS = ["claude", "codex", "openai"]`). Each of the three protocol routes resolves its own provider independently:

- **`/v1/messages`** (`anthropic.js`) and **`/v1/responses`** (`responses.js`) call `lookupModelForTool(tool, rawModel)` from `src/kiro/client.js` — a Kiro-aware resolver that applies date-suffix model aliasing and the strict "model must be configured on this provider" gate **only** when the resolved provider is `kiro`; any other provider type receives the raw model id untouched (#171 item 3).
- **`/v1/chat/completions`** (`proxy.js`) uses the same `lookupModelForTool("openai", rawModel)` as the other two routes (it used to have its own `lookupProviderForTool` + relaxation block, which is gone). So all three slots now behave identically: a per-model override or force route wins over the slot, the id may be rewritten on the way upstream, a non-Kiro provider receives the raw id untouched even if it is not in the configured list (#171 item 3), and a Kiro provider gets its catalog aliasing plus the strict "must be a configured id" gate that exists because sending Kiro an unknown id is a ban risk.
- Once a `provider` record is resolved, `createAdapter(provider, { speaks })` (`src/registry.js`) looks up the class, reads the provider's API key out of `data/.env` via `envGet(apiKeyRef)` (throwing `MissingSecretError` if absent, except for `local-openai` which is allowed to have none), and constructs the adapter — passing `region` for Kiro, `baseUrl` for everything else. `speaks` is the protocol of the *calling route* (`"openai-chat"` or `"anthropic-messages"`); when it differs from the provider's own, the adapter is wrapped in a translation mixin from `src/adapters/bridge.js`. See [[protocol-bridge]].

### Per-model routes (override a slot for one model id)

A tool slot binds **one** provider, so every model that tool asks for lands on the same account. That is expensive: Claude Code sends its small background calls under a *different model id* than the real work — measured 64 of 200 requests on `claude-sonnet-5` while the work ran on `claude-opus-5`, 20% of the credits, each of those carrying the full ~140 KB history for a 5-token answer.

`modelRoutes[tool][clientModelId] → { providerId, model }` overrides the slot for exactly that model id, and `model` is what gets sent upstream. The rewrite exists because no two catalogs name a model the same way:

```
Claude Code sends   claude-sonnet-5
OpenRouter serves   anthropic/claude-3.5-sonnet
Lumosel serves      claude-sonnet-4-5-20250929
Kiro serves         claude-sonnet-4.5
```

The mapping is **explicit and user-chosen, never guessed**. Deriving it from fetched model names would silently serve a different model than the client asked for — precisely what the swap detection in [[cost-and-context]] exists to catch. A bare string value (`modelRoutes.claude["x"] = "provider-y"`) is still accepted as the "same id, different provider" shorthand.

Three special forms:

| key / value | meaning |
|---|---|
| `"*": { providerId, model }` | **force route** — every model id without an exact entry goes here. This is how the dashboard, not the agent's config file, decides which model actually runs. A force route must name its target: there is no client id to fall back on. |
| `{ exempt: true }` | opts one model id **out** of the force route: tool's own provider, client's own id, no substitution. |
| `"provider-x"` (string) | legacy shorthand for "same id, different provider". |

Exact entries always beat `*`.

**Why `exempt` exists:** Claude Code does not run on one model. Its subagents use `CLAUDE_CODE_SUBAGENT_MODEL` and auto mode runs a two-stage tool-approval classifier of its own (`CLAUDE_CODE_AUTO_MODE_MODEL`, `CLAUDE_CODE_BG_CLASSIFIER_MODEL`, visible as `querySource: "auto_mode"` and `classifierStage: xml_s1`/`xml_s2` in the CLI binary). A force route that swallows those ids too can break auto mode, so each one can be exempted while everything else is forced.

**Measured 2026-08-02 (real session, 200 logged requests):** Claude Code sent exactly **two** ids — `claude-opus-5` for main turns and `claude-sonnet-5` for **both** subagents and the auto-mode classifier. `CLAUDE_CODE_AUTO_MODE_MODEL` / `CLAUDE_CODE_BG_CLASSIFIER_MODEL` were unset and the classifier reused the subagent id; the `[1M]` suffix never reached the wire. Two consequences worth knowing before configuring anything:

- **Subagent and classifier cannot be routed separately** — same id. They are only distinguishable by shape: a classifier call is `output_tokens: 5` with `historyEntries: 2` and ~30k input tokens; subagent calls have varied output and 1–6 history entries. Routing decisions therefore apply to both at once.
- **Auto mode is expensive.** The classifier re-sends the full ~30k-token conversation on *every* tool call to emit a 5-token verdict: 13 classifier calls cost 2.0 Kiro credits, and the session burned ~2.3 cr/min against a ~1.4 cr/min baseline. Read-only tools skip the classifier (Claude Code says so itself); shell and write tools do not. Also confirmed causally: when the `claude-sonnet-5` upstream reset, Claude Code refused a Bash call with "claude-sonnet-5 is temporarily unavailable, so auto mode cannot determine the safety of Bash right now" — the client naming its own classifier model.

Since `claude-sonnet-5` accounted for 7.6 of that run's 18.1 credits (42%), moving that one id to a cheaper account is the single largest routing lever available.

Related: `kiroModelCandidates()` in `src/kiro/client.js` peels the decorations clients add before matching Kiro's catalog — alias, a trailing `[1M]`-style capability marker, the `-YYYYMMDD` date suffix, and Anthropic's dashed version style. That is what lets `claude-sonnet-5[1M]` reach `claude-sonnet-5` and `claude-sonnet-4-5-20250929` reach `claude-sonnet-4.5` on a Kiro account instead of 404ing.

The override is checked **before** `routing[tool]` in both `lookupModelForTool()` and `proxy.js`, and then follows the same rules as a bound provider: must exist, must be enabled, and a Kiro target still has to be in that account's configured model list (an override cannot smuggle an unconfigured id past the ban-risk gate). An override pointing at a disabled or deleted provider silently falls back to the slot's default — `deleteProvider()` purges overrides along with the routing entry, and a `kiro` provider is refused on the `openai` slot here too.

Because the client id and the upstream id are tracked separately, `logRequest` records `rawModel` (asked) and `model` (sent) — and `modelMismatch` compares the response against `model`, so a deliberate rewrite never trips the swap alarm.

Dashboard: the **Routing** panel now has two dropdowns per slot — *provider*, then *Model*. **The Model dropdown IS the force-route toggle**, and a line underneath now says which of the two modes is live: *Forced: every request runs X — /model is ignored*, or *Client decides: /model is forwarded as-is*. It also flags the one measurable trap of the second mode: if the slot provider serves a **single** model, forwarding the client's own id means every other id is rejected upstream (measured: `403 This token has no access to model claude-sonnet-5` from a router selling only `moonshotai/kimi-k3-free`), so a single-model provider needs the force route rather than *(client decides)*. The Model list holds only that provider's own models plus `(client decides)`; picking one writes the `"*"` force route. If a force route deliberately points at a *different* provider than the slot (set from Model overrides), the dropdown says so and disables itself rather than showing a value that is not in effect. Changing a slot's provider drops a force route that belonged to the old provider — otherwise the dropdown would name one account while traffic kept going to another.

**Routing → Model overrides** holds the exceptions: *Tool → Provider → Provider's model → Client asks for*. Pick the account first and the model dropdown narrows to that provider's catalog, so an unavailable id cannot be chosen. The client-id field is free text (a client may send an id no provider advertises) and auto-fills from the chosen provider model. Two checkboxes cover the special forms: *Force all models (\*)* — the same thing the slot's Model dropdown does — and *Exempt this id from the force route*. An override whose provider is disabled or deleted is still listed, marked unavailable, because a silently ignored override is worse than a visible broken one.

> **Exempt is not "leave this model working".** It means "use the slot's own provider with the client's own id". If that provider does not serve the id, the call fails. Measured on a real config: with the `claude` slot on a router that only sells `moonshotai/kimi-k3-free`, exempting `claude-sonnet-5` produced `403 This token has no access to model claude-sonnet-5`. The dashboard now flags this — an exempt row whose slot provider does not cover the id renders in red (`will 404` for Kiro, which is strict; `may be rejected` for passthrough providers, which forward unlisted ids and let upstream decide). For Claude Code's background models the working answer is usually an explicit override to a provider that serves them, not `exempt`.

**Model ids clients actually asked for** (`GET /admin/routing/seen`) lists the distinct ids in the request log per tool, with hit counts and whether a route already exists; clicking one loads it into the override form. This exists because the ids that matter most are the ones nobody documents — an agent's subagent model, its background/classifier model — and a route built on a guessed id silently never matches. Run a session, read the list, then route what actually arrived.

Same thing over the API:

```bash
curl -su any:$TOKEN localhost:9000/admin/routing/models
# route (and rename) one model
curl -su any:$TOKEN -X POST localhost:9000/admin/routing/models -H 'content-type: application/json' \
  -d '{"tool":"claude","model":"claude-sonnet-5","providerId":"provider-xxx","targetModel":"claude-sonnet-4-5-20250929"}'
# force everything onto one model
curl -su any:$TOKEN -X POST localhost:9000/admin/routing/models -H 'content-type: application/json' \
  -d '{"tool":"claude","model":"*","providerId":"provider-xxx","targetModel":"moonshotai/kimi-k3-free"}'
# keep Claude Code's subagent model out of the force route
curl -su any:$TOKEN -X POST localhost:9000/admin/routing/models -H 'content-type: application/json' \
  -d '{"tool":"claude","model":"claude-sonnet-5[1M]","exempt":true}'
# providerId null -> clear the entry
```

Caveat: an exact override keys on the model id alone, so if a client's *main* model is ever the same id as its background model, the real work follows the override too.

`getEnabledModels()` (used by the dashboard) unions the model lists of whichever providers are currently assigned to any of the three routing slots **or reachable through a per-model override** — a model not bound to any active provider is invisible even if some other, unrouted provider supports it.

`GET /v1/models` answers **per caller**, not per gateway (`reachableModels()`, added 2026-08-05). One endpoint serves all three protocol routes, so it used to hand a Claude Code client the models of whatever provider the `codex`/`openai` slots happened to use — measured on a live config: 12 ids advertised, 11 owned only by the other slots' provider and unreachable on `/v1/messages`. The caller's slot is inferred from its user-agent (`toolFromRequest`), and:

- **inside a session profile** → exactly that profile: its pinned model, or its provider's catalog when nothing is pinned;
- **no force route** → the slot provider's catalog plus any client ids made reachable by a per-model override. This is the case that matters: with *(client decides)* the client's own id is what goes upstream, so an id the provider does not serve is a 403/404 from the provider;
- **force route active** → the old union, deliberately. Every id is rewritten to the forced model, so every id genuinely *is* accepted, and a shorter list would be both less truthful and risky — Claude Code checks its configured model against this endpoint and can refuse before sending anything;
- **unrecognised client** → the union, because a superset beats a wrong guess.

### Session profiles (per-session, not per-gateway)

Both mechanisms above are global: every session on the machine follows the same slot and the same force route. A **session profile** is that pairing scoped to one session, selected by the base URL the session was started with (`ANTHROPIC_BASE_URL=http://localhost:9000/p/backend`), which is what makes parallel sessions on different models possible. It resolves inside the same `lookupModelForTool()` funnel, above `modelRoutes` and below `exempt`. See [[session-profiles]].

## Upstream execution: `callUpstream` / `callUpstreamWithFallback`

All three protocol routes funnel their actual upstream HTTP call through `src/lib/proxyExecute.js` rather than calling `fetch` inline — this is shared plumbing, not per-route logic:

- `callUpstream(...)` builds the request from the adapter (`getRequestUrl`, `getRequestHeaders`, `translateRequest`), and on failure maps the error uniformly: connect-level failures (`ENOTFOUND`, `ETIMEDOUT`, etc.) go through `networkErrorToApiError` (see [[kiro-integration]] for why this mapping mattered), non-2xx responses go through `upstreamErrorMessage` and are mapped to specific `ApiError` status codes (401/403 → 502 "Upstream auth error", 429 → 429 "Upstream rate limit", other non-2xx → 502 or passthrough status). Every failure is logged via `logRequest` before the error is thrown, so failed attempts are visible in `/admin/logs` even though the request itself never succeeds.

  **No abort timeout by default (changed 2026-08-04).** It used to be a fixed 300s. Two facts made that worth removing: it only ever covered *time to response headers* — `clearTimeout` fires the moment the upstream answers, so a long stream was never affected — and a fixed abort is still the gateway ending a turn the client was willing to wait for. Set `AGENTOS_UPSTREAM_TIMEOUT_MS` to a positive number of milliseconds to arm it again (`upstreamTimeoutMs()` / `armTimeout()`, read per call). The Kiro path uses the same helper, so both paths behave identically.

  **The second five-minute wall: undici (found 2026-08-05).** Removing the gateway's own timer was not enough. Node's `fetch` is undici, which applies its **own** `headersTimeout` and `bodyTimeout`, both 300s by default — so a provider that takes longer than five minutes to send headers still failed, with `UND_ERR_HEADERS_TIMEOUT` instead of our error. It fired twice on this install on 2026-08-05 (302,972 ms and 303,838 ms) on a Kimi K3 route whose ordinary calls already reached 282 s. undici is bundled inside Node, not importable, and has no public API for these defaults, so `lib/fetchTimeouts.js` rebuilds the global dispatcher from its own constructor through the `Symbol.for("undici.globalDispatcher.1")` handle, guarded so a future Node that renames it degrades to stock behaviour with a warning. Same `AGENTOS_UPSTREAM_TIMEOUT_MS` knob; the startup banner prints the effective value.

  **Verified with the real CLI, not curl** (isolated gateway, fake upstream that withholds headers or goes silent mid-stream): 20 s header delay → Claude Code answers in 21 s; 40 s mid-stream silence → answers in 40 s; **150 s header delay → answers in 151 s, exit 0**. So the client is far more patient than the old 300 s ceiling suggested. And the decisive one: with the gateway timeout armed at 5 s against that 20 s upstream, Claude Code **silently retried 8 times** over more than two minutes with backoff and printed nothing at all — a gateway-side abort does not surface as an error, it surfaces as a hang. That is the strongest argument against a fixed timeout: waiting is visible progress, aborting is an invisible retry storm.
- `callUpstreamWithFallback(...)` wraps `callUpstream` with the opt-in auto-fallback behavior — see [[fallback-and-verification]] for the full fallback chain design. When fallback is off (the default) it behaves identically to a plain `callUpstream` call.

The Kiro path does not use `callUpstream` — it has its own `executeKiroWithFallback` in `src/kiro/client.js`, following the same fallback pattern but against Kiro's payload shape rather than a generic adapter body. See [[kiro-integration]].

## Codex wire format (`/v1/responses`)

Codex sends tools and the system prompt in **two possible shapes**, and both have been seen on the wire:

- **top level** — `tools: [...]` plus `instructions` as a string. Measured on 0.146.0 (2026-08-05): a plain `codex exec` run sent 10 tools this way.
- **as input items** — tools as `{type:"additional_tools", role:"developer", tools:[…]}`, and the system prompt, `AGENTS.md` and hook output as `role:"developer"` message items. This is what 0.145 sent.
- tool types include `custom` (freeform text input, e.g. `exec_command` — the code-mode tool that reaches shell and every MCP tool), `function`, and `namespace` (a GROUP of tools: every configured MCP server, plus `multi_agent_v1` for sub-agents)
- the `input` array can contain a literal `null` (observed 2026-08-05); the converter skips non-objects, so it is harmless

`kiro/codexConverter.js` reads both wire shapes (`collectCodexTools`), folds developer/system turns into user turns, and merges same-role neighbours. Freeform tools are advertised to Kiro as `{ input: string }` because Kiro's `toolSpecification` requires a JSON schema, then unwrapped on the way back into a `custom_tool_call` item with raw text. `namespace` tools are **hoisted** into the flat tool list and the reply restores `{namespace, name}` on the `function_call` item — see [[codex-integration]] for the shape, the naming rule and the per-turn cost. Skipping the type, as the converter did until 2026-08-03, stripped every MCP tool from the request.

Reading tools from only one shape is what left Codex able to chat but unable to call any tool at all (fixed 2026-07-29, see [[fallback-and-verification]] for the verification lesson this produced).

**Tool results must name their tool.** On the non-Kiro path a `function_call_output` becomes an OpenAI `role:"tool"` message. Codex sends the output with only `call_id`, `id`, `output` and `type` — no name — so `responses.js` keeps a `call_id → name` map from the `function_call` items in the same request and attaches `name` to the tool message. `name` is optional in the OpenAI spec, so this only ever adds information; it exists because Kimi K3 refuses what it cannot resolve: `400 Kimi K3 tool messages need a resolvable tool name: carry 'tool'/'name', or match a preceding assistant tool_call by order` (measured with the real Codex CLI, 2026-08-05 — the first turn worked and the tool-result turn failed).

## Key features

1. Per-tool routing — Claude Code, Codex, OpenAI tools each independently routed to any provider
2. Model verification — detects if a provider responds with a different model than requested (bait-and-switch detection); see [[fallback-and-verification]]
3. Token tracking — input/output/cache_read/cache_write per request
4. Cost estimation — approximate $ cost per request based on Anthropic pricing; see [[cost-and-context]]
5. Model alias mapping — Claude Code dated names auto-resolved (claude-sonnet-4-20250514 → claude-sonnet-4.5)
6. Auto /v1 detection — base URL auto-corrected if user doesn't add /v1
7. Enable/disable — per-provider toggle, disabled providers don't route
8. Manual model add — when /models endpoint fails, add models manually
9. Request logs — live log page with latency, tokens, cost, model verification
10. Auto-fallback — opt-in retry on retriable errors, across protocols via the bridge; see [[fallback-and-verification]]
11. Protocol bridge — OpenAI Chat ↔ Anthropic Messages both ways, so every provider type serves every route (Kiro included, via the Anthropic shape); see [[protocol-bridge]]
12. Kiro credit budget enforcement — an account past its `creditBudget` is refused with 402 before spending; see [[kiro-integration]]

## Design principles

- No OAuth — API key auth only
- No build step — inline HTML dashboard
- No external dependencies beyond express — including tests: `node --test` plus one plain script, zero devDependencies (see [[fallback-and-verification]])
- No cache layer — passthrough proxy
- No provider-specific adapters beyond the 4 types — openai-compat/anthropic-compat cover the rest
- No React dashboard
- MIT licensed, open-source ready

## Related

- [[index]]
- [[kiro-integration]]
- [[codex-integration]]
- [[session-profiles]]
- [[security]]
- [[cost-and-context]]
- [[fallback-and-verification]]
