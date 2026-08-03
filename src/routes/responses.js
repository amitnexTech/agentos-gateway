import { Router } from "express";
import { randomUUID } from "node:crypto";
import { lookupModelForTool, executeKiroWithFallback } from "../kiro/client.js";
import { codexToKiro, collectCodexTools } from "../kiro/codexConverter.js";
import { collectKiroAsCodex, streamKiroToCodex } from "../kiro/codexStream.js";
import { measureKiroPayload } from "../kiro/tokens.js";
import { callUpstreamWithFallback, adapterErrorToApiError, setSseHeaders, readUpstreamJson } from "../lib/proxyExecute.js";
import { openAiUsage } from "../lib/stream.js";
import { recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { toolSupportsProviderType, supportedTypesForTool } from "../config/keysStore.js";
import { createAdapter } from "../registry.js";
import { ApiError } from "../lib/errors.js";

export const responsesRouter = Router();

// Convert Responses API input to chat messages
function inputToMessages(input, instructions) {
  const messages = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;

      const type = item.type || "";
      const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : "system";

      if (type === "additional_tools") {
        continue; // tool definitions, not conversation (collectCodexTools reads these)
      } else if (type === "reasoning") {
        continue; // no chat/completions equivalent
      } else if (type === "message") {
        let content = item.content;
        if (Array.isArray(content)) {
          content = content
            .map((b) => (typeof b === "string" ? b : b?.text || ""))
            .filter(Boolean)
            .join("\n");
        }
        messages.push({ role, content: content || "" });
      } else if (type === "function_call" || type === "custom_tool_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: item.call_id || `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name: item.name || "",
              arguments: type === "custom_tool_call" ? JSON.stringify({ input: item.input ?? "" }) : (item.arguments || "{}"),
            },
          }],
        });
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || "",
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        });
      } else {
        // Generic fallback
        const content = item.content || item.text || JSON.stringify(item);
        messages.push({ role, content: typeof content === "string" ? content : JSON.stringify(content) });
      }
    }
  }

  return messages;
}

