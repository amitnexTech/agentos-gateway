// Kiro stream → Anthropic SSE events converter
// Parses Kiro's JSON-in-binary-stream format and emits Anthropic Messages SSE events
// Ported from Python kiro-gateway streaming_anthropic.py + parsers.py

import { randomUUID } from "node:crypto";
import { tokensFromChars } from "./tokens.js";

/**
 * Find matching closing brace considering nesting and strings.
 */
function findMatchingBrace(text, startPos) {
  if (startPos >= text.length || text[startPos] !== "{") return -1;
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startPos; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === "\\" && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === "{") braceCount++;
      else if (ch === "}") {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }
  return -1;
}

// Event patterns to look for in Kiro stream
const EVENT_PATTERNS = [
  ['{"content":', "content"],
  ['{"name":', "tool_start"],
  ['{"input":', "tool_input"],
  ['{"stop":', "tool_stop"],
  ['{"stopReason":', "stop_reason"],
  ['{"followupPrompt":', "followup"],
  ['{"usage":', "usage"],
  ['{"unit":', "usage"],
  ['{"contextUsagePercentage":', "context_usage"],
];

// Kiro's own stop reason (Bedrock-style, e.g. {"stopReason":"END_TURN"}) mapped to
// the Anthropic vocabulary. Until 2026-08-03 the gateway dropped this event and
// inferred "tool_use or end_turn" from the content instead, which reported a reply
// truncated at max_tokens as a clean end_turn — the client had no way to know the
// answer was cut off. Unknown values fall through to the caller's inference.
const KIRO_STOP_REASON = {
  END_TURN: "end_turn",
  TOOL_USE: "tool_use",
  MAX_TOKENS: "max_tokens",
  STOP_SEQUENCE: "stop_sequence",
  CONTENT_FILTERED: "refusal",
  GUARDRAIL_INTERVENED: "refusal",
};

export function anthropicStopReasonFromKiro(kiroStopReason, hasToolCalls) {
  const mapped = KIRO_STOP_REASON[String(kiroStopReason || "").toUpperCase()];
  if (mapped) return mapped;
  return hasToolCalls ? "tool_use" : "end_turn";
}

/**
 * Parse raw bytes buffer and extract Kiro events.
 * Returns { events, remaining } where remaining is unparsed buffer.
 */
export function parseKiroChunk(buffer) {
  const events = [];
  let pos = 0;

  while (pos < buffer.length) {
    let earliestPos = -1;
    let earliestType = null;

    for (const [pattern, evType] of EVENT_PATTERNS) {
      const idx = buffer.indexOf(pattern, pos);
      if (idx !== -1 && (earliestPos === -1 || idx < earliestPos)) {
        earliestPos = idx;
        earliestType = evType;
      }
    }

    if (earliestPos === -1) break;

    const jsonEnd = findMatchingBrace(buffer, earliestPos);
    if (jsonEnd === -1) break; // Incomplete JSON, need more data

    const jsonStr = buffer.slice(earliestPos, jsonEnd + 1);
    pos = jsonEnd + 1;

    try {
      const data = JSON.parse(jsonStr);
      if (earliestType === "content") {
        const content = data.content || "";
        if (content) events.push({ type: "content", data: content });
      } else if (earliestType === "tool_start") {
        events.push({ type: "tool_start", data });
      } else if (earliestType === "tool_input") {
        events.push({ type: "tool_input", data });
      } else if (earliestType === "tool_stop") {
        events.push({ type: "tool_stop", data });
      } else if (earliestType === "stop_reason") {
        events.push({ type: "stop_reason", data: data.stopReason });
      } else if (earliestType === "usage") {
        events.push({ type: "usage", data: data.usage || data });
      } else if (earliestType === "context_usage") {
        events.push({ type: "context_usage", data: data.contextUsagePercentage });
      }
    } catch {
      // Skip malformed JSON
    }
  }

  // Return remaining unparsed buffer
  const remaining = pos < buffer.length ? buffer.slice(pos) : "";
  // But if we broke out early (incomplete JSON), keep from earliestPos
  if (events.length === 0 && buffer.length > 0) {
    return { events, remaining: buffer };
  }
  return { events, remaining: buffer.slice(pos) };
}

