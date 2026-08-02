// Bidirectional OpenAI Chat Completions <-> Anthropic Messages translation.
//
// WHY THIS EXISTS
// Until this module landed, a provider only worked on the route whose wire shape
// it already spoke (enforced by TOOL_PROVIDER_TYPES in config/keysStore.js). An
// anthropic-compat provider on the openai/codex slot produced an OpenAI body
// posted to /messages (400 "max_tokens: field required" from a real provider) and,
// on the codex path, HTTP 200 with `output: []` because the Anthropic reply had no
// `choices`. With the mapping below, either protocol can serve either route:
//   direction 1 (chatToAnthropic*)  — an anthropic-compat provider serves
//                                     /v1/chat/completions and /v1/responses
//   direction 2 (anthropicToChat*)  — an openai-compat / local-openai provider
//                                     serves /v1/messages (Claude Code)
// The adapters in adapters/bridge.js wire these in; registry.js picks a bridged
// adapter when the route's protocol differs from the provider's.
//
// HARD RULE, inherited from the bug that started this work: a translation must
// never turn an unusable upstream reply into a successful-looking empty answer.
// Anything that cannot be mapped faithfully throws — 400 when the CLIENT sent
// something untranslatable, 502 when the UPSTREAM did.
//
// SILENTLY DROPPED (no semantic equivalent, harmless to omit):
//   chat -> anthropic : presence_penalty, frequency_penalty, logit_bias, seed,
//                       service_tier, store, prediction, stream_options
//   anthropic -> chat : top_k, thinking (budget config), cache_control,
//                       container/mcp_servers, tool_result.is_error
// REJECTED with 400 (dropping them would change the answer the client asked for):
//   chat -> anthropic : n>1, response_format other than "text", logprobs
//   anthropic -> chat : document blocks (PDF input), Anthropic server tools
//                       (web_search/computer/etc. — no Chat Completions form)
// THINKING / REASONING
//   Anthropic `thinking` blocks have no Chat Completions slot; they are surfaced
//   as the de-facto `reasoning_content` field (which routes/responses.js already
//   turns into a Codex reasoning item) and never folded into the answer text.
//   The reverse is NOT done: an Anthropic thinking block requires a provider
//   signature we cannot forge, so `reasoning_content` from an OpenAI provider is
//   dropped rather than replayed to Claude Code as an unsigned thinking block.

import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import { anthropicSseEvents } from "./anthropicSse.js";
import { openAiSseEvents, writeSse, writeSseEvent } from "./stream.js";

// Anthropic requires max_tokens; OpenAI clients routinely omit it. 4096 is the
// documented Claude default ceiling for short chat answers — high enough not to
// truncate normal replies, low enough not to invite a runaway bill.
const DEFAULT_MAX_TOKENS = 4096;

function shortId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function preview(value) {
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return String(value).slice(0, 300);
  }
}

// A tool schema must be a JSON-Schema object on both sides.
function normaliseSchema(schema) {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema.type ? schema : { type: "object", properties: {}, ...schema };
  }
  return { type: "object", properties: {} };
}

// tool_call arguments (a JSON *string* on the OpenAI side) -> tool_use.input
// (an object on the Anthropic side). status says whose fault a bad value is.
function parseToolArguments(args, name, status = 400) {
  if (args == null || args === "") return {};
  if (typeof args === "object") return args;
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch {
    throw new ApiError(
      status,
      `Tool call "${name || "?"}" has arguments that are not valid JSON, so they cannot become an Anthropic tool_use input object`
    );
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return { value: parsed }; // scalar/array arguments are not expressible as tool_use.input
}

// ---------------------------------------------------------------------------
// Direction 1 — OpenAI Chat Completions -> Anthropic Messages
// ---------------------------------------------------------------------------

function rejectUntranslatableChatFields(chat) {
  if (chat.n != null && Number(chat.n) !== 1) {
    throw new ApiError(
      400,
      `n=${chat.n} is not supported on this provider: the Anthropic Messages API returns exactly one completion. Send n=1 and issue separate requests.`
    );
  }
  const format = chat.response_format?.type;
  if (format && format !== "text") {
    throw new ApiError(
      400,
      `response_format "${format}" is not supported on this provider: the Anthropic Messages API has no structured-output equivalent, and silently ignoring it would return free-form text where the client expects JSON. Use a tool/function call instead.`
    );
  }
  if (chat.logprobs || chat.top_logprobs) {
    throw new ApiError(400, "logprobs are not available on this provider (the Anthropic Messages API does not return them)");
  }
}

function imageBlockFromUrl(url) {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUrl) {
    return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
  }
  if (/^https?:\/\//.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  throw new ApiError(400, "Unsupported image content: only base64 data: URLs and http(s) URLs can be sent to an Anthropic provider");
}

function chatContentToBlocks(content) {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }];

  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" || part.type === "input_text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" || part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url || part.url || "";
      blocks.push(imageBlockFromUrl(String(url)));
    } else if (part.type === "refusal") {
      if (part.refusal) blocks.push({ type: "text", text: part.refusal });
    } else if (part.text) {
      blocks.push({ type: "text", text: part.text });
    }
  }
  return blocks;
}

