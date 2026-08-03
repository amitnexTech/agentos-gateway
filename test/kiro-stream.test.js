// Kiro's stream parser. Everything on the Kiro path — text, tool calls, credits,
// context usage — comes out of parseKiroChunk, and it has to survive JSON split
// across chunk boundaries because Kiro frames its blobs inside a binary stream.

import test from "node:test";
import assert from "node:assert/strict";

import { parseKiroChunk } from "../src/kiro/stream.js";

test("parses text, credits and context usage out of one buffer", () => {
  const { events, remaining } = parseKiroChunk(
    '{"content":"Hello"}{"content":" there"}{"unit":"CREDIT","usage":0.25}{"contextUsagePercentage":1.5}'
  );
  assert.deepEqual(events, [
    { type: "content", data: "Hello" },
    { type: "content", data: " there" },
    { type: "usage", data: 0.25 },
    { type: "context_usage", data: 1.5 },
  ]);
  assert.equal(remaining, "");
});

test("an incomplete blob is held back, not dropped", () => {
  const first = parseKiroChunk('{"content":"Hel');
  assert.deepEqual(first.events, []);
  assert.equal(first.remaining, '{"content":"Hel', "the partial JSON must survive for the next chunk");

  const second = parseKiroChunk(first.remaining + 'lo"}{"content":"!"}');
  assert.deepEqual(second.events.map((e) => e.data), ["Hello", "!"]);
});

test("a trailing partial blob is kept while completed ones are emitted", () => {
  const { events, remaining } = parseKiroChunk('{"content":"done"}{"content":"par');
  assert.deepEqual(events, [{ type: "content", data: "done" }]);
  assert.equal(remaining, '{"content":"par');
});

test("braces inside strings do not end a blob early", () => {
  const { events } = parseKiroChunk('{"content":"a { nested } brace"}');
  assert.deepEqual(events, [{ type: "content", data: "a { nested } brace" }]);
});

test("escaped quotes inside strings do not end a blob early", () => {
  const { events } = parseKiroChunk('{"content":"say \\"hi\\" now"}');
  assert.deepEqual(events, [{ type: "content", data: 'say "hi" now' }]);
});

test("tool events keep their id, name and streamed input", () => {
  const { events } = parseKiroChunk(
    '{"name":"get_weather","toolUseId":"tool_1","input":{}}{"input":"{\\"city\\":"}{"input":"\\"Pune\\"}"}{"stop":true}'
  );
  assert.deepEqual(events.map((e) => e.type), ["tool_start", "tool_input", "tool_input", "tool_stop"]);
  assert.equal(events[0].data.toolUseId, "tool_1");
  assert.equal(events[0].data.name, "get_weather");
  assert.equal(events[1].data.input + events[2].data.input, '{"city":"Pune"}');
});

test("empty content is not emitted, and malformed JSON is skipped rather than thrown", () => {
  const { events } = parseKiroChunk('{"content":""}{"content":not json}{"content":"real"}');
  assert.deepEqual(events, [{ type: "content", data: "real" }]);
});

test("a buffer with no recognisable blob is returned intact", () => {
  const { events, remaining } = parseKiroChunk("binary framing bytes with no json");
  assert.deepEqual(events, []);
  assert.equal(remaining, "binary framing bytes with no json");
});


test("Kiro's own stopReason is parsed instead of being inferred from the content", () => {
  // Verified against a real Kiro stream 2026-08-03: it sends {"stopReason":"END_TURN"}.
  // The parser used to have no pattern for it, so a reply truncated at max_tokens was
  // reported to the client as a clean end_turn.
  const { events } = parseKiroChunk('{"content":"hi"}{"stopReason":"END_TURN"}');
  assert.deepEqual(events, [
    { type: "content", data: "hi" },
    { type: "stop_reason", data: "END_TURN" },
  ]);
  // The tool_stop pattern ({"stop":) must not swallow it.
  assert.deepEqual(parseKiroChunk('{"stopReason":"MAX_TOKENS"}').events, [{ type: "stop_reason", data: "MAX_TOKENS" }]);
});

test("Kiro stop reasons map to the Anthropic vocabulary, unknown ones fall back", async () => {
  const { anthropicStopReasonFromKiro } = await import("../src/kiro/stream.js");
  assert.equal(anthropicStopReasonFromKiro("END_TURN", false), "end_turn");
  assert.equal(anthropicStopReasonFromKiro("MAX_TOKENS", false), "max_tokens", "a cut-off answer must say so");
  assert.equal(anthropicStopReasonFromKiro("TOOL_USE", true), "tool_use");
  assert.equal(anthropicStopReasonFromKiro("STOP_SEQUENCE", false), "stop_sequence");
  assert.equal(anthropicStopReasonFromKiro("CONTENT_FILTERED", false), "refusal");
  assert.equal(anthropicStopReasonFromKiro("end_turn", false), "end_turn", "case-insensitive");
  // Kiro omitting it, or sending something new, keeps the old inference.
  assert.equal(anthropicStopReasonFromKiro(null, true), "tool_use");
  assert.equal(anthropicStopReasonFromKiro(null, false), "end_turn");
  assert.equal(anthropicStopReasonFromKiro("SOMETHING_NEW", true), "tool_use");
});

test("token estimates convert once from a character total, not per fragment", async () => {
  const { tokensFromChars, estimateTokens } = await import("../src/kiro/tokens.js");
  // 20 five-character deltas: rounding up per delta gave 20 x ceil(5/4) = 40 tokens
  // for what is really ceil(100/4) = 25. That inflation is why Kiro tok/s and cost
  // numbers drifted.
  const fragments = Array(20).fill("12345");
  const perFragment = fragments.reduce((n, f) => n + Math.ceil(f.length / 4), 0);
  const accumulated = tokensFromChars(fragments.reduce((n, f) => n + f.length, 0));
  assert.equal(perFragment, 40);
  assert.equal(accumulated, 25);
  assert.equal(tokensFromChars(0), 0);
  assert.equal(tokensFromChars(1), 1);
  assert.equal(estimateTokens("abcde"), 2, "the string form is the same conversion");
});
