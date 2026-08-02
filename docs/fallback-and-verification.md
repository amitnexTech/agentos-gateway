# Fallback & Verification — auto-fallback design, CLI testing traps, capture playbook

How opt-in auto-fallback works, and the hard-won rules for verifying any change to the Codex or Claude request path.

**Status:** v1.0 COMPLETE

## Auto-fallback (2026-07-27)

Opt-in, default OFF. When a tool's bound provider fails with a retriable upstream error (429/401/403/408/5xx/timeout), the same request retries on another enabled provider that speaks the **same protocol** — so the execution path (executeKiro vs anthropic SSE vs OpenAI chat SSE) is unchanged and the fallback speaks the right wire format.

- **Toggle:** Dashboard Routing panel "Auto-fallback" checkbox, or `POST /admin/routing/fallback {enabled:bool}`; `GET /admin/routing` returns `fallbackEnabled`. Stored as `routing.fallbackEnabled` in `keys.json`.
- **Chain** (`keysStore.fallbackProviders`): Kiro→Kiro (executeKiro path); openai slot→openai-compat+local-openai (OpenAI chat SSE); claude/codex passthrough→anthropic-compat (anthropic SSE). The protocol group follows the execution path, not raw type equality.
- **Kiro fallback is strict** — a candidate is only tried if it advertises the resolved model (an unconfigured id is a ban risk). Passthrough fallback forwards the raw id untouched.
- **Pre-stream only** — `callUpstream`/`executeKiro` throw before any byte is streamed, so retry is clean; mid-stream failures are NOT recovered.
- Each failed attempt is logged as an error entry; `logPage.js` shows a "fallback" badge by the provider name. `logRequest` captures a `fallback` (bool) field.

**Known gap:** no cross-account failover beyond this opt-in same-protocol retry — the old Python proxy had multi-account failover, this gateway does not. Tied to the decorative `creditBudget` gap in [[kiro-integration]]; both touch the same code path and are agreed to be done together.

## Verifying a Codex or Claude path change

A hand-written curl proves nothing here: it matches the gateway's own assumptions, so it passes even when the real CLI is broken. This is how the "Codex has no tools" bug survived a "verified live" claim. Always verify with the real CLI, and always through a **multi-turn** tool round trip (call → output fed back → answer); turn 1 alone hides dropped tool history.

To see what a CLI actually sends, put a transparent dump proxy in front of the gateway (listen on 9010, dump each body, forward to `127.0.0.1:9000`) and point only the client at it for one run — no gateway restart, no config edits:

```
codex exec --skip-git-repo-check -c 'model_providers.kiro-codex.base_url="http://localhost:9010/v1"' "<prompt>"
```

Start such helpers with `setsid nohup … &`; a plain `&` from an agent tool call dies with the call. To confirm which SSE event names / item types a CLI accepts, read them out of its binary instead of guessing:

```
strings -n 10 <codex-binary> | grep -oE "response\.[a-z_.]+" | sort -u
```

Two traps when driving `codex exec` from a tool call: it reads stdin and will **hang** waiting for it, so redirect `< /dev/null`; and a "stream disconnected / Reconnecting 1-5" error usually means the gateway process died or was mid-restart, not that the SSE format is wrong — check the process is alive before debugging the wire format.

## Case study: the blank Codex reply (2026-08-01)

A curl test passed while every real Codex reply printed blank: `streamKiroToCodex` streamed the text deltas correctly but sent the terminal `*.done` events with `text: ""` and `response.completed` with `output: []`. Codex takes the message content from the completed item, not the deltas, so the answer was discarded (and dropped from the next turn's history). curl concatenates whatever arrives, so it saw nothing wrong. Fixed in commit `90eeccf`.

## Debug playbook: capture real client traffic, don't guess

When a CLI "only chats" through the gateway — no tool calls, model says it has no callable tools — the cause is almost always that the CLI's wire format moved and the gateway is reading the old shape.

1. Write a ~30-line transparent dump proxy: listen on 9010, write each request body to `/tmp/codex-dumps/NNN.json`, forward verbatim to `127.0.0.1:9000`, tee the response body to `NNN-RESPONSE.txt`. Start it with `setsid nohup node /tmp/capture.js &`.
2. Point only the client at it, without touching gateway or config files (see command above; Claude Code equivalent is `ANTHROPIC_BASE_URL=http://localhost:9010` for one invocation).
3. Diff the captured body against what the converter expects: top-level keys, where `tools` live, where `instructions` live, which item `type`s and `role`s appear. Print a compact summary rather than dumping the whole body.
4. Confirm the client's accepted SSE event names / item types straight from its binary (see `strings` command above).
5. Re-run the same real client invocation to verify — and verify a **multi-turn** tool round trip, not just turn 1.

General rules this produced:

- Any converter that reads a field the client may relocate should accept BOTH shapes (top-level `tools` AND a newer in-`input` carrier) rather than being switched over.
- Never silently drop unknown roles/item types in a history loop — Codex's `role:"developer"` turns were once dropped by an `if user / else if assistant` loop, which cost the model its entire system prompt with no error anywhere.
- Client CLIs upgrade themselves. Treat "this worked last week" as unverified: re-capture after any CLI version bump before debugging anything else.
- Kiro's `toolSpecification` requires a JSON inputSchema, so freeform/grammar tools must be wrapped (`{input: string}`) on the way in and unwrapped on the way out. Any future host with freeform tools needs the same treatment.

## Related

- [[index]]
- [[architecture]]
- [[kiro-integration]]
- [[provider-findings]]
