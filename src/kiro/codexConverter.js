// Codex (OpenAI Responses API) → Kiro API payload converter.
//
// Codex speaks the Responses API; Kiro speaks its own AWS-shaped wire protocol.
// This maps Codex `input` items DIRECTLY to Kiro conversation turns — no detour
// through Anthropic Messages format. The Kiro payload assembly itself is shared
// with the Anthropic path via buildKiroConversation (converter.js).
//
// Handles: instructions (system), message items, function_call (→ toolUses),
// function_call_output (→ toolResults), and tools.

import { randomUUID } from "node:crypto";
import { buildKiroConversation, ensureAlternating } from "./converter.js";

// Normalize a Codex message item's content (string or array of text blocks) to text.
function codexContentToText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

// Parse Codex tool arguments (a JSON string) into an object, falling back to {}.
function parseArgs(argumentsStr) {
  if (!argumentsStr) return {};
  try {
    return JSON.parse(argumentsStr);
  } catch {
    return {};
  }
}

// Build the Kiro-format toolUses for one or more function_call items in a single
// assistant turn. toolUseId = call_id — this linkage is what lets Kiro match a
// later toolResult to its call (the bug today: results were dropped entirely).
function functionCallsToToolUses(items) {
  return items.map((it) => ({
    name: it.name || "",
    input: parseArgs(it.arguments),
    toolUseId: it.call_id || "",
  }));
}

// Build the Kiro-format toolResults for one or more function_call_output items in a
// single user turn. toolUseId = call_id links each result back to its call.
function functionOutputsToToolResults(items) {
  return items.map((it) => ({
    content: [{ text: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "") || "(empty result)" }],
    status: it.is_error ? "error" : "success",
    toolUseId: it.call_id || "",
  }));
}

// Convert Codex Responses-API tool definitions ({type:"function", name, description,
// parameters}) to the Anthropic-shape buildKiroConversation expects.
function codexToolsToAnthropic(tools) {
  if (!tools || !tools.length) return undefined;
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.name || "",
      description: t.description || "",
      input_schema: t.parameters || { type: "object", properties: {} },
    }));
}

// Stable conversation id from the first input item (mirrors generateConversationId).
function codexConversationId(input) {
  const first = typeof input === "string"
    ? input.slice(0, 100)
    : (input?.[0] ? JSON.stringify(input[0]).slice(0, 100) : "");
  let hash = 0;
  for (let i = 0; i < first.length; i++) hash = (hash * 31 + first.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(16).padStart(8, "0") + randomUUID().slice(8);
}

/**
 * Convert a Codex Responses-API request body → Kiro generateAssistantResponse payload.
 *
 * @param {object} reqBody - Codex /v1/responses body: { input, instructions, tools,
 *   max_output_tokens, ... }
 * @param {string} model - resolved Kiro catalog id
 * @returns {object} Kiro API payload
 */
export function codexToKiro(reqBody, model) {
  const { input, instructions, tools } = reqBody;
  const systemPrompt = instructions || "";

  // Normalize Codex `input` (string | array of items) into alternating
  // user/assistant turns. Consecutive same-role items (e.g. several tool_result
  // outputs, or several function_calls) collapse into one turn carrying all of them.
  const rawTurns = [];
  if (typeof input === "string") {
    rawTurns.push({ role: "user", text: input, toolUses: [], toolResults: [] });
  } else if (Array.isArray(input)) {
    let pendingAssistantCalls = [];
    let pendingUserOutputs = [];
    const flushAssistant = () => {
      if (pendingAssistantCalls.length) {
        rawTurns.push({ role: "assistant", text: "", toolUses: functionCallsToToolUses(pendingAssistantCalls), toolResults: [] });
        pendingAssistantCalls = [];
      }
    };
    const flushUser = () => {
      if (pendingUserOutputs.length) {
        rawTurns.push({ role: "user", text: "", toolUses: [], toolResults: functionOutputsToToolResults(pendingUserOutputs) });
        pendingUserOutputs = [];
      }
    };
    for (const item of input) {
      if (typeof item === "string") {
        flushAssistant();
        flushUser();
        rawTurns.push({ role: "user", text: item, toolUses: [], toolResults: [] });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const type = item.type || "";
      if (type === "message") {
        flushAssistant();
        flushUser();
        rawTurns.push({ role: item.role || "user", text: codexContentToText(item.content), toolUses: [], toolResults: [] });
      } else if (type === "function_call") {
        flushUser();
        pendingAssistantCalls.push(item);
      } else if (type === "function_call_output") {
        flushAssistant();
        pendingUserOutputs.push(item);
      }
      // reasoning / other types: ignored (no Kiro equivalent)
    }
    flushAssistant();
    flushUser();
  }

  // Ensure first is user and roles alternate (Kiro requirement). ensureAlternating
  // inserts placeholders, which is fine — the builder reads .text from these turns.
  // ponytail: reuses the Anthropic path's alternation fixup verbatim.
  if (rawTurns.length > 0 && rawTurns[0].role !== "user") {
    rawTurns.unshift({ role: "user", text: "(context)", toolUses: [], toolResults: [] });
  }
  const alternated = ensureAlternating(rawTurns);

  // Split history/current
  const historyTurns = alternated.slice(0, -1);
  const currentTurn = alternated[alternated.length - 1] || { role: "user", text: "", toolUses: [], toolResults: [] };

  // Build Kiro-format history entries
  const history = [];
  for (const turn of historyTurns) {
    const toolUses = turn.toolUses || [];
    const toolResults = turn.toolResults || [];
    if (turn.role === "user") {
      const text = turn.text || (toolResults.length ? "" : "(empty placeholder)");
      const entry = { content: text, modelId: model, origin: "KIRO_CLI" };
      if (toolResults.length) entry.userInputMessageContext = { toolResults };
      history.push({ userInputMessage: entry });
    } else if (turn.role === "assistant") {
      const text = turn.text || (toolUses.length ? "" : "(empty placeholder)");
      const entry = { content: text };
      if (toolUses.length) entry.toolUses = toolUses;
      history.push({ assistantResponseMessage: entry });
    }
  }

  return buildKiroConversation({
    systemPrompt,
    history,
    currentText: currentTurn.text,
    currentToolResults: currentTurn.toolResults?.length ? currentTurn.toolResults : undefined,
    tools: codexToolsToAnthropic(tools),
    model,
    conversationId: codexConversationId(input),
  });
}
