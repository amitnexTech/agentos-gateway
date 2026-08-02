#!/usr/bin/env node
// Live sanity probe for the protocol bridge against a REAL provider.
//
// The fake-upstream harness (scripts/bridge-verify.mjs) proves the mapping; this
// proves a real Anthropic clone accepts what the bridge produces. It copies ONE
// provider out of the live config into a temp AGENTOS_DATA_DIR (the live gateway
// on :9000 is never touched, and the API key is never printed), then sends tiny
// prompts through /v1/chat/completions — the route that provider could not serve
// before the bridge.
//
//   node scripts/bridge-live-probe.mjs "aeorlink" claude-haiku-4-5-20251001
//
// Host quirks (#206): NAT64 AAAA records plus a 250ms Happy Eyeballs window make
// plain fetch() time out here, hence the DNS order and family-attempt timeout.

import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import dns from "node:dns";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

dns.setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const [providerName = "aeorlink", model = "claude-haiku-4-5-20251001", d2Name = providerName, d2Model = model, kiroName = "", kiroModel = "claude-haiku-4.5"] =
  process.argv.slice(2);

const liveDir = process.env.AGENTOS_LIVE_DATA_DIR || join(process.cwd(), "data");
const live = JSON.parse(readFileSync(join(liveDir, "keys.json"), "utf8"));
const provider = live.providers.find((p) => p.name === providerName);
if (!provider) {
  console.error(`No provider named "${providerName}" in ${liveDir}/keys.json`);
  process.exit(1);
}
if (provider.type !== "anthropic-compat") {
  console.error(`Provider "${providerName}" is ${provider.type}; this probe covers anthropic-compat.`);
  process.exit(1);
}
// Direction 2 needs an endpoint that speaks OpenAI chat. It defaults to the same
// one typed openai-compat, which only works if the provider serves both shapes;
// pass a different provider name + model when it does not.
const d2Provider = live.providers.find((p) => p.name === d2Name) || provider;

// Pull just this provider's secret across. Never logged.
const envFile = join(liveDir, ".env");
const secrets = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
    )
  : {};
const apiKey = secrets[provider.apiKeyRef];
if (!apiKey) {
  console.error(`Secret ${provider.apiKeyRef} not found in ${envFile}`);
  process.exit(1);
}
const d2Key = secrets[d2Provider.apiKeyRef];
if (!d2Key) {
  console.error(`Secret ${d2Provider.apiKeyRef} not found in ${envFile}`);
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "agentos-live-probe-"));
process.env.AGENTOS_DATA_DIR = dataDir;
process.env.AGENTOS_ADMIN_TOKEN = "probe-token";
writeFileSync(
  join(dataDir, ".env"),
  `${provider.apiKeyRef}=${apiKey}\n${d2Provider.apiKeyRef}=${d2Key}\n`,
  { mode: 0o600 }
);
writeFileSync(
  join(dataDir, "keys.json"),
  JSON.stringify(
    {
      providers: [
        { ...provider, id: "probe-provider", enabled: true },
        // The direction-2 endpoint typed as openai-compat (Claude Code -> OpenAI
        // chat). Defaults to the same provider, which only works if it serves both
        // wire shapes; pass a 3rd/4th argument to point elsewhere.
        { ...d2Provider, id: "probe-openai", name: `${d2Provider.name} (as openai-compat)`, type: "openai-compat", enabled: true },
      ],
      models: [
        { modelId: model, providerId: "probe-provider" },
        { modelId: d2Model, providerId: "probe-openai" },
      ],
      routing: { openai: "probe-provider", codex: "probe-provider", claude: "probe-openai" },
      modelRoutes: {},
    },
    null,
    2
  ),
  { mode: 0o600 }
);

