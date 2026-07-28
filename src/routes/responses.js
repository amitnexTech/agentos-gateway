import { Router } from "express";
import { randomUUID } from "node:crypto";
import { lookupModelForTool, executeKiroWithFallback } from "../kiro/client.js";
import { collectKiroResponse } from "../kiro/stream.js";
import { callUpstreamWithFallback, adapterErrorToApiError, setSseHeaders } from "../lib/proxyExecute.js";
import { recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { createAdapter } from "../registry.js";
import { ApiError } from "../lib/errors.js";

export const responsesRouter = Router();

// Convert Anthropic Messages response to OpenAI chat/completions format
// (needed to bridge Kiro response into Responses API format)
function anthropicToChatResponse(anthropicResp, model) {
  const content = anthropicResp.content || [];
  const textParts = content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolUses = content.filter((b) => b.type === "tool_use");

  const message = { role: "assistant", content: textParts || null };
  if (toolUses.length) {
    message.tool_calls = toolUses.map((tu) => ({
      id: tu.id,
      type: "function",
      function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
    }));
  }

  let finishReason = "stop";
  if (anthropicResp.stop_reason === "tool_use") finishReason = "tool_calls";
  else if (anthropicResp.stop_reason === "max_tokens") finishReason = "length";

  return {
    id: anthropicResp.id || `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: anthropicResp.usage?.input_tokens || 0,
      completion_tokens: anthropicResp.usage?.output_tokens || 0,
      total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
    },
  };
}

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
      const role = item.role || "user";

      if (type === "message") {
        let content = item.content;
        if (Array.isArray(content)) {
          content = content
            .map((b) => (typeof b === "string" ? b : b?.text || ""))
            .filter(Boolean)
            .join("\n");
        }
        messages.push({ role, content: content || "" });
      } else if (type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: item.call_id || `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name: item.name || "", arguments: item.arguments || "{}" },
          }],
        });
      } else if (type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || "",
          content: item.output || "",
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
function chatToResponsesFormat(chatResp, model, responseId) {
  const output = [];
  const choice = chatResp.choices?.[0] || {};
  const message = choice.message || {};

  // Tool calls
  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${randomUUID().slice(0, 12)}`,
        call_id: tc.id || `call_${randomUUID().slice(0, 8)}`,
        name: tc.function.name,
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

// Generate SSE events for streaming
function generateSSE(chatResp, model, responseId) {
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

  let outputIdx = 0;

  // Tool calls
  for (const tc of toolCalls) {
    const itemId = `fc_${randomUUID().slice(0, 12)}`;
    const callId = tc.id || `call_${randomUUID().slice(0, 8)}`;
    const args = tc.function.arguments;

    events.push(`event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added", output_index: outputIdx,
      item: { type: "function_call", id: itemId, call_id: callId, name: tc.function.name, arguments: "", status: "in_progress" },
    })}\n\n`);

    events.push(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta", output_index: outputIdx, item_id: itemId, delta: args,
    })}\n\n`);

    events.push(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.done", output_index: outputIdx, item_id: itemId, arguments: args,
    })}\n\n`);

    events.push(`event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done", output_index: outputIdx,
      item: { type: "function_call", id: itemId, call_id: callId, name: tc.function.name, arguments: args, status: "completed" },
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
      adapter = await createAdapter(provider);
    } catch (err) {
      throw adapterErrorToApiError(err);
    }

    const responseId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    // --- Kiro provider: Responses input → Anthropic → Kiro, then back to Responses ---
    if (provider.type === "kiro") {
      const messages = inputToMessages(req.body.input, req.body.instructions);
      const anthropicTools = (req.body.tools || [])
        .filter((t) => t.type === "function")
        .map((t) => ({
          name: t.name || "",
          description: t.description || "",
          input_schema: t.parameters || { type: "object", properties: {} },
        }));

      const anthropicReq = {
        messages,
        max_tokens: req.body.max_output_tokens || 16000,
      };
      if (anthropicTools.length) anthropicReq.tools = anthropicTools;

      const { upstream, startTime, provider: served, fallback } = await executeKiroWithFallback({
        adapter, provider, tool: "codex", model, rawModel, anthropicReq,
      });

      // Collect Kiro response (Anthropic shape), then bridge to chat/completions
      // and finally to Responses format. Streaming is generated from the
      // collected response — Kiro's native stream is Anthropic-shaped, so we
      // collect once and emit Responses SSE events from it.
      const anthropicResp = await collectKiroResponse(upstream.body, model);
      const chatResponse = anthropicToChatResponse(anthropicResp, model);
      logRequest({
        tool: "codex", rawModel, model, providerId: served.id, providerName: served.name,
        latencyMs: Date.now() - startTime, status: "ok", fallback,
        kiroCredits: anthropicResp._kiro?.credits,
      });

      if (stream) {
        setSseHeaders(res);
        for (const event of generateSSE(chatResponse, model, responseId)) res.write(event);
        res.end();
        return;
      }

      res.json(chatToResponsesFormat(chatResponse, model, responseId));
      return;
    }

    // --- Standard provider: Responses input → chat/completions, then to Responses ---
    const messages = inputToMessages(req.body.input, req.body.instructions);
    const chatTools = (req.body.tools || [])
      .filter((t) => t.type === "function")
      .map((t) => ({
        type: "function",
        function: { name: t.name || "", description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } },
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
    });
    logRequest({
      tool: "codex", rawModel, model, providerId: served.id, providerName: served.name,
      latencyMs: Date.now() - startTime, status: "ok", fallback,
    });

    const chatResponse = servedAdapter.translateResponse(await upstream.json());

    if (stream) {
      setSseHeaders(res);
      for (const event of generateSSE(chatResponse, model, responseId)) res.write(event);
      res.end();
      return;
    }

    res.json(chatToResponsesFormat(chatResponse, model, responseId));
  } catch (err) {
    if (model && !(err instanceof ApiError)) recordError(model);
    if (err.name === "AbortError") return next(new ApiError(504, "Upstream timeout"));
    if (res.headersSent) { res.end(); return; }
    next(err);
  }
});