function stringifyToolOutput(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? JSON.stringify(part)))
      .join("\n");
  }
  return JSON.stringify(content);
}

// "none" is returned as the string "none" so the caller can decide between
// dropping the tool definitions entirely (maximum provider compatibility) and
// sending tool_choice {type:"none"} (required when the history already contains
// tool_use blocks, which Anthropic rejects without matching tool definitions).
function chatToolChoiceToAnthropic(choice) {
  if (choice == null || choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return "none";
  if (typeof choice === "object") {
    const name = choice.function?.name || choice.name;
    if (name) return { type: "tool", name };
    if (choice.type === "any" || choice.type === "auto" || choice.type === "none") return choice;
  }
  return { type: "auto" };
}

export function chatToAnthropicRequest(chat) {
  if (!chat || typeof chat !== "object") throw new ApiError(400, "Invalid request body");
  rejectUntranslatableChatFields(chat);

  const systemBlocks = [];
  const messages = [];
  let hasToolUse = false;

  // Anthropic wants alternating turns; consecutive same-role messages (very
  // common once tool results are spliced in) are merged into one turn.
  const pushTurn = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const message of chat.messages || []) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "system" || message.role === "developer") {
      systemBlocks.push(...chatContentToBlocks(message.content));
      continue;
    }

    if (message.role === "tool" || message.role === "function") {
      pushTurn("user", [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id || message.name || "",
          content: stringifyToolOutput(message.content),
        },
      ]);
      continue;
    }

    if (message.role === "assistant") {
      const blocks = chatContentToBlocks(message.content);
      for (const call of message.tool_calls || []) {
        if (!call || (call.type && call.type !== "function" && call.type !== "custom")) continue;
        hasToolUse = true;
        blocks.push({
          type: "tool_use",
          id: call.id || shortId("toolu"),
          name: call.function?.name || call.name || "",
          input: parseToolArguments(call.function?.arguments ?? call.input, call.function?.name || call.name),
        });
      }
      pushTurn("assistant", blocks);
      continue;
    }

    pushTurn("user", chatContentToBlocks(message.content));
  }

  if (!messages.length) {
    throw new ApiError(400, "Request has no user or assistant messages; the Anthropic Messages API requires at least one");
  }

  const request = {
    model: chat.model,
    max_tokens: chat.max_tokens ?? chat.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (systemBlocks.length) request.system = systemBlocks;
  if (chat.temperature != null) request.temperature = chat.temperature;
  if (chat.top_p != null) request.top_p = chat.top_p;
  if (chat.stream) request.stream = true;
  if (chat.stop != null) {
    request.stop_sequences = Array.isArray(chat.stop) ? chat.stop.map(String) : [String(chat.stop)];
  }
  if (chat.user) request.metadata = { user_id: String(chat.user) };

  const tools = (chat.tools || [])
    .filter((tool) => (tool?.type || "function") === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      input_schema: normaliseSchema(tool.function.parameters),
    }));

  if (tools.length) {
    const choice = chatToolChoiceToAnthropic(chat.tool_choice);
    if (choice === "none") {
      // Definitions are still required whenever the history carries tool_use /
      // tool_result blocks, so keep them and forbid new calls explicitly.
      // Otherwise drop them entirely, which every Anthropic clone accepts.
      if (hasToolUse) {
        request.tools = tools;
        request.tool_choice = { type: "none" };
      }
    } else {
      request.tools = tools;
      request.tool_choice =
        chat.parallel_tool_calls === false ? { ...choice, disable_parallel_tool_use: true } : choice;
    }
  }

  return request;
}

