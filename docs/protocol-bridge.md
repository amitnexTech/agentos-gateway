# Protocol Bridge — OpenAI Chat ↔ Anthropic Messages translation, cross-protocol routing

How any provider serves any route: the bidirectional mapping between OpenAI Chat Completions and Anthropic Messages, including streaming, what is deliberately dropped, what is refused outright, and how both directions were verified.

**Status:** v1.0 COMPLETE

## What it buys

Before this, a provider only worked on the route whose wire shape it already spoke, and the slot table refused every other pairing (see [[architecture]]). With the bridge in place:

- **Codex runs on `anthropic-compat` providers.** `/v1/responses` no longer needs a Kiro account, so Codex stops burning Kiro credits. This was the reason the bridge got built.
- **Any OpenAI-format client** (Cursor, Cline, Zed, Continue, aider, n8n, the OpenAI SDK) reaches Anthropic-format providers through the one `localhost` URL.
- **Claude Code runs on OpenAI-only providers** — Groq, OpenRouter, a local Ollama.
- **Per-model routes and the `"*"` force route work across protocols**, e.g. the `openai` slot forced onto an Anthropic provider's `claude-sonnet-5`.
- **The fallback pool widens**: any non-Kiro provider can back up any other on a slot it is allowed on, because the route consumes the *winner's* adapter, not the primary's.

**Kiro rides the bridge too.** It accepts Anthropic-*shaped* input over its own transport, so `/v1/chat/completions` reaches it by mapping the chat body to Anthropic Messages and handing that to `anthropicToKiro()` — see [[kiro-integration]]. All three slots therefore accept all four provider types.

## Where it lives

| file | role |
|---|---|
| `src/lib/protocolBridge.js` | all four mappings + the two streaming pipes |
| `src/adapters/bridge.js` | `chatOverAnthropic()` / `anthropicOverChat()` mixins |
| `src/registry.js` | `BRIDGES` table; `createAdapter(provider, { speaks })` picks a mixin |
| `src/config/keysStore.js` | `TOOL_PROVIDER_TYPES` — which pairings are allowed at all |
| `scripts/bridge-verify.mjs` | 27-check harness against fake upstreams |
| `scripts/bridge-live-probe.mjs` | same paths against a real provider |

**Mixins, not subclasses.** A bridged adapter must keep its base adapter's URL and headers: chat-over-anthropic still posts to `/messages` with `x-api-key`, and anthropic-over-chat must keep `local-openai`'s *no-auth* headers. Subclassing `OpenAICompatAdapter` directly would have sent a Bearer token to a local runtime that has no key. Each mixin is memoised per base class so `instanceof` still works.

**`speaks` is the route's protocol, not the provider's.** Each route names what *it* speaks — `proxy.js` and the standard branch of `responses.js` say `"openai-chat"`, `anthropic.js` says `"anthropic-messages"` — and `registry.js` wraps the adapter only when the provider speaks the other one. The request body stays in the inbound protocol all the way to `adapter.translateRequest()`, which is what lets auto-fallback hand the same body to a provider of either protocol mid-request.

**Streaming is not a per-line transform**, so it is not an adapter method. The routes select a pipe from the `bridge` marker: `pipeAnthropicSseAsChat()` or `pipeChatSseAsAnthropic()`.

## Direction 1 — OpenAI Chat → Anthropic Messages

Request (`chatToAnthropicRequest`):

| OpenAI | Anthropic |
|---|---|
| `system` / `developer` messages | top-level `system` blocks |
| `role: "tool"` message | `user` turn with a `tool_result` block keyed by `tool_call_id` |
| `assistant.tool_calls[]` | `assistant` turn with `tool_use` blocks, `arguments` JSON-parsed into `input` |
| `tools[].function.{name,description,parameters}` | `{name, description, input_schema}` |
| `tool_choice` auto/required/`{function:{name}}` | `{type:"auto"}` / `{type:"any"}` / `{type:"tool",name}` |
| `parallel_tool_calls: false` | `tool_choice.disable_parallel_tool_use: true` |
| `stop` | `stop_sequences` |
| `content` image_url (`data:` or `http(s)`) | `image` block with `base64` or `url` source |
| *(absent)* `max_tokens` | **4096 default** — Anthropic requires the field and OpenAI clients routinely omit it |

