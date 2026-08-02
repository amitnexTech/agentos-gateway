# Kiro Integration — Kiro provider, accounts, auth, model aliasing, ksk_ API keys

How the Kiro (AWS CodeWhisperer) provider type authenticates, manages accounts, and talks its own wire protocol under an Anthropic-shaped API.

**Status:** v1.0 COMPLETE

## Auth model

Kiro auth is via a plain `ksk_...` API key generated at app.kiro.dev → Account → API Keys — no SQLite/OIDC token juggling in the Node gateway. This replaced an older Python proxy that needed OIDC tokens from the kiro-cli SQLite database (`~/kiro-accounts`, `~/.aws/sso/cache/kiro-auth-token.json`); that mechanism and its proxy are fully retired.

A grep across `src/` for `sqlite`, `sso`, `oidc`, `kiro-cli`, `refreshToken`, `credentials.json`, `bearerToken`, `accessToken`, `start_url`, `deviceCode` returns exactly one hit — a comment in `src/kiro/config.js` explaining the header set was reverse-engineered from kiro-cli traffic. There is no token refresh, no sqlite read, no OIDC anywhere. Auth is purely `Authorization: Bearer ksk_...` plus the mandatory `tokentype: API_KEY` header, `origin: KIRO_CLI`, and `AmazonQ-For-CLI` User-Agent strings, against `runtime.{region}.kiro.dev` for chat and `management.{region}.kiro.dev` for `ListAvailableModels` / `GetProfile`.

## Account management

`src/routes/kiroAccount.js` + inline dashboard script in `src/routes/adminPage.js`:

- `POST /admin/kiro/account` — add account from API key; key is validated via `getProfile()`, `profileArn` identifies the account, duplicate `profileArn` is rejected 409, model list fetched live, raw key stored in envStore under a generated `AGENTOS_KEY_*` ref
- `PUT /admin/kiro/account/:id` — edit name, edit creditBudget (null clears it), resetCredits, rotate apiKey (rotation rejects a key belonging to a different profileArn)
- `DELETE /admin/kiro/account/:id` — deletes provider + stored key; `deleteProvider` also strips the provider from routing slots and drops its model bindings
- `GET /admin/kiro/accounts` — list with usedCredits / creditBudget / usedPercent / hasKey / status

Dashboard UI exposes Edit (name + budget via prompts), Replace key, Reset credits, and Delete per account row. Multiple Kiro accounts are supported side by side, each identified by its own `profileArn`.

**Known gap:** `creditBudget` is decorative. It is only read in `routes/kiroAccount.js` and `routes/adminPage.js` — no check exists anywhere in the proxy request path (`routes/proxy.js`, `routes/anthropic.js`, `routes/responses.js`), so an account past its budget keeps serving requests. Tied to the missing cross-account failover — both touch the same code path and are agreed to be done together. See TrailMem #179.

## Model aliasing

