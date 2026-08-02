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
