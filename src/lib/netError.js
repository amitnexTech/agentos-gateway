// Network-level failure mapping.
//
// A `fetch()` that never reaches the server rejects with an opaque
// `TypeError: fetch failed` whose real reason hides in `err.cause`. Left
// unmapped these fell through every route's catch, reached the express error
// handler as "unhandled error", and printed a full undici stack trace per
// failed request — dozens of screens of noise for what is simply "the provider
// is unreachable". Worse, they were invisible in the request log and could not
// trigger auto-fallback, because that only retries an ApiError.
//
// Mapping them here fixes all three: a readable message, a log entry, and a
// retriable status so fallback can try another provider.

import { ApiError } from "./errors.js";

// code -> [gateway status, human explanation]. Statuses are chosen from the
// retriable set (lib/fallback.js RETRYABLE) because "could not reach this
// provider" is exactly the case where another provider should be tried.
const NET_CODES = {
  ENOTFOUND: [502, "DNS lookup failed — host does not resolve"],
  EAI_AGAIN: [502, "DNS lookup timed out"],
  ECONNREFUSED: [502, "connection refused"],
  ECONNRESET: [502, "connection reset by peer"],
  EPIPE: [502, "connection closed while sending the request"],
  ENETUNREACH: [504, "network unreachable — check this machine's connectivity"],
  EHOSTUNREACH: [504, "host unreachable"],
  ETIMEDOUT: [504, "connection timed out"],
  UND_ERR_CONNECT_TIMEOUT: [504, "TLS/TCP connect timed out"],
  UND_ERR_HEADERS_TIMEOUT: [504, "upstream sent no headers in time"],
  UND_ERR_BODY_TIMEOUT: [504, "upstream stopped sending the body"],
  UND_ERR_SOCKET: [502, "socket closed unexpectedly"],
  CERT_HAS_EXPIRED: [502, "upstream TLS certificate has expired"],
  DEPTH_ZERO_SELF_SIGNED_CERT: [502, "upstream TLS certificate is self-signed"],
  // Rejections undici raises before any socket work, from a malformed baseUrl.
  // These carry NO `code` — the message is the only signal, so it doubles as the
  // key. Without them a mistyped baseUrl (e.g. a port on undici's blocked list)
  // surfaced as "Internal gateway error" plus a stack, with nothing in the log.
  "bad port": [502, "provider baseUrl uses a port Node refuses to connect to"],
  "unknown scheme": [502, "provider baseUrl scheme must be http or https"],
};

// Extract the underlying network code from a fetch rejection. undici nests the
// real error one (sometimes two) levels down in `cause`.
function netCode(err) {
  let e = err;
  for (let depth = 0; e && depth < 3; depth++) {
    if (e.code && NET_CODES[e.code]) return e.code;
    if (e.message && NET_CODES[e.message]) return e.message;
    // AggregateError from a multi-address connect: every inner error shares the code.
    if (Array.isArray(e.errors)) {
      for (const inner of e.errors) {
        if (inner?.code && NET_CODES[inner.code]) return inner.code;
      }
    }
    e = e.cause;
  }
  return null;
}

/**
 * Convert a failed-to-connect fetch rejection into a readable ApiError.
 * Returns the original error untouched when it is not a network failure —
 * a genuine bug must keep its stack trace.
 *
 * @param {Error} err - the rejection from fetch()
 * @param {string} label - provider name or URL host, for the message
 * @returns {Error} ApiError for network failures, otherwise `err`
 */
export function networkErrorToApiError(err, label) {
  const code = netCode(err);
  if (!code) return err;
  const [status, reason] = NET_CODES[code];
  return new ApiError(status, `Could not reach ${label}: ${reason} (${code})`, status);
}

/**
 * True when the error is a network-level connectivity failure rather than a
 * response from the provider. Used to keep the noisy stack out of the console.
 */
export function isNetworkError(err) {
  return netCode(err) !== null;
}