Consecutive same-role turns are merged, because splicing tool results in produces runs of `user` turns that Anthropic rejects.

`tool_choice: "none"` is the one conditional: the tool *definitions* are dropped entirely (widest compatibility) **unless** the history already contains `tool_use` blocks, in which case they are kept and `tool_choice: {type:"none"}` is sent — Anthropic rejects a conversation whose `tool_use` blocks have no matching definitions.

Response (`anthropicToChatResponse`): text blocks joined into `message.content`, `tool_use` → `tool_calls` with `JSON.stringify(input)`, `stop_reason` mapped (`end_turn`/`stop_sequence`/`pause_turn` → `stop`, `tool_use` → `tool_calls`, `max_tokens` → `length`, `refusal` → `content_filter`).

Streaming (`pipeAnthropicSseAsChat`): `message_start` → a role chunk; `content_block_start` for `tool_use` → a `tool_calls` chunk carrying id + name at its own OpenAI tool index; `text_delta` → `content`; `input_json_delta` → an arguments fragment at that index; `thinking_delta` → `reasoning_content`; `message_delta` supplies the final `finish_reason` chunk. A usage-only chunk follows **only** when the client asked for `stream_options.include_usage`, then `[DONE]`. A provider that puts whole text in `content_block_start` instead of emitting deltas is handled too.

## Direction 2 — Anthropic Messages → OpenAI Chat

Request (`anthropicToChatRequest`): `system` → a leading `system` message; `tool_use` → `tool_calls`; **each** `tool_result` → its own `role: "tool"` message emitted *before* the turn's own text, so tool replies stay adjacent to the assistant message that asked for them; `image` blocks → `image_url` (base64 re-wrapped as a `data:` URL); `tool_choice` `any` → `"required"`, `tool` → `{type:"function"}`; `stop_sequences` → `stop`; `metadata.user_id` → `user`. All-text turns are sent as a plain string rather than a parts array, which is what older local runtimes accept.

When `stream: true`, `stream_options: {include_usage: true}` is added — without it the OpenAI side reports no usage at all and the request log on the `claude` route would have no tokens and no cost.

Response (`chatToAnthropicResponse`): text → a `text` block, `tool_calls` → `tool_use` blocks, `finish_reason` → `stop_reason` (`length` → `max_tokens`, `content_filter` → `refusal`), id normalised to `msg_…`, and OpenAI's cached prompt tokens split back out into `cache_read_input_tokens`.

Streaming (`pipeChatSseAsAnthropic`): text streams live as one `text` block; **tool calls are buffered and emitted as complete blocks** just before `message_delta`. Anthropic content blocks must open and close in order, while OpenAI streams argument fragments by index and may interleave them with text — buffering is the only way to guarantee a well-formed block sequence, and no client renders partial tool arguments. Input tokens are unknown until OpenAI's final chunk, so `message_start` carries zeros and `message_delta` carries the real counts.

## Decisions worth knowing

**Thinking is one-way.** Anthropic `thinking` blocks surface as the de-facto `reasoning_content` field (which `responses.js` already turns into a Codex reasoning item), never folded into the answer text. The reverse is *not* done: an Anthropic thinking block needs a provider signature that cannot be forged, so `reasoning_content` from an OpenAI provider is dropped rather than replayed to Claude Code as an unsigned block.

**Silently dropped** — no semantic equivalent, harmless to omit: `presence_penalty`, `frequency_penalty`, `logit_bias`, `seed`, `service_tier`, `store`, `prediction` one way; `top_k`, the `thinking` budget config, `cache_control`, `tool_result.is_error` the other. (`cache_control` costs nothing to drop — Kiro measurement showed caching is not billed there anyway, see [[cost-and-context]].)

**Refused with 400** — dropping these would change the answer the client asked for, which is the same class of lie as the empty-output bug that started this work: `n > 1`, `response_format` other than `text`, `logprobs`; and going the other way, `document` blocks (PDF input) and Anthropic server tools (`web_search`, `computer`, …). Nothing is sent upstream for a refused request.

