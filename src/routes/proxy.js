import { Router } from "express";
import { lookupProviderForTool, getEnabledModels } from "../config/keysStore.js";
import { createAdapter, MissingSecretError, UnknownProviderTypeError } from "../registry.js";
import { recordRequest, recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { pipeStreamSSE } from "../lib/stream.js";
import { ApiError } from "../lib/errors.js";
import { upstreamErrorMessage } from "../lib/upstreamError.js";

export const proxyRouter = Router();

function adapterErrorToApiError(err) {
  if (err instanceof MissingSecretError) return new ApiError(503, "Provider API key is missing");
  if (err instanceof UnknownProviderTypeError) return new ApiError(503, err.message);
  return err;
}

proxyRouter.get("/models", (_req, res) => {
  res.json({
    object: "list",
    data: getEnabledModels().map((id) => ({ id, object: "model" })),
  });
});

proxyRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "agentos-gateway",
    endpoints: {
      models: "/v1/models",
      chatCompletions: "/v1/chat/completions",
      health: "/admin/health",
      providers: "/admin/providers",
    },
  });
});

proxyRouter.post("/chat/completions", async (req, res, next) => {
  const model = req.body?.model;
  try {
    const stream = Boolean(req.body?.stream);
    if (!model) throw new ApiError(400, "Missing 'model' in request body");

    const provider = lookupProviderForTool("openai", model);
    if (!provider) throw new ApiError(404, `Model "${model}" not available on OpenAI provider`);

    let adapter;
    try {
      adapter = await createAdapter(provider);
    } catch (err) {
      throw adapterErrorToApiError(err);
    }

    if (stream && !adapter.supportsStreaming) {
      throw new ApiError(400, "Streaming not supported by provider");
    }

    if (typeof adapter.completeChat === "function") {
      let responseBody;
      try {
        responseBody = await adapter.completeChat(req.body);
      } catch (err) {
        recordError(model);
        throw new ApiError(err.statusCode || 502, err.message || "External provider process failed");
      }
      recordRequest(model);
      res.json(responseBody);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const startTime = Date.now();
    let upstream;
    try {
      upstream = await fetch(adapter.getRequestUrl(model, { stream }), {
        method: "POST",
        headers: adapter.getRequestHeaders(),
        body: JSON.stringify(adapter.translateRequest(req.body)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      recordError(model);
      const detail = await upstreamErrorMessage(upstream);
      logRequest({ tool: "openai", model, providerId: provider.id, providerName: provider.name, latencyMs: Date.now() - startTime, status: "error", error: `${upstream.status}: ${detail.slice(0, 200)}` });
      if (upstream.status === 401 || upstream.status === 403) {
        throw new ApiError(502, `Upstream auth error (${upstream.status}): ${detail}`, upstream.status);
      }
      if (upstream.status === 429) {
        throw new ApiError(429, `Upstream rate limit (${upstream.status}): ${detail}`, upstream.status);
      }
      throw new ApiError(502, `Upstream error (${upstream.status}): ${detail}`, upstream.status);
    }

    recordRequest(model);
    logRequest({ tool: "openai", model, providerId: provider.id, providerName: provider.name, latencyMs: Date.now() - startTime, status: "ok" });

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      await pipeStreamSSE(upstream.body, res, adapter);
      res.end();
      return;
    }

    const nativeJson = await upstream.json();
    res.json(adapter.translateResponse(nativeJson));
  } catch (err) {
    if (model && !(err instanceof ApiError)) recordError(model);
    if (err.name === "AbortError") return next(new ApiError(504, "Upstream timeout"));
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.end();
      return;
    }
    next(err);
  }
});