// Anthropic stop_reason -> OpenAI finish_reason.
const CHAT_FINISH_REASON = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

function chatFinishReason(stopReason, hasToolCalls) {
  if (stopReason && CHAT_FINISH_REASON[stopReason]) return CHAT_FINISH_REASON[stopReason];
  return hasToolCalls ? "tool_calls" : "stop";
}

// Anthropic counts cache reads/writes OUTSIDE input_tokens; OpenAI counts cached
// tokens INSIDE prompt_tokens. cache_creation_tokens is a non-standard detail
// field so lib/stream.js openAiUsage() can still price cache writes correctly.
export function anthropicUsageToChat(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const prompt = (usage.input_tokens || 0) + cacheRead + cacheWrite;
  const completion = usage.output_tokens || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cacheRead || cacheWrite
      ? {
          prompt_tokens_details: {
            cached_tokens: cacheRead,
            ...(cacheWrite ? { cache_creation_tokens: cacheWrite } : {}),
          },
        }
      : {}),
  };
}

function assertAnthropicMessage(body) {
  if (body?.type === "error" || body?.error) {
    throw new ApiError(502, `Upstream returned an Anthropic error instead of a message: ${preview(body.error || body)}`);
  }
  if (!body || !Array.isArray(body.content) || !body.content.length) {
    throw new ApiError(
      502,
      `Upstream reply is not a usable Anthropic message (no content blocks): ${preview(body)}`
    );
  }
}

export function anthropicToChatResponse(body, { model } = {}) {
  assertAnthropicMessage(body);

  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];

  for (const block of body.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      if (block.text) textParts.push(block.text);
    } else if (block.type === "thinking") {
      if (block.thinking) thinkingParts.push(block.thinking);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || shortId("call"),
        type: "function",
        function: { name: block.name || "", arguments: JSON.stringify(block.input ?? {}) },
      });
    }
    // redacted_thinking / server_tool_use / *_tool_result: no Chat form, skipped
  }

  const text = textParts.join("");
  if (!text && !toolCalls.length) {
    throw new ApiError(
      502,
      `Upstream returned a message with no text and no tool calls (only ${body.content.map((b) => b?.type).join(", ") || "nothing"})`
    );
  }

  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const reasoning = thinkingParts.join("");
  if (reasoning) message.reasoning_content = reasoning;

  return {
    id: body.id || shortId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || model || null,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: chatFinishReason(body.stop_reason, toolCalls.length > 0),
      },
    ],
    usage: anthropicUsageToChat(body.usage),
  };
}