**No pairing may answer HTTP 200 with an empty body.** Every mapping fails loudly instead: `502` when the upstream reply has no content blocks, no `choices`, or a choice with neither text nor tool calls (with `finish_reason: length` called out as truncation, since raising `max_tokens` is the fix). Mid-stream, an upstream error or a stream that carried nothing produces an explicit error payload — an OpenAI `error` chunk or an Anthropic `error` event with **no** `message_stop` and no clean `finish_reason` — and the request is logged as an **error**, not as `ok`.

**Non-JSON 200s are named too.** All three routes read non-streaming bodies through `readUpstreamJson()`, which turns a 200 whose body is not JSON (undeclared compressed bytes, an HTML page from a proxy in front of the provider, an empty body) into a `502` naming the provider and the content type. Observed live: a provider answered HTTP 200 with binary bytes and the client used to get an opaque `500 Internal gateway error`.

**Cache accounting round-trips.** Anthropic counts cache reads and writes *outside* `input_tokens`; OpenAI counts cached tokens *inside* `prompt_tokens`. The bridge adds a non-standard `prompt_tokens_details.cache_creation_tokens`, and `openAiUsage()` in `lib/stream.js` reads it, so cache writes keep their own (pricier) rate instead of being folded into plain input.

## Verification

`node scripts/bridge-verify.mjs` — 43 checks, temp `AGENTOS_DATA_DIR` plus two fake upstreams that record what they received (and a `fetch` interceptor for Kiro's region-derived host), following the playbook in [[fallback-and-verification]]. It deliberately crosses the routing (each slot on the provider speaking the *other* protocol), asserts the exact translated body and the exact SSE event sequence in both directions, covers the refusals, the empty/garbage-body paths, the Kiro-on-`openai` path, credit-budget enforcement and the [[session-profiles]] prefix, and re-checks the native passthrough paths afterwards with the slots pointed at their own protocol. The harness is self-checked: deleting one line of the mapping makes two checks fail.

`node scripts/bridge-live-probe.mjs "<provider>" <model> ["<openai-provider>" <model>] ["<kiro account>" <model>]` — the same paths against real providers, from a temp config holding one copy of that provider (the live gateway on `:9000` is never touched and no key is printed). The Kiro section only runs when an account is named, because it spends real credits.

Measured 2026-08-02:

| probe | provider | result |
|---|---|---|
| `/v1/chat/completions` non-stream, no `max_tokens` | an `anthropic-compat` reseller | `200`, `"Paris"`, usage mapped |
| `/v1/chat/completions` tool call | the same `anthropic-compat` provider | `finish_reason: tool_calls`, `get_weather {"city":"Pune"}` |
| `/v1/chat/completions` stream | the same `anthropic-compat` provider | OpenAI chunks, `[DONE]`, usage chunk |
| `/v1/responses` (Codex) | the same `anthropic-compat` provider | `custom_tool_call` → `exec "ls -la"` — the route that used to return `output: []` |
| `/v1/messages` non-stream | token router as `openai-compat` | `200`, `[{type:"text",text:"Tokyo"}]`, `stop_reason: end_turn` |
| `/v1/messages` stream | token router as `openai-compat` | `message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` |
| `/v1/chat/completions` non-stream | `Kiro: work` / `claude-haiku-4.5` | `200`, `"Paris"`, log carries `credits 0.005` + `ctx 2%` |
| `/v1/chat/completions` stream | `Kiro: work` | OpenAI chunks `1..5`, `[DONE]`, credits logged |

Two live findings: that provider does **not** serve `/chat/completions` (HTTP 305), so direction 2 needs a provider that actually speaks it; and a reasoning model on a small `max_tokens` returns `finish_reason: length` with empty content, which the bridge correctly refuses rather than handing Claude Code an empty message — give it room (800+) instead.

## Related

- [[index]]
- [[architecture]]
- [[codex-integration]]
- [[fallback-and-verification]]
- [[cost-and-context]]
- [[kiro-integration]]
