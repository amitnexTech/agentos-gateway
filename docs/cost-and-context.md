# Cost & Context Visibility — Kiro credits, token estimation, model-swap detection

How the gateway measures spend and context usage, and how it catches a provider quietly serving a cheaper model than requested.

**Status:** v1.0 COMPLETE

## Kiro cost & context (2026-08-01)

Input is the cost driver on Kiro. The protocol keeps no server-side conversation state, so `buildKiroConversation` re-sends the full history every turn and Kiro bills the whole payload again. Measured on a real 51-minute session: **~83 credits/hour**, and a fixed-shape 5-output-token request climbed 0.116 → 0.321 cr as history grew, then reset when a new conversation started.

The Kiro routes used to log `input_tokens: 0`, which hid exactly this. Now:

- `src/kiro/tokens.js` — `measureKiroPayload()` measures the outgoing payload (`inputTokens` at ~4 chars/token, `historyEntries`, `payloadChars`). Rough by design: it shows growth and scale, not a bill.
- `contextUsagePercent` — Kiro's own context-window figure. It was already being parsed and then **discarded**; it now reaches `logRequest` and the log page shows it as a bar with the re-sent turn count underneath. This answers "how full is the context window".
- Tool-call JSON now counts as output tokens (`stream.js`, `codexStream.js`). Previously only text deltas counted, so tool-only turns reported `output_tokens: 0` — 30% of a measured session's spend looked free.
- The `$ cost` column on Kiro is an **analogy** at Anthropic list rates, useful for making input cost legible. `kiroCredits` is the real spend.

Spending less is behavioural, not a code fix: fewer turns, `/clear` more often, and don't route Claude Code's tiny utility calls (38% of requests) to an expensive account.

**Known gap:** the `kiro` provider path estimates tokens at ~4 chars/token rather than counting them (Kiro reports no token counts at all), so `tps` and `cost` are approximations there. Anthropic-compat providers are unaffected — their usage comes straight from upstream.

## Prompt caching on Kiro — measured, then rejected (2026-08-01)

Kiro's wire protocol does support prompt caching, so the obvious idea is to map Claude Code's `cache_control` breakpoints onto it and stop paying for the re-sent history. Measured with `scripts/kiro-cache-probe.mjs` (7 real requests, identical ~15k-token prefix, `claude-sonnet-4.5`, byte-identical 125 KB payloads) it does **not** pay:

| variant | credits |
|---|---|
| `cachePoint`, first request (cache write) | **0.137617** |
| `cachePoint`, same `conversationId`, 2nd and 3rd | 0.072828 |
| no `cachePoint`, fresh `conversationId` each time (today's gateway) | 0.072828 |
| no `cachePoint`, same `conversationId` reused | 0.072828 |

Every non-write request costs **exactly** the same to six decimals. So on Kiro:

- `cachePoint: { type: "default" }` is accepted (no `ValidationException`) on `userInputMessage`, on `assistantResponseMessage`, and as an entry in the `tools` list — `CachePointType` has one value, `default`.
- A cache write costs **~1.9x**, and the read that follows gets **no discount at all**. Adding cache points would raise the bill, not lower it.
- Reusing one `conversationId` across turns changes nothing, so the gateway minting a fresh id per request costs nothing. (This was the leading hypothesis for "the gateway burns more than a native Kiro session" — it is disproven.)
- Credits are a deterministic function of payload size × the model's `rateMultiplier`; identical payloads bill identically. Nothing about cache state enters the meter.
- Kiro sends **no** token counts to API-key clients: no `uncachedInputTokens`, no `cacheReadInputTokens`. Only `{"unit":"credit","usage":<n>}` and `contextUsagePercentage`. That is why `measureKiroPayload()` exists.

The protocol shapes come from the Kiro CLI's own bundle (`~/.local/share/kiro-cli/kas/*/node_modules/@kiro/agent/dist/server/acp-server.js`): `UserInputMessage.{cachePoint, clientCacheConfig}`, `Tool.cachePoint`, `TokenUsage.{uncachedInputTokens, cacheReadInputTokens, cacheWriteInputTokens, contextUsagePercentage}`, and `GetProfile`'s `PromptCaching { supportsPromptCaching, minimumTokensPerCacheCheckpoint, maximumCacheCheckpointsPerRequest }`. Note the native CLI never sets `cachePoint` either — the string appears exactly once in a 20 MB bundle, in the schema name table.

**Gateway vs native Kiro session:** structurally identical. The native client's `buildConversationState` splits history/`currentMessage` the same way, attaches tools only to the last message, and re-sends everything every turn — its own log line reads `Request payload: 257538 chars, 42 history messages`. The gateway adds no per-turn overhead; higher spend through it comes from *what the client sends* (Claude Code's larger prompt plus its 38% share of tiny utility calls), not from the translation.

## Model swap detection (2026-07-26)

A reseller that quietly serves a cheaper model **echoes back the model name you asked for**, so comparing names proves nothing on its own. Name comparison only catches careless proxies — the behavioural signals below are what actually decide it.

`src/config/logStore.js`:

- `normalizeModel()` — collapses date suffixes and `.`/`_`/`-` differences before comparing, so `claude-opus-4.8` vs `claude-opus-4-8` is no longer a false alarm.
- `tps` — output tokens per second. **The real detector**: a model's generation speed cannot be faked. A sudden 2x+ jump over baseline means a cheaper model ran.
- `rawModel` — what the client asked for, before alias mapping. Without this you cannot tell whether a mismatch came from the gateway's own alias map or from the provider. (Alias mapping is now Kiro-only — see [[kiro-integration]] — so non-Kiro providers forward the raw id untouched.)
- `responseId` — real Anthropic ids look like `msg_01…`; a synthetic shape means a proxy generated the envelope itself.

The anthropic-compat path captures `rawModel` (in `src/routes/anthropic.js`) plus `responseModel`/`responseId`/`usage` — streaming via `src/lib/anthropicSse.js` (line-buffered SSE sniff), non-streaming inline. `src/routes/logPage.js` shows a `tok/s` column and the id under the model cell.

**Detection lesson:** output token count on a fixed prompt at temperature 0 is the cheapest and most decisive swap signal, ahead of tok/s. Short probe bursts prove nothing — see [[provider-findings]] for the Lumosel case where the first 8 probes found no swapping and only a long series caught it. Never truncate upstream error bodies; real backend-chain leaks (see [[provider-findings]]) came from error text a probe had cut at 120 chars.

## Related

- [[index]]
- [[kiro-integration]]
- [[provider-findings]]
- [[fallback-and-verification]]
