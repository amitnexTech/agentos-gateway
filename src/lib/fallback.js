// Auto-fallback retry policy — shared by the passthrough (callUpstream) and
// Kiro (executeKiro) execution paths. See keysStore.fallbackProviders for the
// chain selection and proxyExecute/kiro.client for the orchestration.

import { ApiError } from "./errors.js";

// Upstream statuses that justify trying another provider instead of failing
// the request: auth/permission (401/403 — bad or exhausted key), rate-limit
// (429), and the 5xx/timeout family. Client errors (400/404/422) are NOT
// retriable — the request itself is bad, so a fallback provider fails the
// same way and would just burn a second account's credits for nothing.
const RETRYABLE = new Set([401, 403, 408, 429, 500, 502, 503, 504]);

// callUpstream sets err.upstreamStatus (the real upstream code); executeKiro
// does not — it maps 403/5xx to a 502 status without forwarding the original.
// Check whichever is present so both paths behave the same.
export function isRetryableApiError(err) {
  if (!(err instanceof ApiError)) return false;
  // Not an upstream failure at all: this account is out of credit budget. Another
  // account may still have room, so it is worth a fallback.
  if (err.budgetExhausted) return true;
  if (err.upstreamStatus != null) return RETRYABLE.has(err.upstreamStatus);
  return RETRYABLE.has(err.status);
}
