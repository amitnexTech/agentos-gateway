#!/usr/bin/env node
// Verification harness for the OpenAI <-> Anthropic protocol bridge
// (src/lib/protocolBridge.js). Runs the real gateway against two fake upstreams
// that RECORD what they received, so both directions can be checked end to end:
//
//   direction 1  /v1/chat/completions + /v1/responses  -> anthropic-compat provider
//   direction 2  /v1/messages                          -> openai-compat provider
//
// Nothing live is touched: a temp AGENTOS_DATA_DIR holds the config and every
// upstream is local. Run with:  node scripts/bridge-verify.mjs
//
// ponytail: a harness, not a test suite — the repo has no test runner yet (#202).

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "agentos-bridge-"));
process.env.AGENTOS_DATA_DIR = dataDir;
process.env.AGENTOS_ADMIN_TOKEN = "test-token";

// --- fake upstreams --------------------------------------------------------

const received = []; // { path, body }
let anthropicScenario = "default";
let openaiScenario = "default";

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [event, payload] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  res.end();
}

function chunks(res, list) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of list) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const ANTHROPIC_MESSAGE = {
  id: "msg_bridge_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [
    { type: "thinking", thinking: "thinking out loud" },
    { type: "text", text: "Hello there" },
    { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Pune" } },
  ],
  stop_reason: "tool_use",
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  },
};

const CHAT_COMPLETION = {
  id: "chatcmpl-bridge-1",
  object: "chat.completion",
  model: "gpt-5.6",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hi from the OpenAI side",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Pune"}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 20 } },
};

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    received.push({ path: req.url, body });

    if (req.url.endsWith("/messages")) {
      if (anthropicScenario === "empty") {
        return res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({ ...ANTHROPIC_MESSAGE, content: [] })
        );
      }
      if (anthropicScenario === "garbage") {
        // A 200 whose body is not JSON: seen live from a provider that answered
        // with undeclared compressed bytes.
        return res.writeHead(200, { "Content-Type": "application/json" }).end(Buffer.from([0x1f, 0x8b, 0x08, 0x6a, 0x6a, 0x56]));
      }
      if (body.stream) {
        if (anthropicScenario === "emptystream") {
          return sse(res, [
            ["message_start", { type: "message_start", message: { ...ANTHROPIC_MESSAGE, content: [] } }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }],
            ["message_stop", { type: "message_stop" }],
          ]);
        }
        return sse(res, [
          ["message_start", { type: "message_start", message: { ...ANTHROPIC_MESSAGE, content: [], usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Pune"}' } }],
          ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
      }
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(ANTHROPIC_MESSAGE));
    }

    if (req.url.endsWith("/chat/completions")) {
      if (openaiScenario === "empty") {
        return res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({ ...CHAT_COMPLETION, choices: [] })
        );
      }
      if (body.stream) {
        if (openaiScenario === "emptystream") {
          return chunks(res, [
            { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
            { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
          ]);
        }
        return chunks(res, [
          { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
          { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }] },
          { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] },
          { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] },
          { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Pune"}' } }] }, finish_reason: null }] },
          { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          { id: "chatcmpl-stream-1", object: "chat.completion.chunk", model: "gpt-5.6", choices: [], usage: { prompt_tokens: 120, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 20 } } },
        ]);
      }
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(CHAT_COMPLETION));
    }

    res.writeHead(404).end("{}");
  });
});

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

// --- gateway config (temp data dir) ---------------------------------------

writeFileSync(join(dataDir, ".env"), "AGENTOS_KEY_ANTH=anth-key\nAGENTOS_KEY_OAI=oai-key\n", { mode: 0o600 });
writeFileSync(
  join(dataDir, "keys.json"),
  JSON.stringify(
    {
      providers: [
        { id: "prov-anth", name: "Fake Anthropic", type: "anthropic-compat", baseUrl: upstreamUrl, apiKeyRef: "AGENTOS_KEY_ANTH", enabled: true },
        { id: "prov-oai", name: "Fake OpenAI", type: "openai-compat", baseUrl: upstreamUrl, apiKeyRef: "AGENTOS_KEY_OAI", enabled: true },
        // Never routed anywhere; present so the guard can be checked against the
        // one provider type that still has no path to /v1/chat/completions.
        { id: "prov-kiro", name: "Fake Kiro", type: "kiro", region: "us-east-1", apiKeyRef: "AGENTOS_KEY_ANTH", enabled: true },
      ],
      models: [
        { modelId: "claude-sonnet-5", providerId: "prov-anth" },
        { modelId: "gpt-5.6", providerId: "prov-oai" },
      ],
      // Deliberately crossed: each slot points at the provider speaking the OTHER
      // protocol, which is exactly what the bridge has to make work.
      routing: { claude: "prov-oai", codex: "prov-anth", openai: "prov-anth" },
      modelRoutes: {},
    },
    null,
    2
  ),
  { mode: 0o600 }
);

