// Codex (OpenAI Responses API) → Kiro API payload converter.
//
// Codex speaks the Responses API; Kiro speaks its own AWS-shaped wire protocol.
// This maps Codex `input` items DIRECTLY to Kiro conversation turns — no detour
// through Anthropic Messages format. The Kiro payload assembly itself is shared
// with the Anthropic path via buildKiroConversation (converter.js).
//
// Handles: instructions (system), message items, function_call / custom_tool_call
// (→ toolUses), function_call_output / custom_tool_call_output (→ toolResults),
// and tools from BOTH wire shapes:
//   - old:  top-level `tools: [...]`
//   - new:  an `input` item `{type:"additional_tools", role:"developer", tools:[...]}`
//           (Codex CLI >= ~0.14x sends tools this way and omits `instructions`)

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

// Build the Kiro-format toolUses for one or more function_call / custom_tool_call items
// in a single assistant turn. toolUseId = call_id — this linkage is what lets Kiro match
// a later toolResult to its call.
// A custom_tool_call carries freeform text in `input`; it is re-wrapped as { input }
// to match the schema the tool was advertised with (FREEFORM_SCHEMA).
// `advertisedFor` maps a namespaced call (namespace + name, e.g. mcp__trailmem +
// trailmem_query) back to the flat name the tool was advertised to Kiro under, so a
// tool call replayed from history still matches a tool in the payload's tool list.
function functionCallsToToolUses(items, advertisedFor) {
  return items.map((it) => ({
    name: advertisedName(it, advertisedFor),
    input: it.type === "custom_tool_call" ? { input: it.input ?? "" } : parseArgs(it.arguments),
    toolUseId: it.call_id || "",
  }));
}

function advertisedName(item, advertisedFor) {
  if (item.namespace && advertisedFor) {
    return advertisedFor.get(`${item.namespace}\u0000${item.name}`) || item.name || "";
  }
  return item.name || "";
}

// Build the Kiro-format toolResults for one or more function_call_output /
// custom_tool_call_output items in a single user turn. toolUseId = call_id links each
// result back to its call.
function functionOutputsToToolResults(items) {
  return items.map((it) => ({
    content: [{ text: outputToText(it.output) || "(empty result)" }],
    status: it.is_error ? "error" : "success",
    toolUseId: it.call_id || "",
  }));
}

// Codex tool output is a string, or (newer CLIs) an object like
// { content: [{type:"input_text", text}], success } — flatten either to text.
function outputToText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output.content)) return codexContentToText(output.content);
  if (typeof output.output === "string") return output.output;
  return JSON.stringify(output);
}

// A freeform ("custom") Codex tool takes raw text, not JSON. Kiro's toolSpecification
// requires a JSON schema, so freeform tools are advertised as a single string field
// and unwrapped again on the way back (see codexStream.js).
const FREEFORM_SCHEMA = {
  type: "object",
  properties: { input: { type: "string", description: "The raw tool input, verbatim. Not JSON-wrapped." } },
  required: ["input"],
};

// Kiro's toolSpecification names are capped; keep flattened namespace names inside it.
const MAX_TOOL_NAME = 64;

// Pick the name a tool is advertised to Kiro under. The bare name is preferred —
// it is what the model reads when choosing a tool, and in real Codex traffic
// (measured 2026-08-03: 64 tools across 8 namespaces) nothing collides. On a
// collision the namespace disambiguates; the tail is kept when that overflows,
// because the tool's own name is the informative part.
function uniqueToolName(name, namespace, taken) {
  let candidate = taken.has(name) && namespace ? `${namespace}__${name}` : name;
  if (candidate.length > MAX_TOOL_NAME) candidate = candidate.slice(-MAX_TOOL_NAME);
  let n = 2;
  while (taken.has(candidate)) {
    const suffix = `_${n++}`;
    candidate = candidate.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
  }
  return candidate;
}

/**
 * Collect Codex tool definitions from a /v1/responses body, from both wire shapes,
 * and convert them to the Anthropic shape buildKiroConversation expects.
 *
 * @param {object} reqBody - Codex /v1/responses body
 * @returns {{tools: object[], freeform: Set<string>, namespaced: Map<string, {namespace: string, name: string}>}}
 *   `freeform` names the tools that must be answered with a `custom_tool_call` item
 *   instead of a `function_call`; `namespaced` maps the flat name a tool was
 *   advertised under back to its namespace + original name, which the reply has to
 *   carry or Codex cannot route the call.
 */
