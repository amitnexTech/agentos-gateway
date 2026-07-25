import { Router } from "express";
import { lookupProviderForTool, getToolModels } from "../config/keysStore.js";
import { createAdapter, MissingSecretError, UnknownProviderTypeError } from "../registry.js";
import { recordRequest, recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { ApiError } from "../lib/errors.js";
import { upstreamErrorMessage } from "../lib/upstreamError.js";

export const anthropicRouter = Router();

// Model alias map: Claude Code sends dated names, Kiro Gateway expects short names.
// Left side = what Claude Code sends, right side = what we look up + forward.
const MODEL_ALIASES = {
  "claude-sonnet-4-20250514": "claude-sonnet-4.5",
  "claude-sonnet-4.5-20250514": "claude-sonnet-4.5",
  "claude-sonnet-4-20250918": "claude-sonnet-4.6",
  "claude-opus-4-20250115": "claude-opus-4.5",
  "claude-opus-4-20250514": "claude-opus-4.6",
  "claude-haiku-3.5-20241022": "claude-haiku-4.5",
};

function resolveModel(model) {
  // Try exact match first, then alias, then strip date suffix
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  // Generic fallback: strip -YYYYMMDD suffix and try
  const stripped = model.replace(/-\d{8}$/, "");
  if (stripped !== model) return stripped;
  return model;
}

// Anthropic Messages API - used by Claude Code
// Translates to provider's chat/completions internally if needed,
// or passes through directly if provider supports Anthropic format

anthropicRouter.post("/messages", async (req, res, next) => {
  const rawModel = req.body?.model;
  const model = rawModel ? resolveModel(rawModel) : rawModel;
  const stream = Boolean(req.body?.stream);

  try {
    if (!model) throw new ApiError(400, "Missing 'model' in request body");

    const provider = lookupProviderForTool("claude", model);
    if (!provider) throw new ApiError(404, `Model "${model}" not available on Claude Code provider`);

    let adapter;
    try {
      adapter = await createAdapter(provider);
    } catch (err) {
      if (err instanceof MissingSecretError) throw new ApiError(503, "Provider API key is missing");
      if (err instanceof UnknownProviderTypeError) throw new ApiError(503, err.message);
      throw err;
    }

    // Forward the request directly to provider's /v1/messages endpoint
    // (Kiro gateway and other Anthropic-compatible providers support this)
    const messagesUrl = `${adapter.baseUrl}/messages`;
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": adapter.apiKey || "",
      "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
    };
    // Also pass Authorization header for providers that use Bearer token
    if (adapter.apiKey) {
      headers["Authorization"] = `Bearer ${adapter.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 min timeout
    const startTime = Date.now();

    // Replace model in request body with resolved name for upstream
    const upstreamBody = { ...req.body, model };

    let upstream;
    try {
      upstream = await fetch(messagesUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      recordError(model);
      const detail = await upstreamErrorMessage(upstream);
      logRequest({ tool: "claude", model, providerId: provider.id, providerName: provider.name, latencyMs: Date.now() - startTime, status: "error", error: `${upstream.status}: ${detail.slice(0, 200)}` });
      throw new ApiError(upstream.status >= 500 ? 502 : upstream.status, `Upstream error (${upstream.status}): ${detail}`);
    }

    recordRequest(model);

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      // Pipe SSE stream directly, but sniff for model and usage info
      let responseModel = null;
      let usage = null;

      const reader = upstream.body.getReader
        ? upstream.body.getReader()
        : null;

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value).toString("utf8");
            // Sniff model from message_start event
            if (!responseModel && chunk.includes('"message_start"')) {
              const m = chunk.match(/"model"\s*:\s*"([^"]+)"/);
              if (m) responseModel = m[1];
            }
            // Sniff usage from message_delta event (final usage)
            if (chunk.includes('"message_delta"') || chunk.includes('"message_stop"')) {
              const u = chunk.match(/"usage"\s*:\s*(\{[^}]+\})/);
              if (u) try { usage = { ...usage, ...JSON.parse(u[1]) }; } catch {}
            }
            // Sniff usage from message_start (input tokens + cache)
            if (chunk.includes('"message_start"')) {
              const u = chunk.match(/"usage"\s*:\s*(\{[^}]+\})/);
              if (u) try { usage = JSON.parse(u[1]); } catch {}
            }
            res.write(chunk);
          }
        } finally {
          reader.releaseLock();
        }
      } else if (typeof upstream.body[Symbol.asyncIterator] === "function") {
        for await (const chunk of upstream.body) {
          const text = Buffer.from(chunk).toString("utf8");
          if (!responseModel && text.includes('"message_start"')) {
            const m = text.match(/"model"\s*:\s*"([^"]+)"/);
            if (m) responseModel = m[1];
          }
          if (text.includes('"message_delta"') || text.includes('"message_stop"')) {
            const u = text.match(/"usage"\s*:\s*(\{[^}]+\})/);
            if (u) try { usage = { ...usage, ...JSON.parse(u[1]) }; } catch {}
          }
          if (text.includes('"message_start"')) {
            const u = text.match(/"usage"\s*:\s*(\{[^}]+\})/);
            if (u) try { usage = JSON.parse(u[1]); } catch {}
          }
          res.write(text);
        }
      }

      // Log with actual response model + usage
      logRequest({
        tool: "claude", model, providerId: provider.id, providerName: provider.name,
        latencyMs: Date.now() - startTime, status: "ok",
        responseModel: responseModel || null,
        usage: usage ? {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_read: usage.cache_read_input_tokens || usage.cache_read || 0,
          cache_write: usage.cache_creation_input_tokens || usage.cache_write || 0,
        } : null,
      });

      res.end();
      return;
    }

    // Non-streaming: return JSON directly, extract model + usage
    const responseJson = await upstream.json();
    const responseModel = responseJson.model || null;
    const rawUsage = responseJson.usage || null;
    logRequest({
      tool: "claude", model, providerId: provider.id, providerName: provider.name,
      latencyMs: Date.now() - startTime, status: "ok",
      responseModel,
      usage: rawUsage ? {
        input_tokens: rawUsage.input_tokens || 0,
        output_tokens: rawUsage.output_tokens || 0,
        cache_read: rawUsage.cache_read_input_tokens || rawUsage.cache_read || 0,
        cache_write: rawUsage.cache_creation_input_tokens || rawUsage.cache_write || 0,
      } : null,
    });
    res.json(responseJson);
  } catch (err) {
    if (model && !(err instanceof ApiError)) recordError(model);
    if (err.name === "AbortError") return next(new ApiError(504, "Upstream timeout"));
    if (res.headersSent) {
      res.end();
      return;
    }
    next(err);
  }
});
