# Codex Integration — Responses API translation, non-Kiro path, SSE reconstruction

How `/v1/responses` (used by Codex) is served for standard (non-Kiro) providers: translating OpenAI Responses input into Chat Completions, then rebuilding Responses-shaped output and synthetic SSE from a single non-streaming upstream call.

**Status:** v1.0 COMPLETE

## Why this exists as a separate path from Kiro

`src/routes/responses.js` has two independent branches for `POST /v1/responses`:

- **Kiro provider** → `codexToKiro()` builds a Kiro payload directly (no detour through Chat Completions), and Kiro's own stream is consumed straight into Responses format via `codexStream.js`. See [[kiro-integration]].
- **Standard provider** (`openai-compat` / `local-openai` natively; `anthropic-compat` through the [[protocol-bridge]]) → the Responses input is converted to Chat Completions messages, sent upstream as one non-streaming call, and the Chat Completions reply is converted back into Responses JSON or synthetic SSE. Because the bridge sits in the adapter, this branch needed no change to gain Anthropic providers: `translateRequest` maps the chat body to Anthropic Messages and `translateResponse` maps the reply back, so Codex no longer needs a Kiro account. Verified live 2026-08-02: `custom_tool_call` → `exec "ls -la"` from an `anthropic-compat` provider.

The second branch is the one this doc covers, and it did not exist in the docs before this pass — it is the code path every non-Kiro Codex request actually takes.

## Responses input → Chat Completions messages

`inputToMessages(input, instructions)` in `src/routes/responses.js`:

