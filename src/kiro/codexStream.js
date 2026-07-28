// Kiro stream → Codex (OpenAI Responses API) converters.
//
// The Kiro wire format is the same regardless of which input format produced the
// request, so these reuse parseKiroChunk (stream.js) for the raw-event parsing and
// the toolUseId-collapse logic from collectKiroResponse. They emit Codex Responses
// output items / SSE events directly — no detour through Anthropic format.
//
// Two modes:
//   collectKiroAsCodex  — buffer the stream, return a Responses-format JSON object
//   streamKiroToCodex   — emit Responses SSE events as Kiro events arrive (true
//                         incremental streaming; the old path buffered-then-simulated)

import { randomUUID } from "node:crypto";
import { parseKiroChunk } from "./stream.js";

// ponytail: 3-line async iterator over a ReadableStream/AsyncIterable, duplicated
// from stream.js rather than refactoring the working Claude path. Add a shared
// helper in stream.js if a third consumer appears.
async function* iterate(body) {
  const reader = body.getReader ? body.getReader() : null;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } else {
    for await (const chunk of body) yield chunk;
  }
}

// Parse a Codex tool's accumulated input (object or JSON string) to an arguments
// string for the function_call item. Returns the raw string Codex expects.
function toArgsString(inputStr) {
  if (!inputStr) return "{}";
  try {
    return JSON.stringify(JSON.parse(inputStr));
  } catch {
    return inputStr;
  }
}

