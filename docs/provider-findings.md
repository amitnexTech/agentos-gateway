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