const { createApp } = await import("../src/app.js");
const server = await new Promise((resolve) => {
  const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

console.log(`\nlive bridge probe — ${providerName} (${provider.type}) as /v1/chat/completions, model ${model}\n`);

// 1. plain answer, no max_tokens on purpose: the bridge must supply Anthropic's
//    mandatory field, which is exactly what used to 400 here.
{
  const res = await post("/v1/chat/completions", {
    model,
    messages: [
      { role: "system", content: "Answer with one word." },
      { role: "user", content: "Capital of France?" },
    ],
  });
  const body = await res.json();
  console.log(`1. non-stream        status ${res.status}`);
  console.log(`   content           ${JSON.stringify(body.choices?.[0]?.message?.content)}`);
  console.log(`   finish_reason     ${body.choices?.[0]?.finish_reason}`);
  console.log(`   model echoed      ${body.model}`);
  console.log(`   usage             ${JSON.stringify(body.usage)}`);
  if (res.status !== 200) console.log(`   error             ${JSON.stringify(body).slice(0, 300)}`);
}

// 2. tool call round trip: OpenAI-shaped tools in, tool_calls out.
{
  const res = await post("/v1/chat/completions", {
    model,
    max_tokens: 256,
    messages: [{ role: "user", content: "What is the weather in Pune? Use the tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
    tool_choice: "auto",
  });
  const body = await res.json();
  const call = body.choices?.[0]?.message?.tool_calls?.[0];
  console.log(`2. tool call         status ${res.status}`);
  console.log(`   finish_reason     ${body.choices?.[0]?.finish_reason}`);
  console.log(`   tool_call         ${call ? `${call.function.name} ${call.function.arguments}` : "none"}`);
  if (res.status !== 200) console.log(`   error             ${JSON.stringify(body).slice(0, 300)}`);
}

// 3. streaming: Anthropic SSE in, OpenAI chunks out.
{
  const res = await post("/v1/chat/completions", {
    model,
    max_tokens: 64,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "Count from 1 to 5, digits only." }],
  });
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((b) => b.replace(/^data: /, ""));
  const parsed = events.filter((e) => e !== "[DONE]").map((e) => { try { return JSON.parse(e); } catch { return null; } }).filter(Boolean);
  const content = parsed.map((c) => c.choices?.[0]?.delta?.content || "").join("");
  console.log(`3. stream            status ${res.status}`);
  console.log(`   chunks            ${parsed.length}, [DONE] ${text.trimEnd().endsWith("[DONE]")}`);
  console.log(`   content           ${JSON.stringify(content)}`);
  console.log(`   finish_reason     ${parsed.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).join(",") || "none"}`);
  console.log(`   usage chunk       ${JSON.stringify(parsed.find((c) => c.usage)?.usage) || "none"}`);
  const err = parsed.find((c) => c.error);
  if (err) console.log(`   error             ${JSON.stringify(err.error).slice(0, 300)}`);
}

// 4. the point of the exercise: Codex's /v1/responses on an anthropic-compat
//    provider, which before the bridge answered 200 with output: [].
{
  const res = await post("/v1/responses", {
    model,
    stream: false,
    input: [
      { type: "message", role: "developer", content: "You are a shell agent. Use the exec tool." },
      { type: "message", role: "user", content: "List files in the current directory." },
      { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec", description: "Run a shell command" }] },
    ],
  });
  const body = await res.json();
  console.log(`4. responses/Codex   status ${res.status}`);
  console.log(`   output types      ${JSON.stringify((body.output || []).map((i) => i.type))}`);
  const call = (body.output || []).find((i) => i.type === "custom_tool_call" || i.type === "function_call");
  console.log(`   tool call         ${call ? `${call.name} ${JSON.stringify(call.input ?? call.arguments)}` : "none"}`);
  const text = (body.output || []).find((i) => i.type === "message")?.content?.[0]?.text;
  console.log(`   text              ${JSON.stringify(text ? text.slice(0, 80) : null)}`);
  console.log(`   usage             ${JSON.stringify(body.usage)}`);
  if (res.status !== 200) console.log(`   error             ${JSON.stringify(body).slice(0, 300)}`);
}

console.log(`\ndirection 2 — Claude Code -> ${d2Provider.name} typed openai-compat, model ${d2Model}`);

// 5. /v1/messages served by an OpenAI-format provider.
{
  const res = await post("/v1/messages", {
    model: d2Model,
    max_tokens: 800, // a reasoning model can spend hundreds of tokens before its first visible one
    system: [{ type: "text", text: "Answer with one word.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "Capital of Japan?" }] }],
    top_k: 40,
  });
  const body = await res.json();
  console.log(`5. messages          status ${res.status}`);
  console.log(`   content           ${JSON.stringify(body.content)}`);
  console.log(`   stop_reason       ${body.stop_reason}`);
  console.log(`   usage             ${JSON.stringify(body.usage)}`);
  if (res.status !== 200) console.log(`   error             ${JSON.stringify(body).slice(0, 300)}`);
}

// 6. streaming the same way: OpenAI chunks re-emitted as Anthropic events.
{
  const res = await post("/v1/messages", {
    model: d2Model,
    max_tokens: 800,
    stream: true,
    messages: [{ role: "user", content: "Count from 1 to 5, digits only." }],
  });
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => ({
      event: /^event: (.+)$/m.exec(block)?.[1] || null,
      data: (() => { try { return JSON.parse(/^data: ([\s\S]*)$/m.exec(block)?.[1] || ""); } catch { return null; } })(),
    }));
  console.log(`6. messages stream   status ${res.status}`);
  console.log(`   event sequence    ${events.map((e) => e.event).join(" -> ")}`);
  const streamed = events
    .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  console.log(`   content           ${JSON.stringify(streamed)}`);
  const delta = events.find((e) => e.event === "message_delta");
  console.log(`   stop/usage        ${JSON.stringify(delta?.data?.delta)} ${JSON.stringify(delta?.data?.usage)}`);
  const err = events.find((e) => e.event === "error");
  if (err) console.log(`   error             ${JSON.stringify(err.data).slice(0, 300)}`);
}

// What the gateway logged — the only trustworthy record of which provider and
// model actually served (some providers normalise the echoed model id).
{
  const { getLogs } = await import("../src/config/logStore.js");
  console.log("\ngateway log:");
  for (const l of getLogs().slice(0, 8).reverse()) {
    console.log(
      `   ${l.tool} ${l.status} raw=${l.rawModel} -> ${l.model} resp=${l.responseModel} ` +
        `usage=${JSON.stringify(l.usage)} ${l.latencyMs}ms${l.error ? ` error=${l.error.slice(0, 120)}` : ""}`
    );
  }
}

// Kiro on the openai slot — only when a Kiro account is named, because this one
// spends real credits. Two tiny prompts, cheapest model.
//   node scripts/bridge-live-probe.mjs aeorlink <model> "token router" <model> "Kiro: Abhishek" claude-haiku-4.5
if (kiroName) {
  const kiroProvider = live.providers.find((p) => p.name === kiroName && p.type === "kiro");
  if (!kiroProvider) {
    console.log(`\nskipping Kiro probe: no kiro provider named "${kiroName}"`);
  } else {
    const kiroKey = secrets[kiroProvider.apiKeyRef];
    writeFileSync(join(dataDir, ".env"), `${provider.apiKeyRef}=${apiKey}\n${d2Provider.apiKeyRef}=${d2Key}\n${kiroProvider.apiKeyRef}=${kiroKey}\n`, { mode: 0o600 });
    writeFileSync(
      join(dataDir, "keys.json"),
      JSON.stringify({
        providers: [{ ...kiroProvider, id: "probe-kiro", enabled: true }],
        models: [{ modelId: kiroModel, providerId: "probe-kiro" }],
        routing: { openai: "probe-kiro" },
        modelRoutes: {},
      }, null, 2),
      { mode: 0o600 }
    );

    console.log(`\nKiro on the openai slot — ${kiroName}, model ${kiroModel} (spends real credits)`);

    const nonStream = await post("/v1/chat/completions", {
      model: kiroModel,
      messages: [{ role: "system", content: "Answer with one word." }, { role: "user", content: "Capital of France?" }],
    });
    const nsBody = await nonStream.json();
    console.log(`7. kiro non-stream   status ${nonStream.status}`);
    console.log(`   content           ${JSON.stringify(nsBody.choices?.[0]?.message?.content)}`);
    console.log(`   finish_reason     ${nsBody.choices?.[0]?.finish_reason}`);
    console.log(`   usage             ${JSON.stringify(nsBody.usage)}`);
    if (nonStream.status !== 200) console.log(`   error             ${JSON.stringify(nsBody).slice(0, 300)}`);

    const streamed = await post("/v1/chat/completions", {
      model: kiroModel,
      stream: true,
      messages: [{ role: "user", content: "Count from 1 to 5, digits only." }],
    });
    const text = await streamed.text();
    const parsed = text
      .split("\n\n")
      .filter(Boolean)
      .map((b) => b.replace(/^data: /, ""))
      .filter((e) => e !== "[DONE]")
      .map((e) => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);
    console.log(`8. kiro stream       status ${streamed.status}`);
    console.log(`   chunks            ${parsed.length}, [DONE] ${text.trimEnd().endsWith("[DONE]")}`);
    console.log(`   content           ${JSON.stringify(parsed.map((c) => c.choices?.[0]?.delta?.content || "").join(""))}`);
    console.log(`   finish_reason     ${parsed.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).join(",") || "none"}`);
    const kerr = parsed.find((c) => c.error);
    if (kerr) console.log(`   error             ${JSON.stringify(kerr.error).slice(0, 300)}`);

    const { getLogs } = await import("../src/config/logStore.js");
    console.log("   log:");
    for (const l of getLogs().slice(0, 2).reverse()) {
      console.log(`     ${l.tool} ${l.status} raw=${l.rawModel} -> ${l.model} credits=${l.kiroCredits} ctx=${l.contextUsagePercent}% usage=${JSON.stringify(l.usage)} ${l.latencyMs}ms${l.error ? ` error=${l.error.slice(0, 120)}` : ""}`);
    }
  }
}

server.close();
rmSync(dataDir, { recursive: true, force: true });
