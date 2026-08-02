# Security — dashboard auth, loopback binding, admin token, /v1 auth stance

Why and how the dashboard is locked down, and why the proxy endpoints deliberately are not.

**Status:** v1.0 COMPLETE

## The problem this fixes

The gateway previously listened on `0.0.0.0` with no authentication whatsoever on `/admin`. Any host on the same LAN could open the dashboard, read masked-but-retrievable provider API keys via `GET /admin/config`, rotate or delete them, and spend Kiro credits through the open proxy.

## The fix (`src/lib/adminAuth.js`, `src/app.js`, `src/server.js`)

- `server.js` listens on `127.0.0.1` by default; the `HOST` env var overrides it for a deliberate LAN exposure.
- `/admin` is wrapped in `adminAuth`: HTTP Basic, with any username and the admin token as password. Basic rather than a bearer header specifically so a plain browser reaches the dashboard through its native credential prompt — no login page, cookie, or session code, and the dashboard's own same-origin `fetch()` calls inherit the credentials automatically.
- `adminToken()` reads `AGENTOS_ADMIN_TOKEN` from `data/.env` (mode 0600) and generates a random 16-byte hex token on first boot if absent, so the dashboard can never be left open by omission. The token is printed at startup.
- Comparison is `timingSafeEqual` on equal-length buffers.

## Why `/v1` stays unauthenticated

`/v1` is deliberately left unauthenticated: the tools (Claude Code, Codex) authenticate to their upstream provider, and loopback binding is what keeps the proxy private. Adding a gateway-side key would mean configuring a second credential in both Claude Code and Codex for no real gain on a single-user machine.

## Verified live (2026-07-26)

- Bind shows `127.0.0.1:9000` only.
- No-auth and wrong-token requests to `/admin/` and `/admin/config` both return 401 with no key material in the body.
- Correct token returns 200 and lists accounts.
- `/v1/models` still returns 200 without auth.
- A request to the machine's LAN IP (e.g. `192.168.1.33:9000`) is refused.
- `AGENTOS_ADMIN_TOKEN` is present in `data/.env`.

## What must not be done

- Do not modify `data/keys.json` manually — use the dashboard API. Secrets live in `data/.env`, config in `data/keys.json`; both are gitignored.
- Do not add OAuth — API key auth only is the design; unnecessary complexity for a single-user loopback gateway.

## Related

- [[index]]
- [[architecture]]
- [[kiro-integration]]