// One SSE event line.
function sse(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Collect full Kiro response → Codex Responses-API JSON object.
 *
 * @param {ReadableStream|AsyncIterable} body - Kiro response body
 * @param {string} model - resolved model id
 * @param {string} responseId - the resp_ id to attach
 * @returns {object} { response, credits, contextUsagePercent, outputTokens }
 *   where `response` is the Responses-format object.
 */
export async function collectKiroAsCodex(body, model, responseId) {
  let buffer = "";
  let fullContent = "";
  const toolCalls = []; // { id, toolUseId, name, inputStr }
  let currentToolCall = null;
  let outputTokens = 0;
  let kiroCredits = 0;
  let contextUsagePercent = 0;

  const decoder = new TextDecoder();
  for await (const chunk of iterate(body)) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    buffer += text;
    const { events, remaining } = parseKiroChunk(buffer);
    buffer = remaining;

    for (const ev of events) {
      if (ev.type === "content") {
        fullContent += ev.data;
      } else if (ev.type === "tool_start") {
        // Kiro re-emits tool_start with the complete input after streaming fragments.
        // Same toolUseId = update, not a new call (mirrors collectKiroResponse).
        const toolUseId = ev.data.toolUseId || "";
        const inputData = ev.data.input;
        const inputStr = inputData
          ? typeof inputData === "object"
            ? Object.keys(inputData).length ? JSON.stringify(inputData) : ""
            : String(inputData)
          : "";
        if (currentToolCall && toolUseId && currentToolCall.toolUseId === toolUseId) {
          if (inputStr) currentToolCall.inputStr = inputStr;
        } else {
          if (currentToolCall) toolCalls.push(currentToolCall);
          currentToolCall = {
            id: `fc_${randomUUID().slice(0, 12)}`,
            toolUseId: toolUseId || `call_${randomUUID().slice(0, 8)}`,
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
      } else if (ev.type === "usage") {
        if (typeof ev.data === "number") kiroCredits = ev.data;
        else if (typeof ev.data === "object" && ev.data.usage !== undefined) kiroCredits = ev.data.usage;
      } else if (ev.type === "context_usage") {
        contextUsagePercent = ev.data || 0;
      }
    }
  }
  if (currentToolCall) toolCalls.push(currentToolCall);

  // Collapse repeats of the same toolUseId, preferring the entry with input.
  const byId = new Map();
  for (const tc of toolCalls) {
    const existing = byId.get(tc.toolUseId);
    if (!existing) byId.set(tc.toolUseId, tc);
    else if (!existing.inputStr && tc.inputStr) byId.set(tc.toolUseId, tc);
  }
  const unique = [...byId.values()];

  outputTokens = Math.ceil(fullContent.length / 4);

  // Build Responses output items: function_calls first, then the text message.
  const output = [];
  for (const tc of unique) {
    output.push({
      type: "function_call",
      id: tc.id,
      call_id: tc.toolUseId,
      name: tc.name,
      arguments: toArgsString(tc.inputStr),
      status: "completed",
    });
  }
  if (fullContent) {
    output.push({
      type: "message",
      id: `msg_${randomUUID().slice(0, 12)}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: fullContent, annotations: [] }],
    });
  }

  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: {
      input_tokens: 0,
      output_tokens: outputTokens,
      total_tokens: outputTokens,
    },
    metadata: {},
  };

  return { response, credits: kiroCredits, contextUsagePercent, outputTokens };
}

/**
 * Stream Kiro response body → Codex Responses-API SSE events, written directly to
 * the Express response. True incremental streaming (emits as Kiro events arrive).
 *
 * @param {ReadableStream|AsyncIterable} body - Kiro response body
 * @param {object} res - Express response
 * @param {string} model - resolved model id
 * @param {string} responseId - the resp_ id
 * @returns {object} { credits, contextUsagePercent, outputTokens }
 */
export async function streamKiroToCodex(body, res, model, responseId) {
  let buffer = "";
  let kiroCredits = 0;
  let contextUsagePercent = 0;
  let outputTokens = 0;

  let outputIdx = 0;
  let textItemOpen = false;
  let currentTool = null; // { itemId, callId, name, inputStr, argsStarted }
  const emittedToolIds = new Set(); // Kiro's trailing tool_start repeat → skip

  // response.created + response.in_progress (Codex CLI expects in_progress after created)
  res.write(sse("response.created", {
    type: "response.created",
    response: { id: responseId, object: "response", status: "in_progress", model, output: [] },
  }));
  res.write(sse("response.in_progress", {
    type: "response.in_progress",
    response: { id: responseId, object: "response", status: "in_progress", model, output: [] },
  }));

  const closeTextItem = () => {
    if (!textItemOpen) return;
    res.write(sse("response.output_text.done", {
      type: "response.output_text.done", output_index: outputIdx, content_index: 0, text: "",
    }));
    res.write(sse("response.content_part.done", {
      type: "response.content_part.done", output_index: outputIdx, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }));
    res.write(sse("response.output_item.done", {
      type: "response.output_item.done", output_index: outputIdx,
      item: { type: "message", id: `msg_${randomUUID().slice(0, 12)}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "", annotations: [] }] },
    }));
    outputIdx++;
    textItemOpen = false;
  };

  const finalizeTool = () => {
    if (!currentTool) return;
    const args = toArgsString(currentTool.inputStr || "{}");
    if (!currentTool.argsStarted) {
      res.write(sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta", output_index: outputIdx, item_id: currentTool.itemId, delta: args,
      }));
    }
    res.write(sse("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done", output_index: outputIdx, item_id: currentTool.itemId, arguments: args,
    }));
    res.write(sse("response.output_item.done", {
      type: "response.output_item.done", output_index: outputIdx,
      item: { type: "function_call", id: currentTool.itemId, call_id: currentTool.callId, name: currentTool.name, arguments: args, status: "completed" },
    }));
    outputIdx++;
    currentTool = null;
  };

  const decoder = new TextDecoder();
  for await (const chunk of iterate(body)) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    buffer += text;
    const { events, remaining } = parseKiroChunk(buffer);
    buffer = remaining;

    for (const ev of events) {
      if (ev.type === "content") {
        if (!textItemOpen) {
          res.write(sse("response.output_item.added", {
            type: "response.output_item.added", output_index: outputIdx,
            item: { type: "message", id: `msg_${randomUUID().slice(0, 12)}`, role: "assistant", status: "in_progress", content: [] },
          }));
          res.write(sse("response.content_part.added", {
            type: "response.content_part.added", output_index: outputIdx, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }));
          textItemOpen = true;
        }
        res.write(sse("response.output_text.delta", {
          type: "response.output_text.delta", output_index: outputIdx, content_index: 0, delta: ev.data,
        }));
        outputTokens += Math.ceil(ev.data.length / 4);
      } else if (ev.type === "tool_start") {
        // A new tool call closes any open text item.
        if (textItemOpen) closeTextItem();

        const toolUseId = ev.data.toolUseId || `call_${randomUUID().slice(0, 8)}`;
        // Kiro re-emits tool_start with the complete input after fragments — skip the repeat.
        if (emittedToolIds.has(toolUseId)) {
          // Update input on the in-flight tool if it matches.
          if (currentTool && currentTool.callId === toolUseId) {
            const inputData = ev.data.input;
            if (inputData) currentTool.inputStr = typeof inputData === "object" ? JSON.stringify(inputData) : String(inputData);
          }
          if (ev.data.stop) finalizeTool();
          continue;
        }
        emittedToolIds.add(toolUseId);

        if (currentTool) finalizeTool();
        currentTool = {
          itemId: `fc_${randomUUID().slice(0, 12)}`,
          callId: toolUseId,
          name: ev.data.name || "",
          inputStr: "",
          argsStarted: false,
        };
        const inputData = ev.data.input;
        if (inputData) {
          currentTool.inputStr = typeof inputData === "object" ? JSON.stringify(inputData) : String(inputData);
        }
        res.write(sse("response.output_item.added", {
          type: "response.output_item.added", output_index: outputIdx,
          item: { type: "function_call", id: currentTool.itemId, call_id: currentTool.callId, name: currentTool.name, arguments: "", status: "in_progress" },
        }));
        if (ev.data.stop) finalizeTool();
      } else if (ev.type === "tool_input") {
        if (currentTool) {
          const inputData = ev.data.input;
          const partial = inputData ? (typeof inputData === "object" ? JSON.stringify(inputData) : String(inputData)) : "";
          if (partial) {
            currentTool.inputStr += partial;
            currentTool.argsStarted = true;
            res.write(sse("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta", output_index: outputIdx, item_id: currentTool.itemId, delta: partial,
            }));
          }
        }
      } else if (ev.type === "tool_stop") {
        finalizeTool();
      } else if (ev.type === "usage") {
        if (typeof ev.data === "number") kiroCredits = ev.data;
        else if (typeof ev.data === "object" && ev.data.usage !== undefined) kiroCredits = ev.data.usage;
      } else if (ev.type === "context_usage") {
        contextUsagePercent = ev.data || 0;
      }
    }
  }

  if (textItemOpen) closeTextItem();
  if (currentTool) finalizeTool();

  // response.completed with the terminal status. (Responses API has no [DONE].)
  res.write(sse("response.completed", {
    type: "response.completed",
    response: {
      id: responseId, object: "response", status: "completed", model, output: [],
      usage: { input_tokens: 0, output_tokens: outputTokens, total_tokens: outputTokens },
    },
  }));

  return { credits: kiroCredits, contextUsagePercent, outputTokens };
}
