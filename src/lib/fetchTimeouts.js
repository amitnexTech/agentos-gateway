// Node's fetch is undici, and undici applies its OWN headersTimeout and
// bodyTimeout — both 300s by default. Removing the gateway's AbortController
// timeout (proxyExecute.js) therefore did NOT remove the five-minute ceiling: a
// provider that takes longer than five minutes to send response headers still
// fails, and a stream that goes quiet for five minutes still dies, with
// UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT instead of our own error.
//
// Measured on this install 2026-08-05: "upstream sent no headers in time
// (UND_ERR_HEADERS_TIMEOUT)" at 302,972 ms on a Kimi K3 route whose other calls
// were already reaching 282 s. A real ceiling on long turns, not a theoretical one.
//
// undici ships inside Node, is not importable, and has no public API for these
// defaults. The global dispatcher IS reachable through a well-known symbol, so the
// dispatcher is rebuilt from its own constructor with the timeouts we want.
//
// That symbol is internal, so every step is guarded: a future Node that renames or
// removes it makes this return false and the process keeps running on the stock
// 300s behaviour. Verified empirically against a server that withholds headers for
// 4s — stock: succeeds; headersTimeout 1000: UND_ERR_HEADERS_TIMEOUT at ~1.5s;
// headersTimeout 0: succeeds. test/fetch-timeouts.test.js pins that.

const SYMBOL = Symbol.for("undici.globalDispatcher.1");

/**
 * Set undici's headers/body timeout for every fetch in this process.
 * @param {number} ms - milliseconds; 0 disables both (wait as long as it takes).
 * @returns {Promise<boolean>} false when the internal dispatcher could not be
 *   reached, in which case Node's 300s defaults still apply.
 */
export async function tuneFetchTimeouts(ms) {
  try {
    // The dispatcher is created lazily on the first fetch; a data: URL materialises
    // it without touching the network.
    if (!globalThis[SYMBOL]) await fetch("data:text/plain,init").catch(() => {});
    const Agent = globalThis[SYMBOL]?.constructor;
    if (typeof Agent !== "function") throw new Error("undici global dispatcher not found");
    globalThis[SYMBOL] = new Agent({ headersTimeout: ms, bodyTimeout: ms });
    return true;
  } catch (err) {
    console.warn(
      `[agentos-gateway] could not change undici's fetch timeouts (${err.message}); ` +
        "Node's 300s headers/body timeout still applies to long upstream turns."
    );
    return false;
  }
}
