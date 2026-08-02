// Kiro payload construction. These converters are the reason a Claude Code or
// Codex turn either works or silently loses its system prompt / tool history, and
// every past bug here was invisible from the outside (a dropped tool result reads
// as the model "forgetting", not as an error).

import test from "node:test";
import assert from "node:assert/strict";

import { anthropicToKiro, ensureAlternating } from "../src/kiro/converter.js";
import { collectCodexTools, codexToKiro } from "../src/kiro/codexConverter.js";
import { measureKiroPayload, estimateTokens } from "../src/kiro/tokens.js";

const current = (payload) => payload.conversationState.currentMessage.userInputMessage;
const history = (payload) => payload.conversationState.history || [];

test("anthropicToKiro: single turn carries model, origin and the system prompt", () => {
  const payload = anthropicToKiro({
    model: "claude-sonnet-4.5",
    system: "Be terse.",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(current(payload).modelId, "claude-sonnet-4.5");
  assert.equal(current(payload).origin, "KIRO_CLI");
  // With no history the system prompt has to ride on the current message.
  assert.equal(current(payload).content, "Be terse.\n\nhi");
  assert.equal(history(payload).length, 0);
  assert.equal(payload.conversationState.chatTriggerType, "MANUAL");
  assert.ok(payload.conversationState.conversationId);
  assert.ok(!("profileArn" in payload), "API-key auth rejects a request carrying profileArn");
});

test("anthropicToKiro: system blocks are flattened and prepended to the FIRST history turn", () => {
  const payload = anthropicToKiro({
    model: "claude-sonnet-4.5",
    system: [
      { type: "text", text: "Line one." },
      { type: "text", text: "Line two.", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ],
  });

  assert.equal(history(payload)[0].userInputMessage.content, "Line one.\nLine two.\n\nfirst");
  assert.equal(current(payload).content, "second", "the system prompt must not be repeated");
  assert.ok(!JSON.stringify(payload).includes("cache_control"));
});

test("anthropicToKiro: tool_use and tool_result survive into history and context", () => {
  const payload = anthropicToKiro({
    model: "claude-sonnet-4.5",
    tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Pune" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "31C" }] },
    ],
  });

  const assistantTurn = history(payload).find((h) => h.assistantResponseMessage);
  assert.deepEqual(assistantTurn.assistantResponseMessage.toolUses, [
    { name: "get_weather", input: { city: "Pune" }, toolUseId: "toolu_1" },
  ]);
  assert.deepEqual(current(payload).userInputMessageContext.toolResults, [
    { content: [{ text: "31C" }], status: "success", toolUseId: "toolu_1" },
  ]);
  assert.equal(current(payload).userInputMessageContext.tools[0].toolSpecification.name, "get_weather");
});

test("anthropicToKiro: an errored tool result keeps its error status", () => {
  const payload = anthropicToKiro({
    model: "m",
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] }],
  });
  assert.equal(current(payload).userInputMessageContext.toolResults[0].status, "error");
});

test("ensureAlternating: placeholders keep the sequence legal and end on a user turn", () => {
  const alternated = ensureAlternating([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ]);
  assert.deepEqual(
    alternated.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "user"],
    "a repeated role gets a placeholder, and Kiro requires the current message to be a user turn"
  );
  assert.equal(alternated.at(-1).content, "(awaiting response)");
});

test("collectCodexTools: reads both wire shapes and flags freeform tools", () => {
  // Codex >= 0.145 sends tools as an input item, not at the top level. Reading
  // only the old shape is what left Codex unable to call any tool at all.
  const { tools, freeform } = collectCodexTools({
    tools: [{ type: "function", name: "old_style", parameters: { type: "object", properties: {} } }],
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          { type: "custom", name: "exec", description: "run a command" },
          { type: "namespace", name: "collab", tools: [{ name: "spawn_agent" }] },
        ],
      },
    ],
  });

  assert.deepEqual(tools.map((t) => t.name), ["old_style", "exec"], "namespace tools are skipped");
  assert.deepEqual([...freeform], ["exec"]);
  // A freeform tool must be advertised with a JSON schema, because Kiro requires one.
  const exec = tools.find((t) => t.name === "exec");
  assert.equal(exec.input_schema.type, "object");
  assert.ok(exec.input_schema.properties.input, "freeform input is wrapped in an { input: string } schema");
});