// Convert chat response to Responses format
function chatToResponsesFormat(chatResp, model, responseId, freeform = new Set(), namespaced = new Map()) {
  const output = [];
  const choice = chatResp.choices?.[0] || {};
  const message = choice.message || {};

  // Tool calls
  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      const callId = tc.id || `call_${randomUUID().slice(0, 8)}`;
      const flatName = tc.function.name;
      // A tool hoisted out of a namespace (every MCP server, plus multi_agent_v1)
      // has to be answered with its namespace and original name — Codex routes the
      // call by that pair, not by the flat name the upstream was given.
      const ns = namespaced.get(flatName);
      output.push(freeform.has(flatName)
        ? {
            type: "custom_tool_call",
            id: `fc_${randomUUID().slice(0, 12)}`,
            call_id: callId,
            name: flatName,
            input: unwrapFreeformArgs(tc.function.arguments),
            status: "completed",
          }
        : {
            type: "function_call",
            id: `fc_${randomUUID().slice(0, 12)}`,
            call_id: callId,
            name: ns ? ns.name : flatName,
            ...(ns ? { namespace: ns.namespace } : {}),
            arguments: tc.function.arguments,
            status: "completed",
          });
    }
  }

  // Text content
  if (message.content) {
    output.push({
      type: "message",
      id: `msg_${randomUUID().slice(0, 12)}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }

  // Reasoning
  if (message.reasoning_content) {
    output.unshift({
      type: "reasoning",
      id: `rs_${randomUUID().slice(0, 12)}`,
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }

  const usage = chatResp.usage || {};
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: choice.finish_reason === "length" ? "incomplete" : "completed",
    model,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
    metadata: {},
  };
}

// A freeform ("custom") Codex tool is advertised to the upstream as a function taking
// { input: string }; Codex wants the raw string back.
function unwrapFreeformArgs(argumentsStr) {
  try {
    const parsed = JSON.parse(argumentsStr || "");
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed.input === "string") return parsed.input;
  } catch { /* not JSON — pass through */ }
  return argumentsStr || "";
}

// Generate SSE events for streaming
function generateSSE(chatResp, model, responseId, freeform = new Set(), namespaced = new Map()) {
  const events = [];
  const choice = chatResp.choices?.[0] || {};
  const message = choice.message || {};
  const content = message.content || "";
  const toolCalls = message.tool_calls || [];

  // response.created
  events.push(`event: response.created\ndata: ${JSON.stringify({
    type: "response.created",
    response: { id: responseId, object: "response", status: "in_progress", model, output: [] },
  })}\n\n`);
  events.push(`event: response.in_progress\ndata: ${JSON.stringify({
    type: "response.in_progress",
    response: { id: responseId, object: "response", status: "in_progress", model, output: [] },
  })}\n\n`);

  let outputIdx = 0;

  // Tool calls
  for (const tc of toolCalls) {
    const itemId = `fc_${randomUUID().slice(0, 12)}`;
    const callId = tc.id || `call_${randomUUID().slice(0, 8)}`;

    if (freeform.has(tc.function.name)) {
      const raw = unwrapFreeformArgs(tc.function.arguments);
      events.push(`event: response.output_item.added\ndata: ${JSON.stringify({
        type: "response.output_item.added", output_index: outputIdx,
        item: { type: "custom_tool_call", id: itemId, call_id: callId, name: tc.function.name, input: "", status: "in_progress" },
      })}\n\n`);
      events.push(`event: response.custom_tool_call_input.delta\ndata: ${JSON.stringify({
        type: "response.custom_tool_call_input.delta", output_index: outputIdx, item_id: itemId, delta: raw,
      })}\n\n`);
      events.push(`event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done", output_index: outputIdx,
        item: { type: "custom_tool_call", id: itemId, call_id: callId, name: tc.function.name, input: raw, status: "completed" },
      })}\n\n`);
      outputIdx++;
      continue;
    }

    const args = tc.function.arguments;
    // Restore the namespace a hoisted tool came from (see collectCodexTools); Codex
    // routes the call by { namespace, name }, not by the flat upstream name.
    const ns = namespaced.get(tc.function.name);
    const fnItem = (argsValue, status) => ({
      type: "function_call", id: itemId, call_id: callId,
      name: ns ? ns.name : tc.function.name,
      ...(ns ? { namespace: ns.namespace } : {}),
      arguments: argsValue, status,
    });

    events.push(`event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added", output_index: outputIdx,
      item: fnItem("", "in_progress"),
    })}\n\n`);

    events.push(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta", output_index: outputIdx, item_id: itemId, delta: args,
    })}\n\n`);

    events.push(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.done", output_index: outputIdx, item_id: itemId, arguments: args,
    })}\n\n`);

    events.push(`event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done", output_index: outputIdx,
      item: fnItem(args, "completed"),
    })}\n\n`);

    outputIdx++;
  }

  // Text content
  if (content) {
    const msgId = `msg_${randomUUID().slice(0, 12)}`;

    events.push(`event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added", output_index: outputIdx,
      item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] },
    })}\n\n`);

    events.push(`event: response.content_part.added\ndata: ${JSON.stringify({
      type: "response.content_part.added", output_index: outputIdx, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })}\n\n`);

    // Send text in chunks
    const chunkSize = 80;
    for (let i = 0; i < content.length; i += chunkSize) {
      events.push(`event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta", output_index: outputIdx, content_index: 0, delta: content.slice(i, i + chunkSize),
      })}\n\n`);
    }

    events.push(`event: response.output_text.done\ndata: ${JSON.stringify({
      type: "response.output_text.done", output_index: outputIdx, content_index: 0, text: content,
    })}\n\n`);

    events.push(`event: response.content_part.done\ndata: ${JSON.stringify({
      type: "response.content_part.done", output_index: outputIdx, content_index: 0,
      part: { type: "output_text", text: content, annotations: [] },
    })}\n\n`);

    events.push(`event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done", output_index: outputIdx,
      item: { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text: content, annotations: [] }] },
    })}\n\n`);
  }

  // response.completed
  const usage = chatResp.usage || {};
  events.push(`event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: responseId, object: "response", status: "completed", model, output: [],
      usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 } },
  })}\n\n`);

  return events;
}

// POST /v1/responses — OpenAI Responses API (for Codex)
responsesRouter.post("/responses", async (req, res, next) => {
  const rawModel = req.body?.model;
  const stream = req.body?.stream !== false; // default true for Codex
  let provider, model;

  try {
    if (!rawModel) throw new ApiError(400, "Missing 'model' in request body");

    ({ provider, model } = lookupModelForTool("codex", rawModel));
    if (!provider) throw new ApiError(404, `Model "${rawModel}" not available on Codex provider`);

    let adapter;
    try {
      // The non-Kiro branch below always talks OpenAI Chat Completions upstream,
      // so an anthropic-compat provider gets the translating adapter. Kiro is
      // never bridged — it has its own converter further down.
      adapter = await createAdapter(provider, { speaks: "openai-chat" });
    } catch (err) {
      throw adapterErrorToApiError(err);
    }

    const responseId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    // --- Kiro provider: Responses input → Kiro, then Kiro stream → Responses ---
    if (provider.type === "kiro") {
      const kiroPayload = codexToKiro(req.body, model);
      // Kiro reports no input token count, but input IS the cost there (full
      // history is re-sent every turn). Measure what we send so the log shows it.
      const { inputTokens, historyEntries, payloadChars } = measureKiroPayload(kiroPayload);
      // Freeform ("custom") tools must be answered with custom_tool_call items, and a
      // tool hoisted out of a namespace (every MCP server) must be answered with its
      // namespace restored, or Codex cannot route the call.
      const { freeform, namespaced } = collectCodexTools(req.body);

      const { upstream, startTime, provider: served, fallback } = await executeKiroWithFallback({
        adapter, provider, tool: "codex", model, rawModel, kiroPayload,
      });

      // Kiro's stream is consumed directly into Responses format — no detour
      // through Anthropic Messages shape.
      if (stream) {
        setSseHeaders(res);
        const kiroUsage = await streamKiroToCodex(upstream.body, res, model, responseId, freeform, inputTokens, namespaced);
        logRequest({
          tool: "codex", rawModel, model, providerId: served.id, providerName: served.name,
          latencyMs: Date.now() - startTime, status: "ok", fallback,
          kiroCredits: kiroUsage.credits,
          contextUsagePercent: kiroUsage.contextUsagePercent,
          historyEntries, payloadChars,
          usage: { input_tokens: inputTokens, output_tokens: kiroUsage.outputTokens },
        });
        res.end();
        return;
      }

      const { response, credits, contextUsagePercent, outputTokens } = await collectKiroAsCodex(upstream.body, model, responseId, freeform, namespaced);
      response.usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      };
      logRequest({
        tool: "codex", rawModel, model, providerId: served.id, providerName: served.name,
        latencyMs: Date.now() - startTime, status: "ok", fallback,
        kiroCredits: credits,
        contextUsagePercent,
        historyEntries, payloadChars,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
      res.json(response);
      return;
    }

    // --- Standard provider: Responses input → chat/completions, then to Responses ---
    // This branch speaks OpenAI Chat Completions upstream. An anthropic-compat
    // provider is served through the protocol bridge (lib/protocolBridge.js),
    // which maps the chat body to Anthropic Messages and the reply back. Before
    // that bridge existed the same pairing failed silently: the OpenAI-shaped body
    // went to /messages, the Anthropic-shaped reply had no `choices`, and the
    // client got HTTP 200 with `output: []`. Pairings with no translation path at
    // all (nothing today besides a misconfigured slot) are still refused.
    if (!toolSupportsProviderType("codex", provider.type)) {
      throw new ApiError(
        400,
        `Provider "${provider.name}" (${provider.type}) cannot serve /v1/responses — ` +
          `this route needs ${supportedTypesForTool("codex").join(" or ")}.`
      );
    }
    const messages = inputToMessages(req.body.input, req.body.instructions);
    // Tools come either top-level or inside an `additional_tools` input item.
    const { tools: codexTools, freeform, namespaced } = collectCodexTools(req.body);
    const chatTools = codexTools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    const chatRequest = {
      model,
      messages,
      max_tokens: req.body.max_output_tokens || 16000,
      stream: false, // we generate our own SSE from the non-streaming response
    };
    if (chatTools.length) {
      chatRequest.tools = chatTools;
      chatRequest.tool_choice = "auto";
    }

    const { upstream, startTime, provider: served, adapter: servedAdapter, fallback } = await callUpstreamWithFallback({
      adapter, body: chatRequest, model, rawModel, tool: "codex", provider,
      speaks: "openai-chat",
    });

    const chatResponse = servedAdapter.translateResponse(await readUpstreamJson(upstream, served));
    // Logged after the body is read, so the log carries what the upstream actually
    // answered with. Logging before the read left responseModel and usage null on
    // this branch — model-swap detection and token accounting were dead here.
    logRequest({
      tool: "codex", rawModel, model, providerId: served.id, providerName: served.name,
      latencyMs: Date.now() - startTime, status: "ok", fallback,
      responseModel: chatResponse?.model || null,
      responseId: chatResponse?.id || null,
      usage: openAiUsage(chatResponse?.usage),
    });

    if (stream) {
      setSseHeaders(res);
      for (const event of generateSSE(chatResponse, model, responseId, freeform, namespaced)) res.write(event);
      res.end();
      return;
    }

    res.json(chatToResponsesFormat(chatResponse, model, responseId, freeform, namespaced));
  } catch (err) {
    if (model && !(err instanceof ApiError)) recordError(model);
    if (err.name === "AbortError") return next(new ApiError(504, "Upstream timeout"));
    if (res.headersSent) { res.end(); return; }
    next(err);
  }
});