- A plain string `input` becomes a single `user` message.
- `instructions` (Codex's system prompt / AGENTS.md content) becomes a leading `system` message.
- An array `input` is walked item by item. Item `type` decides handling:
  - `additional_tools` — skipped here; tool definitions are read separately by `collectCodexTools()` (see below), not folded into the message list.
  - `reasoning` — skipped; Chat Completions has no equivalent slot.
  - `message` — content array is flattened (joining any `text` blocks) into a plain string, kept under the item's `role` (assistant/user, else falls back to system).
  - `function_call` / `custom_tool_call` — becomes an `assistant` message with a `tool_calls` entry. A `custom_tool_call`'s freeform `input` string is re-wrapped as `{"input": "..."}` JSON so it looks like a normal function call's `arguments` field internally.
  - `function_call_output` / `custom_tool_call_output` — becomes a `role: "tool"` message keyed by `call_id`.
  - Anything else — generic fallback: dumps `content`/`text`/the whole item as a string under its role.

This function assumes every input item Codex sends fits one of these shapes. It is intentionally permissive (an `else` fallback rather than a throw) so an unrecognized item degrades to a stringified blob instead of crashing the request — but see [[fallback-and-verification]] for why silently mis-handling an unrecognized *role* (not item type) has bitten this gateway before.

## Tool definitions and the freeform-tool problem

`collectCodexTools(req.body)` (shared with the Kiro path, defined in `src/kiro/codexConverter.js`) reads tool definitions from wherever Codex put them — top-level `tools` or nested inside an `additional_tools` input item — and separates them into normal function tools and **freeform** ("custom") tools such as `exec`.

For the standard-provider path, `chatTools` is built by mapping each Codex tool to an OpenAI function-tool shape (`{type: "function", function: {name, description, parameters: input_schema}}`). Freeform tools are tracked in a `freeform` Set of names, threaded through to both `chatToResponsesFormat()` and `generateSSE()` so their tool-call output can be reconstructed as a `custom_tool_call` item (raw string `input`) instead of a `function_call` item (JSON `arguments`).

`unwrapFreeformArgs()` reverses the wrapping: if the upstream (thinking it's a normal function call) returns JSON-encoded `arguments` for a freeform tool, this pulls the raw string back out (`{input: "..."}` → `"..."`, or passes a bare string through as-is).

## Namespace tools: every MCP server, and sub-agents

Codex declares a *group* of tools as one entry of `type: "namespace"`:

```json
{ "type": "namespace", "name": "mcp__graphify", "description": "…",
  "tools": [ { "type": "function", "name": "graph_stats", "parameters": { … } }, … ] }
```

**This is not just sub-agent orchestration.** Captured from real Codex 0.146 traffic on 2026-08-03, one turn declared eight namespaces: `multi_agent_v1` (`spawn_agent`, `send_input`, `wait_agent`, `resume_agent`, `close_agent`) **and every configured MCP server** — `mcp__trailmem`, `mcp__know_hub`, `mcp__graphify`, plus four `mcp__codex_apps__*` groups. The converter used to skip the whole type, which silently stripped **all 55 MCP tools** from the request: the model was told it had no MCP tools at all, and Codex's sub-agent tools were invisible. It reads as the model refusing to use tools, not as an error — the same failure class as [[fallback-and-verification]]'s blank-reply bug.

Neither Kiro nor Chat Completions has nested tools, so `collectCodexTools` **hoists** the inner tools into the flat list and returns a `namespaced` map (flat name → `{namespace, name}`):

- The advertised name is the tool's **bare** name — that is what the model reads when choosing, and in the measured traffic none of the 64 flattened names collided. On a collision the namespace prefixes it (`mcp__docs__search`); anything past Kiro's 64-character cap keeps the tail, since the tool's own name is the informative part.
- On the way back, a call to a hoisted tool must be answered with the **namespace restored and the original name** — Codex routes by `{namespace, name}`, not by the flat name:

```json
{ "type": "function_call", "call_id": "…", "name": "graph_stats",
  "namespace": "mcp__graphify", "arguments": "{\"project_path\":\"…\"}" }
```

  This applies to all three emitters: `streamKiroToCodex`, `collectKiroAsCodex` (via `toolCallItem()`), and the standard path's `generateSSE()` / `chatToResponsesFormat()`.
- On the **next** turn Codex echoes that item back in `input`, still carrying `namespace`. `codexToKiro` maps it through the reverse of the same map, because Kiro rejects a `toolUse` whose name is not in the request's tool list.

Verified end to end with the real CLI (2026-08-03, Kiro `claude-sonnet-4.5`): `mcp: graphify/graph_stats started → (completed)` with the correct answer, and `collab: SpawnAgent → collab: Wait` with the sub-agent's reply coming back. A `web_search` tool has no name and no Kiro equivalent, so it is still skipped.

**Cost note.** Those namespace definitions are large: 55 KB of JSON, ~13.7k tokens, re-sent on **every** turn, which measured 18% of the context window and ~0.16 credits for a single tool-calling turn on Kiro. Since input is what Kiro bills (see [[cost-and-context]]), the lever is Codex's own config — fewer MCP servers enabled means a smaller tool list. The gateway does not filter them: dropping a tool the client declared is what caused this bug in the first place.

## The upstream call itself: always non-streaming

```js
const chatRequest = {
  model,
  messages,
  max_tokens: req.body.max_output_tokens || 16000,
  stream: false,   // we generate our own SSE from the non-streaming response
};
```

Regardless of whether the Codex client requested `stream: true` (the default for Codex), the gateway always calls the upstream Chat Completions endpoint with `stream: false` and gets one JSON response back via `callUpstreamWithFallback()` (see [[architecture]] for the shared fallback/execution helper). Streaming to the *client* is then synthesized locally — the upstream call and the client-facing stream are decoupled.

## Reconstructing Responses output

Two output shapes are built from the same Chat Completions response (`chatResp`), depending on whether the client asked for streaming:

**Non-streaming** — `chatToResponsesFormat(chatResp, model, responseId, freeform)`:
- Tool calls → `function_call` or `custom_tool_call` output items (freeform-aware, see above).
- Text content → a `message` output item with `output_text` content.
- `reasoning_content` (if the upstream model returned one) → a `reasoning` output item, unshifted to the front of `output`.
- `usage` is remapped from Chat Completions' `prompt_tokens`/`completion_tokens`/`total_tokens` to Responses' `input_tokens`/`output_tokens`/`total_tokens`.
- `status` is `"incomplete"` if the upstream `finish_reason` was `"length"`, else `"completed"`.

**Streaming** — `generateSSE(chatResp, model, responseId, freeform)` fabricates a full Responses SSE sequence from the single upstream JSON reply: `response.created` → `response.in_progress` → per-tool-call `response.output_item.added` / delta events (`response.function_call_arguments.delta` for normal tools, `response.custom_tool_call_input.delta` for freeform) → `response.output_item.done` → for text content, `response.output_item.added` → `response.content_part.added` → chunked `response.output_text.delta` (80-char chunks) → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → finally `response.completed` with usage. This is a synthetic stream — the client experiences it as real token-by-token streaming, but the gateway already has the complete answer before the first byte goes out. See [[fallback-and-verification]] for the incident where a different SSE construction (on the Kiro path) sent an empty terminal event and silently dropped Codex's actual answer — that bug is not in this function, but the failure mode (correct-looking deltas, wrong terminal event) is a risk anywhere Responses SSE is hand-built like this.

## Why Codex never reaches `/v1/chat/completions` directly

Codex only ever talks to `/v1/responses`; the OpenAI Chat Completions endpoint (`src/routes/proxy.js`) is a completely separate route used by other OpenAI-compatible tools (e.g. Cursor). The two routes share adapters and the `callUpstreamWithFallback` helper, but the request/response shapes are handled independently — `proxy.js` never calls into `responses.js` or vice versa.

## Related

- [[index]]
- [[architecture]]
- [[kiro-integration]]
- [[fallback-and-verification]]