/**
 * Format as Anthropic SSE event.
 */
function sse(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stream Kiro response body → Anthropic SSE events.
 * Writes directly to Express response object.
 *
 * @param {ReadableStream|AsyncIterable} body - Kiro response body
 * @param {object} res - Express response
 * @param {string} model - Model name for response metadata
 * @param {number} inputTokens - Estimated input tokens (for usage)
 * @returns {object} { credits, contextUsagePercent } - usage info from Kiro
 */
export async function streamKiroToAnthropic(body, res, model, inputTokens = 0) {
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let kiroCredits = 0;
  let contextUsagePercent = 0;

  // Emit message_start
  res.write(sse("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  }));

  let buffer = "";
  let contentBlockIndex = 0;
  let contentBlockOpen = false;
  // Kiro reports no token counts at all (verified 2026-08-03 against the raw
  // stream: the only numbers are contextUsagePercentage and credits), so output
  // tokens are an estimate. Characters are accumulated and converted ONCE at the
  // end — the old per-fragment Math.ceil(len/4) rounded up on every delta, which
  // inflated the count by up to 3 tokens per chunk.
  let outputChars = 0;
  let kiroStopReason = null;
  let currentToolCall = null;
  let toolCalls = [];
  // toolUseIds already sent to the client, so Kiro's trailing repeat is ignored.
  const emittedToolIds = new Set();

  // Closes the open tool_use block. Emits the accumulated input as a single
  // input_json_delta only if nothing was streamed yet — Kiro sends the input both
  // as fragments and again in full, and emitting both yields unparseable JSON
  // once the client concatenates the deltas.
  function finalizeToolBlock() {
    if (!currentToolCall) return;
    if (!currentToolCall.streamedInput) {
      let inputJson = currentToolCall.inputStr || "{}";
      try { inputJson = JSON.stringify(JSON.parse(inputJson)); } catch {}
      res.write(sse("content_block_delta", {
        type: "content_block_delta",
        index: contentBlockIndex,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));
    }
    res.write(sse("content_block_stop", {
      type: "content_block_stop",
      index: contentBlockIndex,
    }));
    // Tool-call JSON is billed output too. Counting only text deltas made
    // tool-only turns report output_tokens: 0 — 30% of a measured session's
    // credit spend looked free. Count the name plus the input JSON.
    outputChars += currentToolCall.name.length + (currentToolCall.inputStr || "").length;
    toolCalls.push(currentToolCall);
    currentToolCall = null;
    contentBlockIndex++;
  }

  const decoder = new TextDecoder();

  // Process chunks from response body
  const reader = body.getReader ? body.getReader() : null;
  const iterate = reader
    ? async function* () {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      }
    : async function* () {
        for await (const chunk of body) yield chunk;
      };

  for await (const chunk of iterate()) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    buffer += text;

    const { events, remaining } = parseKiroChunk(buffer);
    buffer = remaining;

    for (const ev of events) {
      if (ev.type === "content") {
        // Open content block if needed
        if (!contentBlockOpen) {
          res.write(sse("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          }));
          contentBlockOpen = true;
        }
        // Emit delta
        res.write(sse("content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "text_delta", text: ev.data },
        }));
        outputChars += ev.data.length;
      } else if (ev.type === "tool_start") {
        // Close text content block if open
        if (contentBlockOpen) {
          res.write(sse("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          }));
          contentBlockIndex++;
          contentBlockOpen = false;
        }

        // If there's already an open tool call, this is Kiro's trailing emission
        // carrying the complete input — record it but do not re-stream it.
        if (currentToolCall) {
          const inputData = ev.data.input;
          if (inputData) {
            if (typeof inputData === "object" && Object.keys(inputData).length > 0) {
              currentToolCall.inputStr = JSON.stringify(inputData);
            } else if (typeof inputData === "string" && inputData) {
              currentToolCall.inputStr += inputData;
            }
          }
          if (ev.data.stop) finalizeToolBlock();
          continue;
        }

        // Start new tool_use content block
        const toolUseId = ev.data.toolUseId || `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

        // Kiro re-emits a tool_start with the complete input after the block was
        // already closed. Ignore it — the client has the full call already.
        if (emittedToolIds.has(toolUseId)) continue;
        emittedToolIds.add(toolUseId);

        currentToolCall = {
          id: toolUseId,
          name: ev.data.name || "",
          inputStr: "",
        };
        // Handle input that comes with tool_start
        const inputData = ev.data.input;
        if (inputData) {
          if (typeof inputData === "object" && Object.keys(inputData).length > 0) {
            currentToolCall.inputStr = JSON.stringify(inputData);
          } else if (typeof inputData === "string") {
            currentToolCall.inputStr = inputData;
          }
        }

        res.write(sse("content_block_start", {
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: { type: "tool_use", id: toolUseId, name: ev.data.name || "", input: {} },
        }));

        // If stop is already in this event, finalize immediately
        if (ev.data.stop) finalizeToolBlock();
      } else if (ev.type === "tool_input") {
        if (currentToolCall) {
          const inputData = ev.data.input;
          if (inputData) {
            if (typeof inputData === "object" && Object.keys(inputData).length > 0) {
              currentToolCall.inputStr += JSON.stringify(inputData);
            } else if (typeof inputData === "string") {
              currentToolCall.inputStr += inputData;
            }
          }
          // Stream input as partial JSON delta
          const partial = typeof inputData === "string" ? inputData : (inputData ? JSON.stringify(inputData) : "");
          if (partial) {
            currentToolCall.streamedInput = true;
            res.write(sse("content_block_delta", {
              type: "content_block_delta",
              index: contentBlockIndex,
              delta: { type: "input_json_delta", partial_json: partial },
            }));
          }
        }
      } else if (ev.type === "tool_stop") {
        finalizeToolBlock();
      } else if (ev.type === "stop_reason") {
        kiroStopReason = ev.data || null;
      } else if (ev.type === "usage") {
        if (typeof ev.data === "number") {
          kiroCredits = ev.data;
        } else if (typeof ev.data === "object" && ev.data.usage !== undefined) {
          kiroCredits = ev.data.usage;
        }
      } else if (ev.type === "context_usage") {
        contextUsagePercent = ev.data || 0;
      }
    }
  }

  // Close any open content block
  if (contentBlockOpen) {
    res.write(sse("content_block_stop", {
      type: "content_block_stop",
      index: contentBlockIndex,
    }));
  }

  // Kiro's own stop reason, when it sent one: a reply truncated at max_tokens must
  // not be reported as a clean end_turn.
  const stopReason = anthropicStopReasonFromKiro(kiroStopReason, toolCalls.length > 0);
  const outputTokens = tokensFromChars(outputChars);

  // Emit message_delta (final usage)
  res.write(sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }));

  // Emit message_stop
  res.write(sse("message_stop", { type: "message_stop" }));

  return { credits: kiroCredits, contextUsagePercent, outputTokens, stopReason };
}
/**
 * Collect full Kiro response (non-streaming) and build Anthropic Messages response.
 *
 * @param {ReadableStream|AsyncIterable} body - Kiro response body
 * @param {string} model - Model name
 * @param {number} inputTokens - Estimated input tokens
 * @returns {object} Anthropic Messages API response JSON
 */
export async function collectKiroResponse(body, model, inputTokens = 0) {
  let buffer = "";
  let fullContent = "";
  let toolCalls = [];
  let currentToolCall = null;
  let outputTokens = 0;
  let kiroCredits = 0;
  let contextUsagePercent = 0;
  let kiroStopReason = null;

  const decoder = new TextDecoder();
  const reader = body.getReader ? body.getReader() : null;
  const iterate = reader
    ? async function* () {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      }
    : async function* () {
        for await (const chunk of body) yield chunk;
      };

  for await (const chunk of iterate()) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    buffer += text;

    const { events, remaining } = parseKiroChunk(buffer);
    buffer = remaining;

    for (const ev of events) {
      if (ev.type === "content") {
        fullContent += ev.data;
      } else if (ev.type === "tool_start") {
        // Kiro re-emits a tool_start carrying the complete input after streaming
        // the fragments. Treat a repeat of the same toolUseId as an update, not a
        // new call, otherwise the client sees the tool twice.
        const toolUseId = ev.data.toolUseId || "";
        const inputData = ev.data.input;
        const inputStr = inputData
          ? typeof inputData === "object"
            ? Object.keys(inputData).length
              ? JSON.stringify(inputData)
              : ""
            : String(inputData)
          : "";

        if (currentToolCall && toolUseId && currentToolCall.id === toolUseId) {
          if (inputStr) currentToolCall.inputStr = inputStr;
        } else {
          if (currentToolCall) toolCalls.push(currentToolCall);
          currentToolCall = {
            id: toolUseId || `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
            name: ev.data.name || "",
            inputStr,
          };
        }

        if (ev.data.stop) {
          toolCalls.push(currentToolCall);
          currentToolCall = null;
        }
      } else if (ev.type === "tool_input") {
        if (currentToolCall) {
          const inputData = ev.data.input;
          if (inputData) {
            currentToolCall.inputStr += typeof inputData === "object" ? JSON.stringify(inputData) : String(inputData);
          }
        }
      } else if (ev.type === "tool_stop") {
        if (currentToolCall) {
          toolCalls.push(currentToolCall);
          currentToolCall = null;
        }
      } else if (ev.type === "stop_reason") {
        kiroStopReason = ev.data || null;
      } else if (ev.type === "usage") {
        if (typeof ev.data === "number") {
          kiroCredits = ev.data;
        } else if (typeof ev.data === "object" && ev.data.usage !== undefined) {
          kiroCredits = ev.data.usage;
        }
      } else if (ev.type === "context_usage") {
        contextUsagePercent = ev.data || 0;
      }
    }
  }

  if (currentToolCall) toolCalls.push(currentToolCall);

  // Collapse repeats of the same toolUseId, preferring the entry that carries input.
  const byId = new Map();
  for (const tc of toolCalls) {
    const existing = byId.get(tc.id);
    if (!existing) byId.set(tc.id, tc);
    else if (!existing.inputStr && tc.inputStr) byId.set(tc.id, tc);
  }
  const uniqueToolCalls = [...byId.values()];

  // Text plus tool-call JSON — both are billed output. One conversion at the end;
  // Kiro sends no token counts, so this is an estimate (see tokens.js).
  outputTokens = tokensFromChars(
    fullContent.length +
      uniqueToolCalls.reduce((n, tc) => n + tc.name.length + (tc.inputStr || "").length, 0)
  );

  // Build Anthropic response
  const content = [];
  if (fullContent) {
    content.push({ type: "text", text: fullContent });
  }
  for (const tc of uniqueToolCalls) {
    let input = {};
    try { input = JSON.parse(tc.inputStr || "{}"); } catch { input = {}; }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  const stopReason = anthropicStopReasonFromKiro(kiroStopReason, uniqueToolCalls.length > 0);

  return {
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
    // Kiro-specific usage info (not part of Anthropic spec, for internal tracking)
    _kiro: {
      credits: kiroCredits,
      contextUsagePercent,
    },
  };
}