export function collectCodexTools(reqBody) {
  const tools = [];
  const freeform = new Set();
  const namespaced = new Map();
  const taken = new Set();

  const add = (t, namespace = null) => {
    if (!t || typeof t !== "object" || !t.name) return;
    const type = t.type || "function";

    if (type === "namespace") {
      // A namespace groups one provider's tools. This is NOT only sub-agent
      // orchestration: EVERY MCP server arrives this way (mcp__trailmem,
      // mcp__graphify, …), and so do Codex's own app tools. Skipping the type, as
      // this converter used to, silently stripped every MCP tool from the request —
      // the model was told it had no tools at all. Kiro's tool list is flat, so the
      // inner tools are hoisted and the namespace is restored on the way back.
      for (const inner of t.tools || []) add(inner, t.name);
      return;
    }
    if (type !== "function" && type !== "custom") return;
    // Skipped: `web_search` (no name, no Kiro equivalent) and any future type.

    const advertised = uniqueToolName(t.name, namespace, taken);
    taken.add(advertised);
    if (namespace) namespaced.set(advertised, { namespace, name: t.name });

    if (type === "function") {
      tools.push({
        name: advertised,
        description: t.description || `Tool: ${t.name}`,
        input_schema: t.parameters || { type: "object", properties: {} },
      });
    } else {
      freeform.add(advertised);
      tools.push({
        name: advertised,
        description: `${t.description || `Tool: ${t.name}`}\n\nCall this tool with a single JSON field "input" whose value is the raw tool input as a plain string.`,
        input_schema: FREEFORM_SCHEMA,
      });
    }
  };

  for (const t of reqBody?.tools || []) add(t);
  if (Array.isArray(reqBody?.input)) {
    for (const item of reqBody.input) {
      if (item?.type === "additional_tools") for (const t of item.tools || []) add(t);
    }
  }
  return { tools, freeform, namespaced };
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
  const { input, instructions } = reqBody;
  const systemPrompt = instructions || "";
  const { tools, namespaced } = collectCodexTools(reqBody);
  // Reverse of `namespaced`: a call replayed from history carries { namespace, name },
  // and Kiro must see the flat name the tool was advertised under.
  const advertisedFor = new Map();
  for (const [advertised, { namespace, name }] of namespaced) {
    advertisedFor.set(`${namespace}\u0000${name}`, advertised);
  }

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
        rawTurns.push({ role: "assistant", text: "", toolUses: functionCallsToToolUses(pendingAssistantCalls, advertisedFor), toolResults: [] });
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
        // Kiro only knows user/assistant. Codex carries its system prompt, AGENTS.md
        // and hook output as role "developer" — folding those into user turns keeps
        // them in the conversation (dropping them left the model with no instructions
        // and no knowledge of its tools).
        const role = item.role === "assistant" ? "assistant" : "user";
        rawTurns.push({ role, text: codexContentToText(item.content), toolUses: [], toolResults: [] });
      } else if (type === "function_call" || type === "custom_tool_call") {
        flushUser();
        pendingAssistantCalls.push(item);
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        flushAssistant();
        pendingUserOutputs.push(item);
      }
      // additional_tools (handled by collectCodexTools), reasoning and other types:
      // ignored (no Kiro equivalent)
    }
    flushAssistant();
    flushUser();
  }

  // Codex sends its system prompt, AGENTS.md and hook output as a run of separate
  // developer/user items. Merging same-role neighbours keeps them as one turn instead
  // of forcing an "(empty placeholder)" assistant turn between each — fewer fake turns,
  // fewer tokens.
  const merged = [];
  for (const turn of rawTurns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === turn.role) {
      prev.text = [prev.text, turn.text].filter(Boolean).join("\n\n");
      prev.toolUses = [...(prev.toolUses || []), ...(turn.toolUses || [])];
      prev.toolResults = [...(prev.toolResults || []), ...(turn.toolResults || [])];
      continue;
    }
    merged.push({ ...turn });
  }

  // Ensure first is user and roles alternate (Kiro requirement). ensureAlternating
  // inserts placeholders, which is fine — the builder reads .text from these turns.
  // ponytail: reuses the Anthropic path's alternation fixup verbatim.
  if (merged.length > 0 && merged[0].role !== "user") {
    merged.unshift({ role: "user", text: "(context)", toolUses: [], toolResults: [] });
  }
  const alternated = ensureAlternating(merged);

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
    tools: tools.length ? tools : undefined,
    model,
    conversationId: codexConversationId(input),
  });
}