const { createApp } = await import("../src/app.js");
const gateway = createApp();
const server = await new Promise((resolve) => {
  const s = gateway.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

// --- helpers ---------------------------------------------------------------

let passed = 0;
const failures = [];

async function check(name, fn) {
  received.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message.split("\n").slice(0, 6).join("\n       ")}`);
  }
}

function post(path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sseLines(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] || null;
      const dataLine = /^data: ([\s\S]*)$/m.exec(block)?.[1] ?? "";
      let data = null;
      if (dataLine && dataLine !== "[DONE]") {
        try { data = JSON.parse(dataLine); } catch { data = dataLine; }
      }
      return { event, raw: dataLine, data };
    });
}

const CHAT_REQUEST = {
  model: "claude-sonnet-5",
  messages: [
    { role: "system", content: "You are terse." },
    { role: "user", content: "weather in Pune?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_prev", type: "function", function: { name: "get_weather", arguments: '{"city":"Pune"}' } }] },
    { role: "tool", tool_call_id: "call_prev", content: "31C" },
    { role: "user", content: [{ type: "text", text: "and tomorrow?" }] },
  ],
  tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
  tool_choice: "auto",
  stop: "STOP",
};

const ANTHROPIC_REQUEST = {
  model: "gpt-5.6",
  max_tokens: 512,
  system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "weather in Pune?" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "sig" }, { type: "tool_use", id: "toolu_prev", name: "get_weather", input: { city: "Pune" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_prev", content: [{ type: "text", text: "31C" }] }, { type: "text", text: "and tomorrow?" }] },
  ],
  tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
  tool_choice: { type: "auto" },
  top_k: 40,
};

console.log(`\nprotocol bridge verification (data dir ${dataDir})\n`);
console.log("direction 1 — OpenAI client -> anthropic-compat provider");

await check("chat/completions: request is translated to Anthropic Messages", async () => {
  const res = await post("/v1/chat/completions", CHAT_REQUEST);
  assert.equal(res.status, 200);
  const sent = received.at(-1);
  assert.ok(sent.path.endsWith("/messages"), `posted to ${sent.path}`);
  assert.equal(sent.body.max_tokens, 4096, "max_tokens default must be added (Anthropic requires it)");
  assert.equal(sent.body.system[0].text, "You are terse.", "system message must move to top-level system");
  assert.deepEqual(sent.body.messages.map((m) => m.role), ["user", "assistant", "user"], "turns must alternate");
  assert.equal(sent.body.messages[1].content[0].type, "tool_use");
  assert.deepEqual(sent.body.messages[1].content[0].input, { city: "Pune" }, "tool arguments must be parsed into input");
  assert.equal(sent.body.messages[2].content[0].type, "tool_result");
  assert.equal(sent.body.messages[2].content[0].tool_use_id, "call_prev");
  assert.equal(sent.body.messages[2].content[1].text, "and tomorrow?", "tool result and text must merge into one user turn");
  assert.equal(sent.body.tools[0].name, "get_weather");
  assert.deepEqual(sent.body.tools[0].input_schema.properties.city, { type: "string" });
  assert.deepEqual(sent.body.tool_choice, { type: "auto" });
  assert.deepEqual(sent.body.stop_sequences, ["STOP"]);
  assert.ok(!("messages" in sent.body) || !sent.body.messages.some((m) => m.role === "system"), "no system turn may remain");
});

await check("chat/completions: Anthropic reply is translated back", async () => {
  const res = await post("/v1/chat/completions", CHAT_REQUEST);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "claude-sonnet-5");
  const choice = body.choices[0];
  assert.equal(choice.message.content, "Hello there");
  assert.equal(choice.message.reasoning_content, "thinking out loud", "thinking blocks surface as reasoning_content");
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.tool_calls[0].function.name, "get_weather");
  assert.equal(choice.message.tool_calls[0].function.arguments, '{"city":"Pune"}');
  // Anthropic counts cache outside input_tokens; OpenAI counts it inside prompt_tokens.
  assert.equal(body.usage.prompt_tokens, 160);
  assert.equal(body.usage.completion_tokens, 20);
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 50);
  assert.equal(body.usage.prompt_tokens_details.cache_creation_tokens, 10);
});

await check("chat/completions: streaming Anthropic SSE becomes OpenAI chunks", async () => {
  const res = await post("/v1/chat/completions", { ...CHAT_REQUEST, stream: true, stream_options: { include_usage: true } });
  assert.equal(res.status, 200);
  const events = await sseLines(res);
  assert.equal(events.at(-1).raw, "[DONE]");
  const deltas = events.filter((e) => e.data?.choices?.length).map((e) => e.data.choices[0]);
  assert.equal(deltas[0].delta.role, "assistant");
  assert.equal(deltas.map((d) => d.delta.content || "").join(""), "Hello there");
  const toolStart = deltas.find((d) => d.delta.tool_calls?.[0]?.id);
  assert.equal(toolStart.delta.tool_calls[0].index, 0);
  assert.equal(toolStart.delta.tool_calls[0].function.name, "get_weather");
  const args = deltas
    .filter((d) => d.delta.tool_calls?.[0]?.function?.arguments)
    .map((d) => d.delta.tool_calls[0].function.arguments)
    .join("");
  assert.equal(args, '{"city":"Pune"}');
  assert.equal(deltas.at(-1).finish_reason, "tool_calls");
  const usageEvent = events.find((e) => e.data?.usage);
  assert.equal(usageEvent.data.usage.prompt_tokens, 150);
  assert.equal(usageEvent.data.usage.completion_tokens, 20);
});

await check("chat/completions: empty Anthropic content fails loudly (502, not empty 200)", async () => {
  anthropicScenario = "empty";
  const res = await post("/v1/chat/completions", CHAT_REQUEST);
  anthropicScenario = "default";
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(JSON.stringify(body), /no content blocks/i);
});

await check("chat/completions: a 200 that is not JSON becomes a named 502, not a 500", async () => {
  anthropicScenario = "garbage";
  const res = await post("/v1/chat/completions", CHAT_REQUEST);
  anthropicScenario = "default";
  assert.equal(res.status, 502);
  const text = JSON.stringify(await res.json());
  assert.match(text, /Fake Anthropic/, "the error must name the provider");
  assert.match(text, /not JSON/);
});

await check("chat/completions: untranslatable fields are rejected, nothing sent upstream", async () => {
  const many = await post("/v1/chat/completions", { ...CHAT_REQUEST, n: 3 });
  assert.equal(many.status, 400);
  assert.match(JSON.stringify(await many.json()), /n=3/);
  const json = await post("/v1/chat/completions", { ...CHAT_REQUEST, response_format: { type: "json_schema" } });
  assert.equal(json.status, 400);
  const logprobs = await post("/v1/chat/completions", { ...CHAT_REQUEST, logprobs: true });
  assert.equal(logprobs.status, 400);
  assert.equal(received.length, 0, "a rejected request must never reach the provider");
});

await check("responses (Codex): anthropic-compat provider now serves /v1/responses", async () => {
  const res = await post("/v1/responses", {
    model: "claude-sonnet-5",
    stream: false,
    input: [
      { type: "message", role: "developer", content: "You are Codex." },
      { type: "message", role: "user", content: "weather?" },
      { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec", description: "run" }] },
    ],
  });
  assert.equal(res.status, 200);
  const sent = received.at(-1);
  assert.ok(sent.path.endsWith("/messages"), `posted to ${sent.path}`);
  assert.equal(sent.body.max_tokens, 16000);
  assert.equal(sent.body.system[0].text, "You are Codex.");
  assert.equal(sent.body.tools[0].name, "exec");
  const body = await res.json();
  assert.equal(body.status, "completed");
  assert.ok(body.output.length, "output must not be empty — the bug this bridge was built for");
  assert.deepEqual(body.output.map((i) => i.type), ["reasoning", "function_call", "message"]);
  assert.equal(body.output[1].name, "get_weather");
  assert.equal(body.output[2].content[0].text, "Hello there");
  assert.equal(body.usage.input_tokens, 160);
});

await check("responses (Codex): a namespaced tool is hoisted for the provider and answered with its namespace", async () => {
  // Every MCP server reaches Codex as a `namespace` tool. The provider gets a flat
  // tool list; the reply has to carry { namespace, name } or Codex cannot route it.
  const res = await post("/v1/responses", {
    model: "claude-sonnet-5",
    stream: false,
    input: [
      { type: "message", role: "user", content: "weather?" },
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "mcp__weather",
            description: "Weather tools.",
            tools: [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } }],
          },
        ],
      },
    ],
  });
  assert.equal(res.status, 200);

  const sent = received.at(-1);
  assert.deepEqual(sent.body.tools.map((t) => t.name), ["get_weather"], "the provider sees a flat tool list");

  const body = await res.json();
  const call = body.output.find((i) => i.type === "function_call");
  assert.equal(call.name, "get_weather", "the tool's own name, not the flattened one");
  assert.equal(call.namespace, "mcp__weather", "the namespace must be restored");
});

console.log("\ndirection 2 — Claude Code -> openai-compat provider");

await check("messages: request is translated to Chat Completions", async () => {
  const res = await post("/v1/messages", ANTHROPIC_REQUEST);
  assert.equal(res.status, 200);
  const sent = received.at(-1);
  assert.ok(sent.path.endsWith("/chat/completions"), `posted to ${sent.path}`);
  assert.equal(sent.body.max_tokens, 512);
  assert.equal(sent.body.messages[0].role, "system");
  assert.equal(sent.body.messages[0].content, "You are terse.");
  assert.deepEqual(sent.body.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
  assert.equal(sent.body.messages[2].tool_calls[0].function.arguments, '{"city":"Pune"}');
  assert.equal(sent.body.messages[2].content, null, "thinking blocks must be dropped, not replayed");
  assert.equal(sent.body.messages[3].tool_call_id, "toolu_prev");
  assert.equal(sent.body.messages[3].content, "31C");
  assert.equal(sent.body.messages[4].content, "and tomorrow?");
  assert.equal(sent.body.tools[0].function.name, "get_weather");
  assert.equal(sent.body.tool_choice, "auto");
  assert.ok(!("top_k" in sent.body), "top_k has no OpenAI equivalent and must be dropped");
  assert.ok(!JSON.stringify(sent.body).includes("cache_control"), "cache_control must not leak upstream");
});

await check("messages: Chat Completion reply is translated back", async () => {
  const res = await post("/v1/messages", ANTHROPIC_REQUEST);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.ok(body.id.startsWith("msg_"), `id ${body.id} must look like an Anthropic message id`);
  assert.deepEqual(body.content.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(body.content[0].text, "Hi from the OpenAI side");
  assert.deepEqual(body.content[1].input, { city: "Pune" });
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(body.usage.input_tokens, 100);
  assert.equal(body.usage.output_tokens, 15);
  assert.equal(body.usage.cache_read_input_tokens, 20);
});

await check("messages: streaming OpenAI chunks become Anthropic SSE events", async () => {
  const res = await post("/v1/messages", { ...ANTHROPIC_REQUEST, stream: true });
  assert.equal(res.status, 200);
  const sent = received.at(-1);
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.stream_options, { include_usage: true }, "usage must be requested or the log has no tokens");
  const events = await sseLines(res);
  assert.deepEqual(
    events.map((e) => e.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]
  );
  assert.equal(events[0].data.message.role, "assistant");
  assert.equal(events[2].data.delta.text + events[3].data.delta.text, "Hello there");
  assert.equal(events[5].data.content_block.type, "tool_use");
  assert.equal(events[5].data.content_block.name, "get_weather");
  assert.equal(events[6].data.delta.partial_json, '{"city":"Pune"}');
  assert.equal(events[8].data.delta.stop_reason, "tool_use");
  assert.equal(events[8].data.usage.output_tokens, 15);
});

await check("messages: empty choices fails loudly (502, not an empty message)", async () => {
  openaiScenario = "empty";
  const res = await post("/v1/messages", ANTHROPIC_REQUEST);
  openaiScenario = "default";
  assert.equal(res.status, 502);
  assert.match(JSON.stringify(await res.json()), /no choices/i);
});

await check("messages: untranslatable Anthropic input is rejected", async () => {
  const res = await post("/v1/messages", {
    ...ANTHROPIC_REQUEST,
    messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } }] }],
  });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /document blocks/);
  assert.equal(received.length, 0, "a rejected request must never reach the provider");
});

console.log("\nconfig-time guard");

await check("routing table accepts bridged pairings, including Kiro on the openai slot", async () => {
  const { toolSupportsProviderType, fallbackProviders, isOverBudget } = await import("../src/config/keysStore.js");
  assert.equal(toolSupportsProviderType("claude", "openai-compat"), true);
  assert.equal(toolSupportsProviderType("claude", "local-openai"), true);
  assert.equal(toolSupportsProviderType("openai", "anthropic-compat"), true);
  assert.equal(toolSupportsProviderType("codex", "anthropic-compat"), true);
  assert.equal(toolSupportsProviderType("openai", "kiro"), true, "Kiro reaches chat/completions via the Anthropic shape");
  // The fallback pool now spans protocols, because the winner's own adapter is
  // what the route consumes. Kiro stays its own island.
  const pool = fallbackProviders("openai", { id: "prov-anth", type: "anthropic-compat" });
  assert.deepEqual(pool.map((p) => p.id), ["prov-oai"], "a non-Kiro primary never falls back onto Kiro");
  const kiroPool = fallbackProviders("claude", { id: "prov-kiro", type: "kiro" });
  assert.deepEqual(kiroPool.map((p) => p.id), [], "a Kiro primary only falls back onto Kiro");
  // Budget predicate: only Kiro, only when the budget is actually reached.
  assert.equal(isOverBudget({ type: "kiro", creditBudget: 10, usedCredits: 10 }), true);
  assert.equal(isOverBudget({ type: "kiro", creditBudget: 10, usedCredits: 9.5 }), false);
  assert.equal(isOverBudget({ type: "kiro", usedCredits: 999 }), false, "no budget set = no limit");
  assert.equal(isOverBudget({ type: "anthropic-compat", creditBudget: 1, usedCredits: 5 }), false);
});

await check("request log records the bridged calls with model and usage", async () => {
  const { getLogs } = await import("../src/config/logStore.js");
  const logs = getLogs();
  const openaiOk = logs.find((l) => l.tool === "openai" && l.status === "ok");
  assert.ok(openaiOk, "an openai-slot success must be logged");
  assert.equal(openaiOk.responseModel, "claude-sonnet-5");
  assert.ok(openaiOk.usage.input_tokens > 0, "token accounting must survive the bridge");
  const claudeOk = logs.find((l) => l.tool === "claude" && l.status === "ok");
  assert.ok(claudeOk, "a claude-slot success must be logged");
  assert.equal(claudeOk.responseModel, "gpt-5.6");
  assert.ok(claudeOk.usage.output_tokens > 0);
});

// --- native (non-bridged) paths must still work ----------------------------
// The bridge refactored lib/anthropicSse.js into a shared parser, so the raw
// passthrough path is re-checked with the slots pointing at their own protocol.

await check("admin API reports the widened pairings, and every slot's list is enforced", async () => {
  // What the dashboard's routing dropdowns are built from.
  const auth = "Basic " + Buffer.from("any:test-token").toString("base64");
  const routing = await (await fetch(`${base}/admin/routing`, { headers: { Authorization: auth } })).json();
  assert.ok(routing.supportedTypes.openai.includes("anthropic-compat"));
  assert.ok(routing.supportedTypes.openai.includes("kiro"));
  assert.ok(routing.supportedTypes.claude.includes("openai-compat"));

  const setSlot = (tool, providerId) =>
    fetch(`${base}/admin/routing/${tool}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
    });

  assert.equal((await setSlot("openai", "prov-anth")).status, 200, "anthropic on the openai slot is a valid config");
  assert.equal((await setSlot("openai", "prov-kiro")).status, 200, "Kiro on the openai slot is now a valid config");
  assert.equal((await setSlot("openai", "prov-anth")).status, 200); // restore for the checks below
  assert.equal((await setSlot("openai", "nope")).status, 404, "an unknown provider is still refused");
});

