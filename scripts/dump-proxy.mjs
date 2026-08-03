#!/usr/bin/env node
// Transparent dump proxy: see what a CLI actually sends, without touching the
// gateway or its config. Listens on PORT, writes every request body to
// OUT/NNN-<path>.json, forwards to TARGET, and streams the reply back untouched
// (also saved as NNN-<path>.response.txt).
//
// This is the capture step of the playbook in docs/fallback-and-verification.md:
// a hand-written curl matches the gateway's own assumptions and passes even when
// the real CLI is broken, so the wire truth has to come from the CLI itself.
//
//   PORT=9010 TARGET=http://127.0.0.1:9004 OUT=/tmp/capture \
//     setsid nohup node scripts/dump-proxy.mjs &
//
// Then point only the client at it for one run:
//   codex exec --skip-git-repo-check \
//     -c 'model_providers.x.base_url="http://localhost:9010/v1"' "<prompt>"
//
// Start it with setsid nohup: a plain & from an agent tool call dies with the call.

import http from "node:http";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 9010);
const TARGET = (process.env.TARGET || "http://127.0.0.1:9000").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/codex-capture";

mkdirSync(OUT, { recursive: true });
let seq = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const id = String(++seq).padStart(3, "0");
    const slug = req.url.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
    const stem = join(OUT, `${id}-${slug}`);

    writeFileSync(
      `${stem}.request.json`,
      JSON.stringify(
        { method: req.method, url: req.url, headers: req.headers, body: safeJson(body) },
        null,
        2
      )
    );
    console.log(`[${id}] ${req.method} ${req.url} (${body.length} bytes)`);

    try {
      const upstream = await fetch(TARGET + req.url, {
        method: req.method,
        headers: stripHopHeaders(req.headers),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });

      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (!upstream.body) {
        res.end();
        return;
      }
      // Stream through so SSE stays live, while also saving a copy.
      for await (const chunk of upstream.body) {
        res.write(chunk);
        appendFileSync(`${stem}.response.txt`, Buffer.from(chunk));
      }
      res.end();
    } catch (err) {
      const message = `dump-proxy could not reach ${TARGET}: ${err.message}`;
      writeFileSync(`${stem}.response.txt`, message);
      console.error(`[${id}] ${message}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
    }
  });
});

function safeJson(buf) {
  const text = buf.toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Let fetch set its own framing; forwarding these breaks the request.
function stripHopHeaders(headers) {
  const out = { ...headers };
  for (const key of ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"]) {
    delete out[key];
  }
  return out;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dump-proxy on http://127.0.0.1:${PORT} -> ${TARGET}, writing to ${OUT}`);
});
