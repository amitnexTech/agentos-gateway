#!/usr/bin/env node
// Kiro prompt-caching probe.
//
// Answers three things the gateway cannot know from the wire alone:
//   1. Does the account/model advertise promptCaching, and with what minimums?
//   2. Does Kiro ACCEPT a `cachePoint` marker in the conversation payload?
//   3. Does a repeated prefix actually come back as cacheReadInputTokens —
//      and does the reported credit number drop when it does?
//
// It also proves whether reusing one conversationId across turns matters:
// the gateway currently mints a fresh id per request.
//
// Usage:
//   node scripts/kiro-cache-probe.mjs <providerId|nameSubstring> [model]
//
// Burns a small number of real credits (4 short requests). Never prints the key.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Same two client-side defaults the gateway fixes in src/server.js: this host
// resolves NAT64 AAAA records it cannot route, and 250ms is not enough for a
// ~350ms handshake to us-east-1. Without these the probe dies on ETIMEDOUT.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ORIGIN = "KIRO_CLI";
const UA =
  "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/linux lang/rust/1.92.0 md/appVersion-2.14.2 app/AmazonQ-For-CLI";
const XUA =
  "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI";

function loadProvider(needle) {
  const keys = JSON.parse(readFileSync(join(root, "data/keys.json"), "utf8"));
  const p = (keys.providers || []).find(
    (x) =>
      x.type === "kiro" &&
      (x.id === needle || (x.name || "").toLowerCase().includes(needle.toLowerCase())),
  );
  if (!p) throw new Error(`No kiro provider matching "${needle}"`);
  const env = readFileSync(join(root, "data/.env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith(`${p.apiKeyRef}=`));
  const key = line ? line.slice(p.apiKeyRef.length + 1).replace(/^["']|["']$/g, "") : "";
  if (!key) throw new Error(`No secret for ${p.apiKeyRef} in data/.env`);
  return { ...p, key, region: p.region || "us-east-1" };
}

function headers(key, target) {
  return {
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": target,
    "User-Agent": UA,
    "x-amz-user-agent": XUA,
    "x-amzn-codewhisperer-optout": "false",
    tokentype: "API_KEY",
    Authorization: `Bearer ${key}`,
    "amz-sdk-request": "attempt=1; max=3",
    "amz-sdk-invocation-id": randomUUID(),
    Accept: "*/*",
  };
}

async function getProfile(p) {
  const res = await fetch(`https://management.${p.region}.kiro.dev/`, {
    method: "POST",
    headers: headers(p.key, "AmazonCodeWhispererService.GetProfile"),
    body: "{}",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GetProfile ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// A shared prefix big enough that a cache hit would be unmistakable in the
// credit number. ~15k tokens, byte-identical across every variant below.
const FILLER = Array.from(
  { length: 900 },
  (_, i) =>
    `Rule ${i + 1}: when handling request class ${i + 1}, validate the payload, ` +
    `log the decision, and never mutate shared state without a lock.`,
).join("\n");

const SYSTEM = `You are a terse assistant. Answer with a single word.\n\n${FILLER}`;

// One fixed conversation prefix: a big user turn plus a one-word reply. Every
// variant sends exactly this prefix, so credit differences can only come from
// caching (or from the ~40 bytes of cachePoint markers).
function payload({ model, conversationId, cache }) {
  const tools = [
    {
      toolSpecification: {
        name: "noop",
        description: "Does nothing. " + FILLER.slice(0, 8000),
        inputSchema: { json: { type: "object", properties: { x: { type: "string" } } } },
      },
    },
  ];
  if (cache) tools.push({ cachePoint: { type: "default" } });

  const first = { content: `${SYSTEM}\n\nSay the word ping.`, modelId: model, origin: ORIGIN };
  if (cache) first.cachePoint = { type: "default" };

  const history = [
    { userInputMessage: first },
    { assistantResponseMessage: { content: "ping" } },
  ];

  const current = {
    content: "Say the word pong.",
    modelId: model,
    origin: ORIGIN,
    userInputMessageContext: { tools },
  };

  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage: current },
      history,
    },
  };
}

// Pull every JSON object out of the raw stream that carries usage/token fields.
function extractUsage(raw) {
  const out = [];
  const keys = [
    "uncachedInputTokens",
    "cacheReadInputTokens",
    "cacheWriteInputTokens",
    "totalTokens",
    "contextUsagePercentage",
    '"usage"',
    '"unit"',
  ];
  for (const k of keys) {
    let from = 0;
    for (;;) {
      const i = raw.indexOf(k.replace(/"/g, ""), from);
      if (i === -1) break;
      const start = raw.lastIndexOf("{", i);
      let depth = 0;
      let end = -1;
      for (let j = start; j >= 0 && j < raw.length; j++) {
        if (raw[j] === "{") depth++;
        else if (raw[j] === "}") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (start !== -1 && end !== -1) out.push(raw.slice(start, end + 1));
      from = i + 1;
    }
  }
  return [...new Set(out)];
}

async function chat(p, body, label) {
  const started = Date.now();
  const res = await fetch(`https://runtime.${p.region}.kiro.dev/`, {
    method: "POST",
    headers: headers(p.key, "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await res.text();
  const ms = Date.now() - started;
  const bytes = JSON.stringify(body).length;
  if (!res.ok) {
    console.log(`${label.padEnd(34)} status=${res.status} ERROR ${raw.replace(/\s+/g, " ").slice(0, 300)}`);
    return null;
  }
  const usage = extractUsage(raw);
  let credits = null;
  let ctx = null;
  for (const u of usage) {
    try {
      const o = JSON.parse(u);
      if (typeof o.usage === "number") credits = o.usage;
      if (typeof o.contextUsagePercentage === "number") ctx = o.contextUsagePercentage;
    } catch {}
  }
  const cacheFields = /cacheReadInputTokens|uncachedInputTokens/.test(raw) ? "PRESENT" : "absent";
  console.log(
    `${label.padEnd(34)} ${String(ms).padStart(6)}ms payload=${bytes}B ` +
      `credits=${credits === null ? "-" : credits.toFixed(6)} ctx=${ctx ?? "-"}% tokenFields=${cacheFields}`,
  );
  return { raw, credits };
}

const [needle, modelArg] = process.argv.slice(2);
if (!needle) {
  console.error("usage: node scripts/kiro-cache-probe.mjs <providerId|nameSubstring> [model]");
  process.exit(1);
}

const provider = loadProvider(needle);
console.log(`provider: ${provider.name} (${provider.id}) region=${provider.region}`);

const profile = await getProfile(provider);
const models = profile?.profile?.optInFeatures?.modelConfiguration?.models || [];
console.log(`\n=== promptCaching per model (${models.length} models)`);
for (const m of models) {
  const pc = m.promptCaching;
  console.log(
    `  ${String(m.modelId).padEnd(24)} rate=${m.rateMultiplier ?? "-"}${m.rateUnit ? " " + m.rateUnit : ""}` +
      (pc
        ? `  caching=${pc.supportsPromptCaching} minTokens=${pc.minimumTokensPerCacheCheckpoint} maxCheckpoints=${pc.maximumCacheCheckpointsPerRequest}`
        : "  caching=<absent>"),
  );
}
const pools = profile?.profile?.creditPools;
if (pools) console.log(`\n=== creditPools: ${JSON.stringify(pools).slice(0, 600)}`);
const sub = profile?.subscriptionInfo || profile?.profile?.subscriptionInfo;
if (sub) console.log(`=== subscriptionInfo: ${JSON.stringify(sub).slice(0, 600)}`);

const model = modelArg || "claude-sonnet-4.5";
console.log(`\nmodel under test: ${model}  (identical ~15k-token prefix in every request)\n`);

// Same conversationId + cachePoint markers: request 1 writes the cache,
// requests 2 and 3 should read it if Kiro honours the marker.
const convA = randomUUID();
await chat(provider, payload({ model, conversationId: convA, cache: true }), "A1 cachePoint, write");
await chat(provider, payload({ model, conversationId: convA, cache: true }), "A2 cachePoint, same convId");
await chat(provider, payload({ model, conversationId: convA, cache: true }), "A3 cachePoint, same convId");

// Control: no cachePoint, fresh conversationId each time — today's gateway.
await chat(provider, payload({ model, conversationId: randomUUID(), cache: false }), "B1 no cachePoint, new convId");
await chat(provider, payload({ model, conversationId: randomUUID(), cache: false }), "B2 no cachePoint, new convId");

// Does conversationId reuse alone help, with no cachePoint at all?
const convC = randomUUID();
await chat(provider, payload({ model, conversationId: convC, cache: false }), "C1 no cachePoint, same convId");
await chat(provider, payload({ model, conversationId: convC, cache: false }), "C2 no cachePoint, same convId");
