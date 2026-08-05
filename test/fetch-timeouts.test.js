// undici's own headersTimeout/bodyTimeout — the five-minute ceiling that survived
// removing the gateway's AbortController. This pins that tuneFetchTimeouts()
// actually changes fetch's behaviour: the mechanism is an INTERNAL Node symbol, so
// without a real request against a slow server there is nothing to catch a future
// Node release quietly ignoring it.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { tuneFetchTimeouts } from "../src/lib/fetchTimeouts.js";

const HEADER_DELAY_MS = 1200;

// A server that accepts the connection and withholds response headers.
const slow = http.createServer((_req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("late");
  }, HEADER_DELAY_MS);
});
await new Promise((r) => slow.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${slow.address().port}/`;

test.after(() => slow.close());

test("a configured timeout aborts a slow upstream, and 0 waits for it", async () => {
  assert.equal(await tuneFetchTimeouts(200), true, "the internal dispatcher must be reachable");
  await assert.rejects(
    () => fetch(url),
    (err) => {
      // This is exactly the error the live gateway logged at 302,972ms with the
      // stock 300s default: "upstream sent no headers in time".
      assert.equal(err.cause?.code ?? err.code, "UND_ERR_HEADERS_TIMEOUT");
      return true;
    },
    "a 200ms headers timeout must kill a 1.2s response"
  );

  assert.equal(await tuneFetchTimeouts(0), true);
  const res = await fetch(url);
  assert.equal(await res.text(), "late", "with no timeout the slow reply must arrive intact");
});
