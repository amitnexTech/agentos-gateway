#!/usr/bin/env node
// Model-swap probe.
//
// A proxy that quietly serves a cheaper model still echoes back the model name
// you asked for, so comparing names proves nothing. This probe collects the
// signals it cannot fake: generation speed, message-id shape, whether cache
// accounting is real, and whether upstream headers leak anything.
//
// Usage:
//   node scripts/swap-probe.mjs <providerId|providerName> [model ...]
//
// Reads baseUrl + key from data/keys.json + data/.env. Never prints the key.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROMPT =
  "Count from 1 to 40, one number per line, digits only. No other text.";
const MAX_TOKENS = 300;

function loadProvider(needle) {
  const keys = JSON.parse(readFileSync(join(root, "data/keys.json"), "utf8"));
  const p = keys.providers.find(
    (x) => x.id === needle || (x.name || "").toLowerCase().includes(needle.toLowerCase()),
  );
  if (!p) throw new Error(`No provider matching "${needle}"`);

  const env = readFileSync(join(root, "data/.env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith(`${p.apiKeyRef}=`));
  const key = line ? line.slice(p.apiKeyRef.length + 1).replace(/^["']|["']$/g, "") : "";
  if (!key) throw new Error(`No secret for ${p.apiKeyRef} in data/.env`);
  return { ...p, key };
}

async function probe(provider, model) {
  const started = Date.now();
  const res = await fetch(`${provider.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.key,
      Authorization: `Bearer ${provider.key}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [{ role: "user", content: PROMPT }],
    }),
  });

  const ms = Date.now() - started;
  const text = await res.text();
  // Keep a long slice: upstream error bodies are where a reseller leaks which
  // model and which panel is really behind a route. Collapse newlines so the
  // baseline log stays one-line-per-sample.
  if (!res.ok) {
    return { model, error: `${res.status} ${text.replace(/\s+/g, " ").slice(0, 600)}` };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { model, error: `unparseable body: ${text.slice(0, 120)}` };
  }

  const u = body.usage || {};
  const out = u.output_tokens || 0;
  // Input tokens matter as much as output: a reseller that bills per token can
  // inflate the prompt side, where nothing in the reply reveals it.
  const inp = u.input_tokens ?? null;
  const interesting = Object.fromEntries(
    [...res.headers.entries()].filter(([k]) =>
      /request-id|ratelimit|anthropic|openai|x-(upstream|provider|model|served)/i.test(k),
    ),
  );

  return {
    model,
    echoed: body.model || null,
    swapFlag: body.model && body.model !== model ? "NAME MISMATCH" : "name ok",
    id: body.id || null,
    idShape: /^msg_[A-Za-z0-9]{20,}$/.test(body.id || "") ? "anthropic-like" : "SYNTHETIC",
    ms,
    out,
    inp,
    tps: out ? Math.round((out / (ms / 1000)) * 10) / 10 : null,
    stop: body.stop_reason || null,
    cacheFields:
      "cache_read_input_tokens" in u || "cache_creation_input_tokens" in u ? "present" : "ABSENT",
    headers: Object.keys(interesting).length ? interesting : null,
  };
}

const [needle, ...models] = process.argv.slice(2);
if (!needle) {
  console.error("usage: node scripts/swap-probe.mjs <providerId|providerName> [model ...]");
  process.exit(1);
}

const provider = loadProvider(needle);
console.log(`provider: ${provider.name} (${provider.type}) -> ${provider.baseUrl}\n`);

let list = models;
if (!list.length) {
  const r = await fetch(`${provider.baseUrl}/models`, {
    headers: { "x-api-key": provider.key, "anthropic-version": "2023-06-01" },
  });
  const j = await r.json();
  list = (j.data || j.models || []).map((m) => m.id || m);
  console.log(`discovered ${list.length} models: ${list.join(", ")}\n`);
}

for (const m of list) {
  const r = await probe(provider, m);
  if (r.error) {
    console.log(`${m.padEnd(18)} ERROR  ${r.error}`);
    continue;
  }
  console.log(
    `${m.padEnd(18)} ${String(r.tps ?? "-").padStart(6)} tok/s  ` +
      `${String(r.ms).padStart(6)}ms  in=${String(r.inp ?? "-").padStart(6)}  ` +
      `out=${String(r.out).padStart(4)}  ` +
      `${r.swapFlag.padEnd(14)} id=${r.idShape.padEnd(14)} cache=${r.cacheFields}`,
  );
  if (r.echoed !== m) console.log(`${"".padEnd(18)} echoed: ${r.echoed}`);
  if (r.headers) console.log(`${"".padEnd(18)} headers: ${JSON.stringify(r.headers)}`);
}
