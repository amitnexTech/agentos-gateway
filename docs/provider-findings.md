# Provider Findings — Lumosel, Aerolink, reseller reliability notes

Live findings on the third-party reseller providers configured in this gateway: reliability, backend-switching evidence, and pricing changes.

**Status:** REFERENCE

## General caution

Both resellers evaluated so far are very new — first TLS cert from Certificate Transparency logs: **aerolink.lat 2026-05-31**, **lumosel.vip 2026-07-11**. Treat this whole category as short-lived: never prepay more than a month, prefer monthly plans over prepaid balance (bounded loss).

## Lumosel (`https://api.lumosel.vip/v1`, anthropic-compat, `lemosol` in keys.json)

- Live `GET /v1/models` is ahead of their public docs page — trust the endpoint: `claude-fable-5`, `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5`, `glm-5.2`, `gpt-5.6`, `gpt-5.6-sol`.
- On the $10 Builder plan only 2 of 7 work. `claude-opus-5` → 403 "your plan does not include this model"; `claude-opus-4-8` → 503; the glm/gpt routes → 502 with a raw Cloudflare HTML body instead of a JSON error.
- **`claude-fable-5` is not a Claude model.** A 2026-07-27T00:18 error leaked the real target: `No available channel for model kat-coder-pro-v2.5 under…`. KAT-Coder-Pro V2.5 is a Kwaipilot (Kuaishou) coding model. The `claude-` prefix on that route is misleading.
- **Upstream chain leaked** in the same window: `claude-sonnet-5` → `404 model 'accounts/euromodels/models/claude-sonnet-5' not found`, a Fireworks-AI style path. "No available channel" phrasing is characteristic of the one-api / new-api reseller panels. Chain is at least: client → Lumosel → reseller panel → Fireworks-style provider → model.
- **Backend switching confirmed.** Same prompt at temperature 0, `claude-sonnet-5`: 135 output tokens with an `msg_01…` id and cache fields present at 21:16 and 01:0x, but 300 output tokens (hit the ceiling) with a SYNTHETIC id and cache ABSENT at 00:48. A different model was served that window. See [[cost-and-context]] for why output-token-count-at-temp-0 is the detection signal that caught this.
- **Availability is the real problem, not speed.** 22:18–23:48 was a full outage (`503 overloaded_error "Gateway is offline"`, 4 consecutive samples). `opus-5` sometimes returns a raw Cloudflare 502 HTML page. A 429 revealed the $10 plan enforces a **6-hour** window, not the 4-hour window advertised on their pricing page. When healthy, throughput is fine — sonnet-5 has hit 52 tok/s.
- Both configured Lumosel keys are currently 429-exhausted. Whether the observed ~2,900x input-token inflation is a fixed pad or scales with prompt size remains untested. There is also a stray `chatcmpl-…` id showing up on their Anthropic-shaped endpoint, unexplained.

## Aerolink (`aerolink.lat`)

Repriced within 2 months of launch: Ultra went from ~₹9,550 with $200/5h + $1400/week to ₹9,999 with $100/5h + $700/week, and the old allowance moved to a new $200 "Power" tier. Effective rate got ~2.1x worse. All tiers now bill at the same rate (no volume discount). Balance top-ups are USD and never expire; burn order is plan allowance → bonus credits (expire) → wallet balance.

**Note:** the Lumosel and Aerolink dashboards are structurally near-identical (same six plan names, same window model, the same "4.8 and 4.6 model routes" string, Telegram verification). Likely the same white-label panel, so redundancy across them is operator-level only, not upstream-level.

## Kimi K3 (`moonshotai/kimi-k3-free` via the `token router` provider, anthropic-compat)