// Anthropic Messages SSE -> OpenAI Chat Completions SSE, streamed straight to
// the client. Returns { responseModel, responseId, usage } with usage in OpenAI
// shape so routes/proxy.js can keep using openAiUsage() for the request log.
export async function pipeAnthropicSseAsChat(upstream, res, { model, includeUsage = false } = {}) {
  const created = Math.floor(Date.now() / 1000);
  let responseId = null;
  let responseModel = null;
  let usage = null;
  let stopReason = null;
  let toolIndex = -1;
  let sentContent = false;
  let upstreamError = null;
  const blocks = new Map(); // anthropic block index -> { kind, toolIndex }

  const chunk = (delta, finishReason = null) => ({
    id: responseId || "chatcmpl_bridge",
    object: "chat.completion.chunk",
    created,
    model: responseModel || model || null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  });
  const send = (payload) => writeSse(res, JSON.stringify(payload));

  for await (const event of anthropicSseEvents(upstream)) {
    if (event.type === "error") {
      upstreamError = event.error?.message || preview(event.error || event);
      break;
    }

    if (event.type === "message_start") {
      responseId = responseId || event.message?.id || null;
      responseModel = responseModel || event.message?.model || null;
      if (event.message?.usage) usage = { ...event.message.usage };
      await send(chunk({ role: "assistant", content: "" }));
      continue;
    }

    if (event.type === "content_block_start") {
      const block = event.content_block || {};
      if (block.type === "tool_use") {
        toolIndex += 1;
        blocks.set(event.index, { kind: "tool_use", toolIndex });
        await send(
          chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: block.id || shortId("call"),
                type: "function",
                function: { name: block.name || "", arguments: "" },
              },
            ],
          })
        );
        sentContent = true;
      } else {
        blocks.set(event.index, { kind: block.type });
        // Some Anthropic clones put the whole text in content_block_start
        // instead of emitting deltas.
        if (block.type === "text" && block.text) {
          await send(chunk({ content: block.text }));
          sentContent = true;
        }
      }
      continue;
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta || {};
      const info = blocks.get(event.index);
      if (delta.type === "text_delta" && delta.text) {
        await send(chunk({ content: delta.text }));
        sentContent = true;
      } else if (delta.type === "input_json_delta" && info?.kind === "tool_use") {
        await send(
          chunk({ tool_calls: [{ index: info.toolIndex, function: { arguments: delta.partial_json || "" } }] })
        );
        sentContent = true;
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        await send(chunk({ reasoning_content: delta.thinking }));
      }
      continue;
    }

    if (event.type === "message_delta") {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      if (event.usage) usage = { ...usage, ...event.usage };
      continue;
    }
    // message_stop / ping: nothing to forward
  }

  // Never let a broken or empty upstream stream look like a clean finish: no
  // finish_reason chunk, an explicit error payload instead. `failed` is returned
  // so the route logs the request as an error rather than a success.
  if (upstreamError || !sentContent) {
    const message =
      upstreamError || "Upstream produced no content while streaming (no text and no tool calls)";
    await send({
      error: { message, type: upstreamError ? "upstream_error" : "upstream_empty_response" },
    });
    await writeSse(res, "[DONE]");
    return { responseModel, responseId, usage: null, failed: true, error: message };
  }

  await send(chunk({}, chatFinishReason(stopReason, toolIndex >= 0)));

  const chatUsage = anthropicUsageToChat(usage);
  if (includeUsage && chatUsage) {
    await send({
      id: responseId || "chatcmpl_bridge",
      object: "chat.completion.chunk",
      created,
      model: responseModel || model || null,
      choices: [],
      usage: chatUsage,
    });
  }
  await writeSse(res, "[DONE]");

  return { responseModel, responseId, usage: chatUsage };
}

// ---------------------------------------------------------------------------
// Direction 2 — Anthropic Messages -> OpenAI Chat Completions
// ---------------------------------------------------------------------------

function anthropicTextFromBlocks(blocks) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => (typeof block === "string" ? block : block?.type === "text" ? block.text || "" : ""))
    .filter(Boolean)
    .join("\n");
}

function imageUrlFromAnthropicSource(source) {
  if (source?.type === "base64" && source.data) {
    return `data:${source.media_type || "image/png"};base64,${source.data}`;
  }
  if (source?.type === "url" && source.url) return source.url;
  throw new ApiError(400, "Unsupported image source: only base64 and url image blocks can be sent to an OpenAI-format provider");
}

// A tool_result may itself contain image blocks. OpenAI's role:"tool" message
// takes text only, so images are named rather than dropped in silence.
function toolResultToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      if (block?.type === "image") return "[image in tool result omitted: OpenAI tool messages carry text only]";
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

// Keep a turn as a plain string when it is all text — the widest-compatibility
// form, and what local runtimes (llama.cpp, older Ollama) actually accept.
function partsToChatContent(parts) {
  if (!parts.length) return null;
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("\n");
  }
  return parts;
}

