// Anthropic Messages → Kiro API payload converter
// Minimal port of Python kiro-gateway converters_core.py + converters_anthropic.py
// Handles: text messages, system prompt, tools, tool_use, tool_result

import { randomUUID } from "node:crypto";
import { ORIGIN } from "./config.js";

/**
 * Extract text content from Anthropic content (string or content blocks array).
 */
function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("");
  }
  return String(content);
}

/**
 * Extract system prompt from Anthropic system field (string or content blocks).
 */
function extractSystem(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n");
  }
  return String(system);
}

/**
 * Convert Anthropic tools to Kiro toolSpecification format.
 */
function convertTools(tools) {
  if (!tools || !tools.length) return [];
  return tools.map((t) => ({
    toolSpecification: {
      name: t.name,
      description: t.description || `Tool: ${t.name}`,
      inputSchema: { json: t.input_schema || {} },
    },
  }));
}

/**
 * Convert Anthropic tool_result blocks to Kiro format.
 */
function convertToolResults(blocks) {
  const results = [];
  for (const b of blocks) {
    if (b.type !== "tool_result") continue;
    let text = "";
    if (typeof b.content === "string") {
      text = b.content;
    } else if (Array.isArray(b.content)) {
      text = b.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("");
    }
    results.push({
      content: [{ text: text || "(empty result)" }],
      status: b.is_error ? "error" : "success",
      toolUseId: b.tool_use_id || "",
    });
  }
  return results;
}

/**
 * Extract tool_use blocks from assistant content → Kiro toolUses format.
 */
function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  const uses = [];
  for (const b of content) {
    if (b.type !== "tool_use") continue;
    uses.push({
      name: b.name,
      input: b.input || {},
      toolUseId: b.id || "",
    });
  }
  return uses;
}

/**
 * Build a Kiro `generateAssistantResponse` payload from already-normalized inputs.
 *
 * Shared by both the Anthropic-Messages path (anthropicToKiro) and the Codex
 * Responses-API path (codexToKiro). These two steps happen before calling here:
 *   1. Normalize the input format into alternating user/assistant turns.
 *   2. For each turn, extract toolUses (assistant turns) and toolResults
 *      (user turns) in Kiro wire format.
 *
 * @param {object} options
 * @param {string} options.systemPrompt - system instructions (prepended to first user)
 * @param {object[]} options.history - Kiro-format history entries:
 *   { userInputMessage: { content, modelId, origin, userInputMessageContext? } } or
 *   { assistantResponseMessage: { content, toolUses? } }
 * @param {string} options.currentText - current user message text
 * @param {object[]} [options.currentToolResults] - Kiro-format toolResults for
 *   the current message: [{ content: [{ text }], status, toolUseId }]
 * @param {object[]} [options.tools] - Anthropic-format tool definitions
 *   (each { name, description, input_schema }) — converted to toolSpecification
 * @param {string} options.model - resolved model id
 * @param {string} options.conversationId - stable conversation id
 * @returns {object} Kiro API payload
 */
export function buildKiroConversation({ systemPrompt, history, currentText, currentToolResults, tools, model, conversationId }) {
  let finalCurrentText = currentText || "(empty placeholder)";

  // Prepend system prompt to the first user message (in history, or current)
  if (systemPrompt) {
    if (history.length > 0) {
      const first = history[0];
      if (first.userInputMessage) {
        first.userInputMessage.content = systemPrompt + "\n\n" + first.userInputMessage.content;
      }
    } else {
      finalCurrentText = systemPrompt + "\n\n" + finalCurrentText;
    }
  }

  const userInputMessage = {
    content: finalCurrentText,
    modelId: model,
    origin: ORIGIN,
  };

  const ctx = {};
  if (tools && tools.length) ctx.tools = convertTools(tools);
  if (currentToolResults && currentToolResults.length) ctx.toolResults = currentToolResults;
  if (Object.keys(ctx).length) userInputMessage.userInputMessageContext = ctx;

  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage },
    },
  };
  if (history.length) payload.conversationState.history = history;
  return payload;
}

/**
 * Main converter: Anthropic Messages request → Kiro generateAssistantResponse payload.
 *
 * Note: no profileArn is sent — API-key auth resolves the profile server-side and
 * rejects requests that carry one.
 *
 * @param {object} anthropicReq - Anthropic Messages API request body
 * @returns {object} Kiro API payload
 */
export function anthropicToKiro(anthropicReq) {
  const { model, messages, system, tools } = anthropicReq;
  const systemPrompt = extractSystem(system);

  // Normalize roles
  const unified = messages.map((m) => ({ role: m.role, content: m.content }));
  if (unified.length > 0 && unified[0].role !== "user") {
    unified.unshift({ role: "user", content: "(context)" });
  }
  const alternated = ensureAlternating(unified);

  // Split: history = all except last, current = last
  const historyMsgs = alternated.slice(0, -1);
  const currentMsg = alternated[alternated.length - 1] || { role: "user", content: "" };

  // Build Kiro-format history entries (Anthropic content-block format)
  const history = [];
  for (const msg of historyMsgs) {
    if (msg.role === "user") {
      const text = extractText(msg.content) || "(empty placeholder)";
      const entry = { content: text, modelId: model, origin: ORIGIN };
      if (Array.isArray(msg.content)) {
        const toolResults = convertToolResults(msg.content);
        if (toolResults.length) entry.userInputMessageContext = { toolResults };
      }
      history.push({ userInputMessage: entry });
    } else if (msg.role === "assistant") {
      const text = extractText(msg.content) || "(empty placeholder)";
      const entry = { content: text };
      if (Array.isArray(msg.content)) {
        const toolUses = extractToolUses(msg.content);
        if (toolUses.length) entry.toolUses = toolUses;
      }
      history.push({ assistantResponseMessage: entry });
    }
  }

  const currentText = extractText(currentMsg.content);
  let currentToolResults = [];
  if (Array.isArray(currentMsg.content)) currentToolResults = convertToolResults(currentMsg.content);

  return buildKiroConversation({
    systemPrompt,
    history,
    currentText,
    currentToolResults: currentToolResults.length ? currentToolResults : undefined,
    tools,
    model,
    conversationId: generateConversationId(messages),
  });
}

/**
 * Ensure alternating user/assistant messages.
 * Insert placeholders where needed.
 */
export function ensureAlternating(messages) {
  if (!messages.length) return messages;
  const result = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];
    if (prev.role === curr.role) {
      // Insert opposite role placeholder
      if (curr.role === "user") {
        result.push({ role: "assistant", content: "(continued)" });
      } else {
        result.push({ role: "user", content: "(continued)" });
      }
    }
    result.push(curr);
  }
  // Ensure last message is user (Kiro requires user as current)
  if (result[result.length - 1].role !== "user") {
    // Move last assistant to history and add user placeholder
    result.push({ role: "user", content: "(awaiting response)" });
  }
  return result;
}

/**
 * Generate stable conversation ID from messages.
 */
function generateConversationId(messages) {
  if (!messages || !messages.length) return randomUUID();
  // Use first message content hash for stability
  const first = typeof messages[0].content === "string"
    ? messages[0].content.slice(0, 100)
    : JSON.stringify(messages[0].content).slice(0, 100);
  let hash = 0;
  for (let i = 0; i < first.length; i++) {
    hash = (hash * 31 + first.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0") + randomUUID().slice(8);
}