- **Thinking cannot be turned off.** `thinking: {"type":"disabled"}` — which Claude Code sends whenever thinking is off for a model — is answered `400 Kimi K3 always has thinking enabled`. Measured 2026-08-04 across three curl variants on the live provider: field absent → 200, `disabled` → 400, `{"type":"enabled", budget_tokens}` → 200. In the request log this showed up as `claude-opus-5` failing while `claude-fable-5` succeeded *on the same upstream model*, because the two Claude Code roles differed in whether thinking was on.
- The gateway now strips a `{"type":"disabled"}` thinking block before forwarding (`src/routes/anthropic.js`). Omitting the field is what "no extended thinking" means to the Anthropic API anyway, so this is neutral for a real Anthropic provider and makes the always-thinking ones usable. An `enabled` block is a real instruction and is passed through untouched.
- **Every reply contains thinking blocks, and the budget is spent on them first.** With `max_tokens: 32` the reply was a thinking block *and nothing else*, `stop_reason: max_tokens` — no answer text at all. Anything that sends a small token budget (Claude Code's own background calls: topic detection, the auto-mode classifier) can therefore come back empty even though the request succeeded. Treat Kimi K3 as usable for deliberate, generously-budgeted turns, not as a drop-in primary model for an agent.
- The `signature` on those thinking blocks is the provider's own message id, not a real Anthropic signature. Replaying it in a later turn is untested.

- **Tool-bearing requests fall off a cliff.** Measured 2026-08-05 in the live log: successful responses at **526 s, 645 s, 664 s and 1102 s**, against a same-day median of 37 s over 34 requests. A curl probe carrying a single tool definition and a trivial prompt received **zero bytes for 240 s**, so the silence is *before* the response headers — Kimi thinks first and emits nothing. Tool definitions plus a large history reliably push a turn into that tail.
- **That is what "[Tool use interrupted]" in Claude Code was.** The CLI aborts a stream that goes idle: from the 2.1.220 binary, `Math.max(CLAUDE_STREAM_IDLE_TIMEOUT_MS||0, 300000)`, preferring `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` when set, clamped to at most `1800000`. Constants: **180000 (3 min) for first-party, 300000 (5 min) for a custom `ANTHROPIC_BASE_URL`** — i.e. for anything behind this gateway. So the client walked away at five minutes while the gateway happily logged a 645 s success for a turn nobody was listening to any more. Raising `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` (and `API_TIMEOUT_MS`) to 1800000 stops the abort; it does not make an 11-minute tool turn workable.
- The protocol itself is fine: a probe returned a correctly shaped `thinking` block then `tool_use` (`input_json_delta`, `stop_reason: tool_use`), and an isolated real-CLI run called `Read` and reported the file contents in 81 s. The failure was purely patience, not shape.

## Kimi K3 — register it as `openai-compat`, never through a vendor Anthropic shim

`token router` (`https://api.tokenrouter.com/v1`) is **natively OpenAI-compatible** — its own docs show `from openai import OpenAI` with `/v1/chat/completions`, and its `/models` advertises exactly one vendor-prefixed id (`moonshotai/kimi-k3-free`), the signature of an OpenRouter-style router. It *also* exposes an Anthropic-shaped `/v1/messages`, and registering it as `anthropic-compat` to use that shim cost **~40-50x on tool turns**. Measured 2026-08-05, same key, same model:

| path | plain prompt | with a tool definition |
|---|---|---|
| native `/v1/chat/completions` | **8.0 s** | **12.9 s** — `finish_reason: tool_calls`, proper `tool_calls` array |
| the vendor's `/v1/messages` shim | 30-75 s | **526 s, 645 s, 664 s, 1102 s** |

That tail is what crossed Claude Code's five-minute stream-idle timeout and produced `[Tool use interrupted]`. Switching the provider type fixed it: a real-CLI two-tool round trip went from unusable to **46 s total** (26.8 s + 17.3 s per turn), and the before/after sits in one log window — `641 s` on the shim, `50.7 s` and `6.3 s` on the native path minutes later.

The native path is also *cleaner*, not just faster. On `openai-compat` the gateway's own [[protocol-bridge]] does the translation and deliberately drops `reasoning_content` rather than replaying it as an unsigned thinking block. The shim instead returned thinking blocks carrying a **fabricated signature** (the message id) that Claude Code never asked for — it sends `thinking: {"type":"disabled"}` — and it is also what produced `400 Kimi K3 always has thinking enabled`. An OpenAI body has no `thinking` field, so that failure cannot occur at all.

> **General rule: read the vendor's SDK snippet before choosing the provider type.** If it shows the OpenAI SDK, pick `openai-compat` even when an Anthropic-shaped endpoint exists. A vendor compatibility shim is a second translation layer with its own latency and its own bugs; the gateway's bridge is measured and tested. Provider type is a *performance* decision, not only a protocol one.

## Evaluation tooling

```bash
node scripts/swap-probe.mjs <providerId|providerName> [model ...]
python3 scripts/baseline-summary.py [logfile]
./scripts/baseline.sh [provider] [interval_s] [model ...]
```

`swap-probe.mjs` sends one deterministic prompt (temperature 0) per model and reports tok/s, latency, name mismatch, id shape, whether cache fields are present, and any leaking upstream headers. It reads the key from `data/.env` via the provider's `apiKeyRef` and never prints it.

Decision thresholds for baseline data: median **40+ tok/s** is good, 20–40 usable, under 20 painful for coding. Stall rate (>10s latency) under 10% is fine, 25%+ means ask the provider about priority tiers before paying.

## Related

- [[index]]
- [[cost-and-context]]
- [[fallback-and-verification]]