await check("streams that carry no content end in an error event and log as errors", async () => {
  const { getLogs } = await import("../src/config/logStore.js");
  // Written explicitly so this check does not depend on what an earlier one left.
  writeConfig({ routing: { claude: "prov-oai", codex: "prov-anth", openai: "prov-anth" } });
  anthropicScenario = "emptystream";
  const chat = await post("/v1/chat/completions", { ...CHAT_REQUEST, stream: true });
  anthropicScenario = "default";
  const chatEvents = await sseLines(chat);
  assert.ok(chatEvents.some((e) => e.data?.error?.type === "upstream_empty_response"), "an error chunk is required");
  assert.ok(!chatEvents.some((e) => e.data?.choices?.[0]?.finish_reason), "no clean finish_reason may be sent");
  assert.equal(chatEvents.at(-1).raw, "[DONE]");
  const openaiLog = getLogs().find((l) => l.tool === "openai");
  assert.equal(openaiLog.status, "error", "a content-less stream must not be logged as ok");

  openaiScenario = "emptystream";
  const messages = await post("/v1/messages", { ...ANTHROPIC_REQUEST, stream: true });
  openaiScenario = "default";
  const msgEvents = await sseLines(messages);
  assert.deepEqual(msgEvents.map((e) => e.event), ["message_start", "error"]);
  assert.equal(msgEvents.at(-1).data.error.type, "upstream_empty_response");
  const claudeLog = getLogs().find((l) => l.tool === "claude");
  assert.equal(claudeLog.status, "error");
});