export function anthropicToChatRequest(msg) {
  if (!msg || typeof msg !== "object") throw new ApiError(400, "Invalid request body");

  const messages = [];
  const system = anthropicTextFromBlocks(msg.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of msg.messages || []) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : "user";

    if (typeof message.content === "string") {
      if (message.content) messages.push({ role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    const parts = [];
    const toolCalls = [];

    for (const block of message.content) {
      if (!block || typeof block !== "object") {
        if (typeof block === "string" && block) parts.push({ type: "text", text: block });
        continue;
      }
      switch (block.type) {
        case "text":
          if (block.text) parts.push({ type: "text", text: block.text });
          break;
        case "image":
          parts.push({ type: "image_url", image_url: { url: imageUrlFromAnthropicSource(block.source) } });
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id || shortId("call"),
            type: "function",
            function: { name: block.name || "", arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case "tool_result":
          // Emitted before the turn's own text so the tool replies stay adjacent
          // to the assistant message that requested them, as OpenAI requires.
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id || "",
            content: toolResultToText(block.content),
          });
          break;
        case "thinking":
        case "redacted_thinking":
          break; // no Chat equivalent, and replaying it as text would corrupt the turn
        case "document":
          throw new ApiError(
            400,
            "document blocks (PDF/file input) cannot be translated to OpenAI Chat Completions; route this model to an Anthropic-format provider instead"
          );
        default:
          if (block.text) parts.push({ type: "text", text: block.text });
      }
    }

    if (role === "assistant") {
      const content = partsToChatContent(parts);
      if (content || toolCalls.length) {
        messages.push({ role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      }
    } else {
      const content = partsToChatContent(parts);
      if (content) messages.push({ role: "user", content });
    }
  }

  if (!messages.some((m) => m.role !== "system")) {
    throw new ApiError(400, "Request has no conversation messages to send");
  }

  const request = {
    model: msg.model,
    messages,
    // Anthropic always carries max_tokens, so this is a straight copy.
    ...(msg.max_tokens != null ? { max_tokens: msg.max_tokens } : {}),
  };
  if (msg.temperature != null) request.temperature = msg.temperature;
  if (msg.top_p != null) request.top_p = msg.top_p;
  if (Array.isArray(msg.stop_sequences) && msg.stop_sequences.length) request.stop = msg.stop_sequences;
  if (msg.metadata?.user_id) request.user = String(msg.metadata.user_id);
  if (msg.stream) {
    request.stream = true;
    // Without this the OpenAI side reports no usage at all, which would leave
    // the request log with no token counts and no cost on the claude route.
    request.stream_options = { include_usage: true };
  }

  const tools = [];
  for (const tool of msg.tools || []) {
    if (!tool || typeof tool !== "object") continue;
    if (!tool.input_schema && tool.type) {
      throw new ApiError(
        400,
        `Anthropic server tool "${tool.type}" has no OpenAI Chat Completions equivalent; route this model to an Anthropic-format provider instead`
      );
    }
    if (!tool.name) continue;
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: normaliseSchema(tool.input_schema),
      },
    });
  }
  if (tools.length) {
    request.tools = tools;
    const choice = msg.tool_choice;
    if (choice?.type === "any") request.tool_choice = "required";
    else if (choice?.type === "tool" && choice.name) {
      request.tool_choice = { type: "function", function: { name: choice.name } };
    } else if (choice?.type === "none") request.tool_choice = "none";
    else request.tool_choice = "auto";
    if (choice?.disable_parallel_tool_use) request.parallel_tool_calls = false;
  }

  return request;
}

// OpenAI finish_reason -> Anthropic stop_reason.
const ANTHROPIC_STOP_REASON = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

function anthropicStopReason(finishReason, hasToolUse) {
  if (finishReason && ANTHROPIC_STOP_REASON[finishReason]) return ANTHROPIC_STOP_REASON[finishReason];
  return hasToolUse ? "tool_use" : "end_turn";
}

export function chatUsageToAnthropic(usage) {
  if (!usage || typeof usage !== "object") return { input_tokens: 0, output_tokens: 0 };
  const cacheRead = usage.prompt_tokens_details?.cached_tokens || 0;
  return {
    input_tokens: Math.max((usage.prompt_tokens || 0) - cacheRead, 0),
    output_tokens: usage.completion_tokens || 0,
    ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
  };
}

function anthropicMessageId(id) {
  if (!id) return shortId("msg");
  return String(id).startsWith("msg_") ? String(id) : `msg_${String(id).replace(/^chatcmpl[-_]?/, "")}`;
}

export function chatToAnthropicResponse(body, { model } = {}) {
  if (body?.error) {
    throw new ApiError(502, `Upstream returned an error instead of a completion: ${preview(body.error)}`);
  }
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  if (!choice) {
    throw new ApiError(502, `Upstream reply is not a Chat Completion (no choices): ${preview(body)}`);
  }

  const message = choice.message || {};
  const content = [];
  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => part?.text || "").join("")
        : "";
  if (text) content.push({ type: "text", text });

  for (const call of message.tool_calls || []) {
    if (!call) continue;
    content.push({
      type: "tool_use",
      id: call.id || shortId("toolu"),
      name: call.function?.name || call.name || "",
      input: parseToolArguments(call.function?.arguments, call.function?.name, 502),
    });
  }

  if (!content.length) {
    throw new ApiError(
      502,
      choice.finish_reason === "length"
        ? "Upstream truncated the completion before producing any text (finish_reason length) — raise max_tokens; a reasoning model can spend the whole budget before its first visible token"
        : `Upstream returned a choice with no content and no tool calls (finish_reason ${choice.finish_reason ?? "null"})`
    );
  }

  return {
    id: anthropicMessageId(body.id),
    type: "message",
    role: "assistant",
    model: body.model || model || null,
    content,
    stop_reason: anthropicStopReason(choice.finish_reason, (message.tool_calls || []).length > 0),
    stop_sequence: null,
    usage: chatUsageToAnthropic(body.usage),
  };
}

