import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { createApp } from "./app.js";
import { adminToken } from "./lib/adminAuth.js";
import { tuneFetchTimeouts } from "./lib/fetchTimeouts.js";

// This host has no IPv6 default route, but the resolver still hands back
// NAT64-synthesized AAAA records (64:ff9b::...) for *.kiro.dev. Node's default
// resolution order is "verbatim", so it tries those unroutable addresses FIRST
// and each one has to burn the connect-attempt timeout before IPv4 gets a turn.
// Measured symptom: AggregateError [ETIMEDOUT] with ENETUNREACH on the 64:ff9b::
// entries, which the SDK retries 3x — re-uploading the whole conversation each
// time for nothing. curl -6 fails instantly, so only Node was affected.
// Asking for IPv4 first skips the dead family outright.
setDefaultResultOrder("ipv4first");

// Node's Happy Eyeballs gives each candidate address only 250ms to complete its
// TCP handshake before racing the next one. Every AWS address behind
// runtime.us-east-1.kiro.dev needs ~310-400ms from here, so NO address ever wins
// inside the budget: Node walks the whole list and rejects with an
// AggregateError [ETIMEDOUT] after ~765ms — which reads as "connection timed
// out" even though the host is perfectly reachable. That is the cause of the
// repeated Kiro API errors, and it also inflated healthy requests to 2.5-3.8s
// (measured; 320-700ms after this change).
//
// This is a client-side default that is simply too tight for a ~300ms RTT to
// us-east-1, not a provider fault. Raising it to 2s keeps the dual-stack
// fallback behaviour while giving a real handshake room to finish.
const CONNECT_ATTEMPT_TIMEOUT_MS = Number(process.env.AGENTOS_CONNECT_ATTEMPT_TIMEOUT_MS || 2000);
setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);

// The OTHER five-minute wall. Removing the gateway's own AbortController timeout
// (lib/proxyExecute.js) was not enough: Node's fetch is undici, and undici applies
// its OWN headersTimeout and bodyTimeout, both defaulting to 300s. Details, the
// measurement that found it and the empirical verification live in
// lib/fetchTimeouts.js.
//
// Same knob as the gateway's own abort timer: 0 (the default) means "no timeout,
// forward and wait", a positive value re-arms both.
const UPSTREAM_TIMEOUT_MS = Number(process.env.AGENTOS_UPSTREAM_TIMEOUT_MS) > 0
  ? Number(process.env.AGENTOS_UPSTREAM_TIMEOUT_MS)
  : 0;
const fetchTuned = await tuneFetchTimeouts(UPSTREAM_TIMEOUT_MS);

const PORT = process.env.PORT || 9000;
// Loopback by default: the proxy spends real credits and the dashboard holds
// API keys, so it must not be exposed to the LAN unless asked for explicitly.
const HOST = process.env.HOST || "127.0.0.1";
const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(`[agentos-gateway] listening on http://${HOST}:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/admin  (user: any, password: admin token)`);
  console.log(`  Admin token: ${adminToken()}`);
  console.log(
    `  Upstream timeout: ${UPSTREAM_TIMEOUT_MS ? `${UPSTREAM_TIMEOUT_MS} ms` : "none"}` +
      `${fetchTuned ? "" : " (undici's 300s default still applies — see the warning above)"}`
  );
  console.log(`  Claude Code: set ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(`  Codex: set base_url=http://localhost:${PORT}/v1`);
});