test("codexToKiro: instructions become the system prompt and tool output lands in toolResults", () => {
  const payload = codexToKiro(
    {
      instructions: "You are Codex.",
      input: [
        { type: "message", role: "user", content: "list files" },
        { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "ls" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "AGENTS.md" },
      ],
    },
    "claude-sonnet-4.5"
  );

  const text = JSON.stringify(payload);
  assert.match(text, /You are Codex\./);
  assert.match(text, /list files/);
  const results = current(payload).userInputMessageContext?.toolResults || [];
  assert.equal(results[0].toolUseId, "call_1");
  assert.match(JSON.stringify(results[0].content), /AGENTS\.md/);
  const uses = history(payload).flatMap((h) => h.assistantResponseMessage?.toolUses || []);
  assert.equal(uses[0].name, "exec");
});

test("measureKiroPayload: counts the whole re-sent payload, not just the last turn", () => {
  const payload = anthropicToKiro({
    model: "m",
    messages: [
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: "y".repeat(400) },
      { role: "user", content: "z".repeat(400) },
    ],
  });

  const { inputTokens, historyEntries, payloadChars } = measureKiroPayload(payload);
  assert.equal(historyEntries, 2);
  // Input IS the cost on Kiro: history must be inside the measurement, or the
  // dashboard hides the largest cost driver.
  assert.ok(payloadChars >= 1200, `payloadChars ${payloadChars} must include the history`);
  assert.equal(inputTokens, Math.ceil(payloadChars / 4));
  assert.deepEqual(measureKiroPayload({}), { inputTokens: 0, historyEntries: 0, payloadChars: 0 });
});

test("measureKiroPayload: tool specs and results are billed input too", () => {
  const bare = anthropicToKiro({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const withTools = anthropicToKiro({
    model: "m",
    tools: [{ name: "get_weather", description: "long description here", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.ok(
    measureKiroPayload(withTools).payloadChars > measureKiroPayload(bare).payloadChars,
    "tool definitions are re-sent every turn and must be counted"
  );
});

test("estimateTokens: ~4 chars per token, empty is zero", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});


test("kiroModelCandidates peels client decorations in decreasing order of fidelity", async () => {
  const { kiroModelCandidates } = await import("../src/kiro/client.js");

  // The exact id always comes first, so an account that really advertises it wins.
  assert.deepEqual(kiroModelCandidates("claude-sonnet-4-5-20250929"), [
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-5",
    "claude-sonnet-4.5", // Anthropic's dashes, Kiro's dot
  ]);

  // CLAUDE_CODE_SUBAGENT_MODEL style capability marker.
  assert.deepEqual(kiroModelCandidates("claude-sonnet-5[1M]"), ["claude-sonnet-5[1M]", "claude-sonnet-5"]);

  // An explicit alias must be offered BEFORE the bare undated name, because the
  // alias exists precisely for the ids whose undated form Kiro does not serve.
  const opus = kiroModelCandidates("claude-opus-4-20250514");
  assert.ok(opus.indexOf("claude-opus-4.6") < opus.indexOf("claude-opus-4"));

  // An id Kiro already spells correctly is left alone.
  assert.deepEqual(kiroModelCandidates("claude-haiku-4.5"), ["claude-haiku-4.5"]);
});

test("lookupModelForTool: Kiro only forwards ids the account advertises", async () => {
  // Sending Kiro an unconfigured id is a ban risk, so this gate stays strict for
  // Kiro while every other provider type gets the raw id passed through.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "agentos-lookup-test-"));
  process.env.AGENTOS_DATA_DIR = dir;
  writeFileSync(
    join(dir, "keys.json"),
    JSON.stringify({
      providers: [
        { id: "k", name: "Kiro", type: "kiro", region: "us-east-1", enabled: true },
        { id: "a", name: "Anth", type: "anthropic-compat", baseUrl: "https://a.example/v1", enabled: true },
      ],
      models: [{ modelId: "claude-sonnet-4.5", providerId: "k" }],
      routing: { claude: "k", openai: "a" },
      modelRoutes: {},
    }),
    { mode: 0o600 }
  );

  const { lookupModelForTool } = await import("../src/kiro/client.js");

  const dated = lookupModelForTool("claude", "claude-sonnet-4-5-20250929");
  assert.equal(dated.provider.id, "k");
  assert.equal(dated.model, "claude-sonnet-4.5", "the dated id resolves to the configured catalog name");

  const unknown = lookupModelForTool("claude", "gpt-5.6");
  assert.equal(unknown.provider, null, "an unconfigured id must not reach Kiro");

  const passthrough = lookupModelForTool("openai", "some-model-nobody-listed");
  assert.equal(passthrough.provider.id, "a");
  assert.equal(passthrough.model, "some-model-nobody-listed", "non-Kiro providers get the raw id, list or no list");
});