// Kiro's runtime host is derived from the region, not a configurable baseUrl, so
// it is intercepted at the fetch layer. Its wire format is scannable JSON blobs
// (see parseKiroChunk), which makes a believable fake cheap.
const KIRO_BODY =
  '{"content":"Hello"}{"content":" from Kiro"}{"unit":"CREDIT","usage":0.25}{"contextUsagePercentage":1.5}';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  if (url.includes("kiro.dev")) {
    received.push({ path: url, body: init?.body ? JSON.parse(init.body) : {} });
    return new Response(KIRO_BODY, { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input, init);
};

function writeConfig({ routing, kiro = {}, fallbackEnabled = false, profiles = {} }) {
  writeFileSync(
    join(dataDir, "keys.json"),
    JSON.stringify({
      providers: [
        { id: "prov-anth", name: "Fake Anthropic", type: "anthropic-compat", baseUrl: upstreamUrl, apiKeyRef: "AGENTOS_KEY_ANTH", enabled: true },
        { id: "prov-oai", name: "Fake OpenAI", type: "openai-compat", baseUrl: upstreamUrl, apiKeyRef: "AGENTOS_KEY_OAI", enabled: true },
        { id: "prov-kiro", name: "Fake Kiro", type: "kiro", region: "us-east-1", apiKeyRef: "AGENTOS_KEY_ANTH", enabled: true, usedCredits: 0, ...kiro },
        { id: "prov-kiro2", name: "Fake Kiro 2", type: "kiro", region: "us-east-1", apiKeyRef: "AGENTOS_KEY_ANTH", enabled: true, usedCredits: 0 },
      ],
      models: [
        { modelId: "claude-sonnet-5", providerId: "prov-anth" },
        { modelId: "gpt-5.6", providerId: "prov-oai" },
        { modelId: "claude-sonnet-4.5", providerId: "prov-kiro" },
        { modelId: "claude-sonnet-4.5", providerId: "prov-kiro2" },
      ],
      routing: { ...routing, ...(fallbackEnabled ? { fallbackEnabled: true } : {}) },
      modelRoutes: {},
      profiles,
    }, null, 2),
    { mode: 0o600 }
  );
}

console.log("\nKiro on the openai slot + credit budget enforcement");

await check("chat/completions -> Kiro: chat body reaches Kiro's own protocol, reply comes back as a completion", async () => {
  writeConfig({ routing: { openai: "prov-kiro" } });
  const res = await post("/v1/chat/completions", {
    model: "claude-sonnet-4-5-20250929", // dated id — Kiro aliasing must resolve it
    messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  const sent = received.at(-1);
  assert.ok(sent.path.includes("runtime.us-east-1.kiro.dev"), `went to ${sent.path}`);
  assert.equal(sent.body.conversationState?.currentMessage?.userInputMessage?.modelId, "claude-sonnet-4.5", "dated id must resolve to Kiro's catalog name");
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Hello from Kiro");
  assert.equal(body.choices[0].finish_reason, "stop");
  const { getLogs } = await import("../src/config/logStore.js");
  const log = getLogs()[0];
  assert.equal(log.rawModel, "claude-sonnet-4-5-20250929");
  assert.equal(log.model, "claude-sonnet-4.5");
  assert.equal(log.kiroCredits, 0.25, "Kiro's self-reported credit burn must survive the double translation");
  assert.equal(log.contextUsagePercent, 1.5);
});

await check("chat/completions -> Kiro: streaming reaches the client as OpenAI chunks", async () => {
  writeConfig({ routing: { openai: "prov-kiro" } });
  const res = await post("/v1/chat/completions", {
    model: "claude-sonnet-4.5",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  const events = await sseLines(res);
  assert.equal(events.at(-1).raw, "[DONE]");
  const deltas = events.filter((e) => e.data?.choices?.length).map((e) => e.data.choices[0]);
  assert.equal(deltas[0].delta.role, "assistant");
  assert.equal(deltas.map((d) => d.delta.content || "").join(""), "Hello from Kiro");
  assert.equal(deltas.at(-1).finish_reason, "stop");
  const { getLogs } = await import("../src/config/logStore.js");
  assert.equal(getLogs()[0].kiroCredits, 0.25, "credits must be logged on the streaming path too");
});

await check("credit budget: an exhausted Kiro account is refused before anything is spent", async () => {
  writeConfig({ routing: { openai: "prov-kiro" }, kiro: { creditBudget: 10, usedCredits: 10.4 } });
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 402);
  const text = JSON.stringify(await res.json());
  assert.match(text, /Fake Kiro/, "the error must name the account");
  assert.match(text, /10\.40 of 10 cr/, "the error must show usage vs budget");
  assert.equal(received.length, 0, "an over-budget account must not be called at all");
  const { getLogs } = await import("../src/config/logStore.js");
  assert.equal(getLogs()[0].status, "error", "the refusal must be logged");
});

await check("credit budget: the same account still serves while under budget", async () => {
  writeConfig({ routing: { openai: "prov-kiro" }, kiro: { creditBudget: 10, usedCredits: 9.9 } });
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
});

await check("credit budget: with fallback on, an exhausted account hands over to another Kiro account", async () => {
  writeConfig({ routing: { openai: "prov-kiro" }, kiro: { creditBudget: 10, usedCredits: 11 }, fallbackEnabled: true });
  const res = await post("/v1/chat/completions", { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200, "the second account should have served it");
  assert.equal((await res.json()).choices[0].message.content, "Hello from Kiro");
  const { getLogs } = await import("../src/config/logStore.js");
  const [ok, refused] = getLogs();
  assert.equal(ok.providerName, "Fake Kiro 2");
  assert.equal(ok.fallback, true);
  assert.equal(refused.providerName, "Fake Kiro", "the exhausted account must still show in the log");
  assert.equal(refused.status, "error");
});

await check("chat/completions -> Kiro: system prompt, tools and tool results all reach the payload", async () => {
  writeConfig({ routing: { openai: "prov-kiro" } });
  const res = await post("/v1/chat/completions", { ...CHAT_REQUEST, model: "claude-sonnet-4.5" });
  assert.equal(res.status, 200);
  // Field names are Kiro's business; what matters is that nothing was dropped in
  // the chat -> Anthropic -> Kiro double translation.
  const sent = JSON.stringify(received.at(-1).body);
  assert.match(sent, /You are terse\./, "system prompt must survive");
  assert.match(sent, /get_weather/, "tool definitions must survive");
  assert.match(sent, /31C/, "tool results must survive");
  assert.match(sent, /and tomorrow\?/, "the latest user turn must survive");
});

await check("credit budget is enforced on /v1/messages too (one check, every Kiro route)", async () => {
  writeConfig({ routing: { claude: "prov-kiro" }, kiro: { creditBudget: 5, usedCredits: 5 } });
  const res = await post("/v1/messages", { model: "claude-sonnet-4.5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 402);
  assert.match(JSON.stringify(await res.json()), /Fake Kiro/);
  assert.equal(received.length, 0);
});

await check("spend is recorded permanently and attributed to the right project", async () => {
  writeConfig({ routing: { claude: "prov-oai", codex: "prov-anth", openai: "prov-anth" } });
  const { spendPath } = await import("../src/config/spendStore.js");
  rmSync(spendPath(), { force: true });

  // Codex identifies its workspace in a header; Claude Code's system prompt carries
  // "Working directory:". Both paths go through the AsyncLocalStorage middleware,
  // which is the part unit tests cannot reach.
  const codexRes = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "user-agent": "codex_exec/0.146.0 (test)",
      "x-codex-turn-metadata": JSON.stringify({ workspaces: { "/work/alpha": { has_changes: false } } }),
    },
    body: JSON.stringify({ model: "claude-sonnet-5", stream: false, input: "hi" }),
  });
  assert.equal(codexRes.status, 200);

  const claudeRes = await post("/v1/messages", {
    model: "gpt-5.6",
    max_tokens: 16,
    system: [{ type: "text", text: "<env>\nWorking directory: /work/beta\n</env>" }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(claudeRes.status, 200);

  const auth = "Basic " + Buffer.from("any:test-token").toString("base64");
  const spend = await (await fetch(`${base}/admin/spend/data`, { headers: { Authorization: auth } })).json();

  assert.equal(spend.totals.requests, 2, "both requests must be in the permanent record");
  assert.equal(spend.byProject["/work/alpha"].requests, 1, "Codex's workspace header must attribute the request");
  assert.equal(spend.byProject["/work/beta"].requests, 1, "Claude Code's working directory must attribute the request");
  assert.equal(spend.byClient["codex_exec/0.146.0"].requests, 1);
  assert.ok(spend.byProvider["Fake Anthropic"], "provider breakdown");
  assert.ok(spend.byModel["claude-sonnet-5"], "model breakdown");
  assert.ok(spend.totals.totalTokens > 0, "tokens must survive into the record");
  assert.equal(spend.months.length, 1);

  // An error is recorded too — spend that failed still cost latency and sometimes money.
  openaiScenario = "empty";
  await post("/v1/messages", { model: "gpt-5.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  openaiScenario = "default";
  const after = await (await fetch(`${base}/admin/spend/data`, { headers: { Authorization: auth } })).json();
  assert.equal(after.totals.requests, 3);
  assert.equal(after.totals.errors, 1);
  assert.equal(after.byProject.unknown.requests, 1, "a request with nothing identifying is 'unknown', not dropped");
});

await check("every dashboard page's inline script parses", async () => {
  // The dashboard has no build step, so nothing else would catch a syntax error in
  // the inline JS — it would simply render a dead page. Found one this way: an
  // unescaped apostrophe in a tooltip string broke the whole log page.
  const pages = {
    dashboard: (await import("../src/routes/adminPage.js")).renderAdminPage,
    logs: (await import("../src/routes/logPage.js")).renderLogPage,
    spend: (await import("../src/routes/spendPage.js")).renderSpendPage,
  };
  for (const [name, render] of Object.entries(pages)) {
    const html = render();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length, `${name} page has no inline script to check`);
    for (const [i, src] of scripts.entries()) {
      // new Function parses without executing, which is all that is needed here.
      assert.doesNotThrow(() => new Function(src), `${name} page, script ${i + 1} does not parse`);
    }
  }
});

console.log("\nsession profiles (per-session routing by base URL)");

// The whole point: three sessions, ONE gateway, one model id, three destinations.
// A single-slot gateway could not express this — that is what profiles fix.
await check("profiles: parallel sessions on the same model id reach different providers", async () => {
  writeConfig({
    routing: { claude: "prov-anth", codex: "prov-anth", openai: "prov-anth" },
    profiles: {
      backend: { providerId: "prov-kiro", model: "claude-sonnet-4.5" },
      frontend: { providerId: "prov-oai", model: "gpt-5.6" },
      loose: { providerId: "prov-oai" },
    },
  });
  const body = { ...ANTHROPIC_REQUEST, model: "claude-sonnet-5" };

  assert.equal((await post("/p/backend/v1/messages", body)).status, 200);
  assert.ok(received.at(-1).path.includes("kiro.dev"), "the backend session must reach Kiro");

  received.length = 0;
  assert.equal((await post("/p/frontend/v1/messages", body)).status, 200);
  assert.equal(received.at(-1).path, "/v1/chat/completions", "the frontend session must reach the OpenAI-format provider");
  assert.equal(received.at(-1).body.model, "gpt-5.6", "…renamed to what that provider serves");

  received.length = 0;
  assert.equal((await post("/p/loose/v1/messages", body)).status, 200);
  assert.equal(received.at(-1).body.model, "claude-sonnet-5", "a profile with no model pinned forwards the client's id");

  received.length = 0;
  assert.equal((await post("/v1/messages", body)).status, 200);
  assert.equal(received.at(-1).path, "/v1/messages", "un-prefixed traffic still follows the global slot");
});

await check("profiles: a bad profile is refused, never served from the default account", async () => {
  writeConfig({
    routing: { claude: "prov-anth" },
    profiles: { dead: { providerId: "prov-missing", model: "x" } },
  });
  const body = { ...ANTHROPIC_REQUEST, model: "claude-sonnet-5" };

  const unknown = await post("/p/typo/v1/messages", body);
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error.message, /Unknown routing profile "typo"/);
  assert.equal(received.length, 0, "a typo must not spend anything upstream");

  const dead = await post("/p/dead/v1/messages", body);
  assert.equal(dead.status, 404);
  assert.match((await dead.json()).error.message, /missing or disabled/);
  assert.equal(received.length, 0);
});

await check("profiles: the log and the permanent spend record name the profile", async () => {
  const auth = "Basic " + Buffer.from("any:test-token").toString("base64");
  writeConfig({ routing: { claude: "prov-anth" }, profiles: { docs: { providerId: "prov-oai", model: "gpt-5.6" } } });
  assert.equal((await post("/p/docs/v1/messages", { ...ANTHROPIC_REQUEST, model: "claude-sonnet-5" })).status, 200);

  const { getLogs } = await import("../src/config/logStore.js");
  assert.equal(getLogs({ limit: 1 })[0].profile, "docs", "otherwise the log cannot say which session spent this");

  const spend = await (await fetch(`${base}/admin/spend/data`, { headers: { Authorization: auth } })).json();
  assert.ok(spend.byProfile.docs?.requests >= 1, "monthly spend must be answerable per session type");
});

await check("profiles: the admin API creates, lists and clears them", async () => {
  const auth = "Basic " + Buffer.from("any:test-token").toString("base64");
  const save = (body) =>
    fetch(`${base}/admin/profiles`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const list = async () => (await fetch(`${base}/admin/profiles`, { headers: { Authorization: auth } })).json();

  assert.equal((await save({ name: "api-made", providerId: "prov-oai", model: "gpt-5.6" })).status, 200);
  assert.equal((await list())["api-made"].model, "gpt-5.6");
  assert.equal((await save({ name: "bad name", providerId: "prov-oai" })).status, 400, "the name is a URL segment");
  assert.equal((await save({ name: "ghost", providerId: "nope" })).status, 404, "unknown provider");
  assert.equal((await save({ name: "api-made", providerId: null })).status, 200);
  assert.equal((await list())["api-made"], undefined);
});

console.log("\nnative passthrough (no bridge) — regression check");

writeFileSync(
  join(dataDir, "keys.json"),
  JSON.stringify(
    {
      providers: [
        { id: "prov-anth", name: "Fake Anthropic", type: "anthropic-compat", baseUrl: upstreamUrl, apiKeyRef: "AGENTOS_KEY_ANTH", enabled: true },
        { id: "prov-oai", name: "Fake OpenAI", type: "openai-compat", baseUrl: upstreamUrl, apiKeyRef: "AGENTOS_KEY_OAI", enabled: true },
      ],
      models: [
        { modelId: "claude-sonnet-5", providerId: "prov-anth" },
        { modelId: "gpt-5.6", providerId: "prov-oai" },
      ],
      routing: { claude: "prov-anth", codex: "prov-oai", openai: "prov-oai" },
      modelRoutes: {},
    },
    null,
    2
  ),
  { mode: 0o600 }
);

await check("messages -> anthropic-compat stays a byte-for-byte passthrough", async () => {
  const res = await post("/v1/messages", { ...ANTHROPIC_REQUEST, model: "claude-sonnet-5" });
  assert.equal(res.status, 200);
  const sent = received.at(-1);
  assert.ok(sent.path.endsWith("/messages"));
  // Untranslated: the Anthropic-only fields the client sent are still there.
  assert.equal(sent.body.top_k, 40);
  assert.ok(JSON.stringify(sent.body).includes("cache_control"));
  const body = await res.json();
  assert.equal(body.id, "msg_bridge_1");
  assert.equal(body.content.length, 3, "thinking block must survive the passthrough");
});

await check("messages: a disabled thinking block is not forwarded (some providers reject it)", async () => {
  // Claude Code sends `thinking: {type:"disabled"}` when thinking is off. Omitting
  // it means the same thing to Anthropic, but a router serving Kimi K3 answers
  // 400 "Kimi K3 always has thinking enabled" — measured on the real provider
  // 2026-08-04, and the same request without the field succeeds.
  const res = await post("/v1/messages", {
    ...ANTHROPIC_REQUEST,
    model: "claude-sonnet-5",
    thinking: { type: "disabled" },
  });
  assert.equal(res.status, 200);
  assert.equal(received.at(-1).body.thinking, undefined, "the disabled block must be stripped");

  // An ENABLED block is a real instruction and must survive untouched.
  const enabled = await post("/v1/messages", {
    ...ANTHROPIC_REQUEST,
    model: "claude-sonnet-5",
    thinking: { type: "enabled", budget_tokens: 1024 },
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(received.at(-1).body.thinking, { type: "enabled", budget_tokens: 1024 });
});

await check("messages -> anthropic-compat streaming passthrough is unchanged", async () => {
  const res = await post("/v1/messages", { ...ANTHROPIC_REQUEST, model: "claude-sonnet-5", stream: true });
  const events = await sseLines(res);
  assert.equal(events[0].event, "message_start");
  assert.equal(events.at(-1).event, "message_stop");
  assert.equal(events.length, 11, "every upstream event must be forwarded untouched");
});

await check("chat/completions -> openai-compat is unchanged (native, both modes)", async () => {
  const nonStream = await post("/v1/chat/completions", { ...CHAT_REQUEST, model: "gpt-5.6" });
  assert.equal(nonStream.status, 200);
  const sent = received.at(-1);
  assert.ok(sent.path.endsWith("/chat/completions"));
  assert.equal(sent.body.tools[0].type, "function", "OpenAI tool shape must be forwarded as-is");
  assert.ok(!("max_tokens" in sent.body), "no max_tokens may be injected on the native path");
  assert.equal((await nonStream.json()).id, "chatcmpl-bridge-1");

  const streamed = await post("/v1/chat/completions", { ...CHAT_REQUEST, model: "gpt-5.6", stream: true });
  const events = await sseLines(streamed);
  assert.equal(events.at(-1).raw, "[DONE]");
  assert.equal(events[0].data.id, "chatcmpl-stream-1");
});

await check("responses -> openai-compat is unchanged", async () => {
  const res = await post("/v1/responses", { model: "gpt-5.6", stream: false, input: "hi" });
  assert.equal(res.status, 200);
  assert.ok(received.at(-1).path.endsWith("/chat/completions"));
  const body = await res.json();
  assert.deepEqual(body.output.map((i) => i.type), ["function_call", "message"]);
});

// --- teardown --------------------------------------------------------------

server.close();
upstream.close();
rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
