import { Router } from "express";
import { lookupProviderForTool, getToolProvider, resolveModelRoute, getEnabledModels, toolSupportsProviderType, supportedTypesForTool } from "../config/keysStore.js";
import { createAdapter } from "../registry.js";
import { recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { pipeStreamSSE, openAiUsage } from "../lib/stream.js";
import { callUpstreamWithFallback, adapterErrorToApiError, setSseHeaders } from "../lib/proxyExecute.js";
import { ApiError } from "../lib/errors.js";

export const proxyRouter = Router();

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

// OpenAI Chat Completions API — /v1/chat/completions (Kiro/Cursor/etc.).
proxyRouter.post("/chat/completions", async (req, res, next) => {
  const rawModel = req.body?.model;
  const stream = Boolean(req.body?.stream);
  // Declared out here so the catch block can still name the model it failed on.
  let provider, model = rawModel;

  try {
    if (!rawModel) throw new ApiError(400, "Missing 'model' in request body");

    // A per-model override wins over the slot, and may rewrite the model id on
    // the way upstream (catalogs disagree on names). An `exempt` entry opts this
    // model out of a force route.
    const route = resolveModelRoute("openai", rawModel);
    const forced = route && !route.exempt ? route : null;
    provider = forced?.provider || lookupProviderForTool("openai", rawModel);
    model = forced ? forced.model : rawModel;
    if (!provider) {
      // Passthrough relax (#171 item 3): forward an unknown model id to the
      // bound provider and let its own error reach the client. Kiro stays strict
      // (ban risk) and is rejected on this slot below regardless (protocol
      // mismatch); a disabled provider gets no traffic.
      const bound = getToolProvider("openai");
      if (bound && bound.type !== "kiro" && bound.enabled !== false) provider = bound;
    }
    if (!provider) throw new ApiError(404, `Model "${rawModel}" not available on OpenAI provider`);

    // Only providers that speak OpenAI Chat Completions belong here. Kiro's
    // protocol is Anthropic-shaped, and an anthropic-compat provider would get
    // an OpenAI body posted to /messages — no max_tokens, OpenAI-shaped tools —
    // which real providers answer with 400. Neither is translated today, so fail
    // loudly instead of producing a broken upstream call.
    if (!toolSupportsProviderType("openai", provider.type)) {
      throw new ApiError(
        400,
        `Provider "${provider.name}" (${provider.type}) cannot serve /v1/chat/completions — ` +
          `this route needs ${supportedTypesForTool("openai").join(" or ")}. ` +
          `Reach an anthropic-compat provider via /v1/messages, or Kiro via /v1/messages or /v1/responses.`
      );
    }

    let adapter;
    try {
      adapter = await createAdapter(provider);
    } catch (err) {
      throw adapterErrorToApiError(err);
    }

    if (stream && !adapter.supportsStreaming) {
      throw new ApiError(400, "Streaming not supported by provider");
    }

    const { upstream, startTime, provider: served, adapter: servedAdapter, fallback } = await callUpstreamWithFallback({
      adapter, body: { ...req.body, model }, model, rawModel, tool: "openai", provider,
    });

    if (stream) {
      setSseHeaders(res);
      const { responseModel, responseId, usage } = await pipeStreamSSE(upstream.body, res, servedAdapter);
      logRequest({
        tool: "openai", model, rawModel, providerId: served.id, providerName: served.name,
        latencyMs: Date.now() - startTime, status: "ok", fallback,
        responseModel, responseId, usage: openAiUsage(usage),
      });
      res.end();
      return;
    }

    const responseJson = servedAdapter.translateResponse(await upstream.json());
    logRequest({
      tool: "openai", model, rawModel, providerId: served.id, providerName: served.name,
      latencyMs: Date.now() - startTime, status: "ok", fallback,
      responseModel: responseJson?.model || null,
      responseId: responseJson?.id || null,
      usage: openAiUsage(responseJson?.usage),
    });
    res.json(responseJson);
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