// OpenAI Chat Completions SSE -> Anthropic Messages SSE.
//
// Text is streamed live (that is what a client renders). Tool calls are
// buffered and emitted as complete blocks just before message_delta: Anthropic
// content blocks must open and close in order, while OpenAI streams tool-call
// argument fragments by index and may interleave them with text. Buffering is
// the only way to guarantee a well-formed Anthropic block sequence, and no
// client renders partial tool arguments anyway.
export async function pipeChatSseAsAnthropic(upstream, res, { model } = {}) {
  let responseId = null;
  let responseModel = null;
  let usage = null;
  let finishReason = null;
  let started = false;
  let textOpen = false;
  let nextBlockIndex = 0;
  let upstreamError = null;
  const toolCalls = new Map(); // openai tool_call index -> { id, name, arguments }

  const emit = (type, payload) => writeSseEvent(res, type, JSON.stringify({ type, ...payload }));

  const start = async () => {
    if (started) return;
    started = true;
    await emit("message_start", {
      message: {
        id: (responseId = anthropicMessageId(responseId)),
        type: "message",
        role: "assistant",
        model: responseModel || model || null,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // The real counts only arrive with the final OpenAI chunk; they are
        // corrected in message_delta below.
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  for await (const event of openAiSseEvents(upstream)) {
    if (event.done) break;
    if (event.error) {
      upstreamError = event.error.message || preview(event.error);
      break;
    }

    responseId = responseId || event.id || null;
    responseModel = responseModel || event.model || null;
    if (event.usage) usage = event.usage;

    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    // Non-streaming-shaped chunk (some gateways answer a stream request with a
    // single completion object): take the whole message.
    const delta = choice.delta || choice.message || {};

    const text = typeof delta.content === "string" ? delta.content : "";
    if (text) {
      await start();
      if (!textOpen) {
        await emit("content_block_start", { index: nextBlockIndex, content_block: { type: "text", text: "" } });
        textOpen = true;
      }
      await emit("content_block_delta", { index: nextBlockIndex, delta: { type: "text_delta", text } });
    }

    for (const call of delta.tool_calls || []) {
      if (!call) continue;
      const key = call.index ?? toolCalls.size;
      const entry = toolCalls.get(key) || { id: null, name: "", arguments: "" };
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name += call.function.name;
      if (call.function?.arguments) entry.arguments += call.function.arguments;
      toolCalls.set(key, entry);
      await start();
    }
  }

  // Fail loudly rather than closing a stream that carried nothing: an Anthropic
  // error event, and no message_stop. `failed` tells the route to log an error.
  if (upstreamError || (!textOpen && !toolCalls.size)) {
    if (!started) await start();
    const message =
      upstreamError || "Upstream produced no content while streaming (no text and no tool calls)";
    await emit("error", {
      error: { type: upstreamError ? "api_error" : "upstream_empty_response", message },
    });
    return { responseModel, responseId, usage: null, failed: true, error: message };
  }

  if (textOpen) {
    await emit("content_block_stop", { index: nextBlockIndex });
    nextBlockIndex += 1;
  }

  for (const entry of toolCalls.values()) {
    await emit("content_block_start", {
      index: nextBlockIndex,
      content_block: { type: "tool_use", id: entry.id || shortId("toolu"), name: entry.name, input: {} },
    });
    if (entry.arguments) {
      await emit("content_block_delta", {
        index: nextBlockIndex,
        delta: { type: "input_json_delta", partial_json: entry.arguments },
      });
    }
    await emit("content_block_stop", { index: nextBlockIndex });
    nextBlockIndex += 1;
  }

  const anthropicUsageOut = chatUsageToAnthropic(usage);
  await emit("message_delta", {
    delta: {
      stop_reason: anthropicStopReason(finishReason, toolCalls.size > 0),
      stop_sequence: null,
    },
    usage: { output_tokens: anthropicUsageOut.output_tokens },
  });
  await emit("message_stop", {});

  return { responseModel, responseId, usage: usage ? anthropicUsageOut : null };
}