Model-id aliasing (dated Claude names like `claude-sonnet-4-20250514` → Kiro's short catalog names like `claude-sonnet-4.5`) is Kiro-only and lives in `src/kiro/client.js`. Non-Kiro providers receive the raw model id the client sent, untouched — this used to be a shared alias map but was narrowed to Kiro-only once it became clear other providers should never have their model ids rewritten underneath them.

`kiroModelCandidates(model)` returns the candidate catalog ids in decreasing fidelity and `lookupModelForTool` keeps the first one the account actually advertises, so an exact match is never guessed away. It peels, in order:

1. an explicit `MODEL_ALIASES` entry (only where stripping does not produce a real catalog name),
2. a trailing capability marker in brackets — e.g. `claude-sonnet-5[1M]`, the form `CLAUDE_CODE_SUBAGENT_MODEL` is written in. **Measured 2026-08-02: Claude Code does not put that suffix on the wire** — a real session with `CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-5[1M]"` sent the id as plain `claude-sonnet-5` on all 200 logged requests (most likely translated into a context-1m beta header instead). So this step is insurance for clients that do send it, not a fix for a live 404. Routes must be keyed on `claude-sonnet-5`; a route on the bracketed string never matches.
3. the `-YYYYMMDD` date suffix,
4. Anthropic's dashed version style — `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5` → `claude-sonnet-4.5`, which is the spelling Kiro uses.

Verified against a real Kiro catalog: `claude-sonnet-5[1M]` → `claude-sonnet-5`, `claude-sonnet-4-5-20250929[1M]` → `claude-sonnet-4.5`, `claude-haiku-4-5-20251001` → `claude-haiku-4.5`, and `gpt-5` → no match (404, nothing sent — the ban-risk gate).

**Open oddity:** `gpt-5.6-luna` and `gpt-5.6-terra` served real replies through the Kiro provider during Codex testing (one 400'd "Input content length exceeds threshold"). Kiro is supposed to be Claude-only, so something is being silently substituted upstream — not yet investigated.

## Codex protocol translation

`src/kiro/codexConverter.js` translates the OpenAI Responses API directly into Kiro's payload shape (no Anthropic detour). See [[architecture]] for the Codex wire-format details (tool locations, `additional_tools`, `namespace` tools skipped).

## Connect timeouts — Happy Eyeballs

Repeated `Kiro API error ... connection timed out` at a consistent ~765ms latency was not a provider outage. Node's Happy Eyeballs algorithm gives each candidate address 250ms to finish its TCP handshake before racing the next one; every AWS address behind `runtime.us-east-1.kiro.dev` needs ~310–400ms from this network, so no address ever won inside the default budget and Node rejected with `AggregateError [ETIMEDOUT]` after walking the whole candidate list.

Fix: `src/server.js` raises the attempt timeout via `setDefaultAutoSelectFamilyAttemptTimeout(2000)` (override with `AGENTOS_CONNECT_ATTEMPT_TIMEOUT_MS`). Measured effect on healthy requests: 2560ms → 321ms. A ~765ms "timeout" is the fingerprint of this specific bug, not of a slow provider — check for it before assuming an outage.

`src/lib/netError.js` maps connect-level failures (`ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`, …) to readable `ApiError`s. Before this, they reached the express handler as an `unhandled error` with a full undici stack per failed request, were invisible in the request log, and could not trigger auto-fallback (which only retries an `ApiError`). Genuine bugs still keep their stack trace.

### Unroutable NAT64 addresses (2026-08-01)

Second half of the same failure mode. This host has **no IPv6 default route**, yet the resolver returns NAT64-synthesized AAAA records (`64:ff9b::…`) for `*.kiro.dev`. Node's default resolution order is `verbatim`, so it attempts those dead addresses first and each one consumes a connect attempt before IPv4 gets a turn. A failing run shows `AggregateError [ETIMEDOUT]` mixing `ENETUNREACH` on the `64:ff9b::` entries with `ETIMEDOUT` on the IPv4 ones. `curl -6` fails instantly, so only Node was affected — which is why the host looks perfectly reachable while every request dies.

Fix: `setDefaultResultOrder("ipv4first")` in `src/server.js`, alongside the attempt-timeout raise. Standalone scripts under `scripts/` need both lines themselves.

**The same bug hits the Kiro CLI**, which runs on bundled Node 22 and retries 3x — re-uploading a ~250 KB conversation each time and surfacing a bare `internal error`. Its logs (`~/.kiro/logs/*/kiro.log`) name it plainly: `Failed to stream response chunks (inputSize=251160, historyMessages=36) {"code":"ETIMEDOUT","attempts":3}`, plus matching `getProfile` / `listAvailableModels` / tool-discovery timeouts at startup. Both flags are accepted via env:

```bash
NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000" kiro
```

Since 2026-08-02 both flags are exported from `~/.zshrc`, so every Node process started from an interactive shell — CLI, Claude Code, the gateway — inherits them without a prefix.

#### Source of the NAT64 records: Tailscale MagicDNS

The synthesized AAAA answers come from Tailscale, not the ISP. `resolvectl status` shows a second DNS scope on `tailscale0` pointing at `100.100.100.100` (`CorpDNS=true`, no exit node), and Tailscale's DNS proxy is what returns `64:ff9b::` addresses this host cannot route. Nothing changed in Kiro or upstream — MagicDNS simply started fielding the lookups, which also explains the intermittency: when `tailscaled` cannot reach its coordination server, `resolvectl query --type=AAAA management.us-east-1.kiro.dev` returns no AAAA at all and the failures vanish.

`tailscale set --accept-dns=false` removes the NAT64 answers at the root, at the cost of tailnet hostname resolution. The `NODE_OPTIONS` flags fix the symptom without giving that up.

## Related

- [[index]]
- [[architecture]]
- [[security]]
- [[cost-and-context]]
