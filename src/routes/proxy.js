import { Router } from "express";
import { lookupProviderForTool, getToolProvider, getEnabledModels } from "../config/keysStore.js";
import { createAdapter } from "../registry.js";
import { recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { pipeStreamSSE } from "../lib/stream.js";
import { callUpstream, adapterErrorToApiError, setSseHeaders } from "../lib/proxyExecute.js";
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
  const model = req.body?.model;
  const stream = Boolean(req.body?.stream);

  try {
    if (!model) throw new ApiError(400, "Missing 'model' in request body");

    let provider = lookupProviderForTool("openai", model);
    if (!provider) {
      // Passthrough relax (#171 item 3): forward an unknown model id to the
      // bound provider and let its own error reach the client. Kiro stays strict
      // (ban risk) and is rejected on this slot below regardless (protocol
      // mismatch); a disabled provider gets no traffic.
      const bound = getToolProvider("openai");
      if (bound && bound.type !== "kiro" && bound.enabled !== false) provider = bound;
    }
    if (!provider) throw new ApiError(404, `Model "${model}" not available on OpenAI provider`);

    // Kiro speaks an Anthropic-shaped protocol, not OpenAI chat/completions.
    // Routing Kiro here would send an untranslated OpenAI body to Kiro's runtime
    // host and fail. Reach a Kiro provider via /v1/messages (Claude Code) or
    // /v1/responses (Codex) instead.
    if (provider.type === "kiro") {
      throw new ApiError(
        400,
        "Kiro providers are not supported on /v1/chat/completions — use /v1/messages or /v1/responses instead"
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

    const { upstream, startTime } = await callUpstream({
      adapter, body: req.body, model, tool: "openai", provider,
    });
    logRequest({
      tool: "openai", model, providerId: provider.id, providerName: provider.name,
      latencyMs: Date.now() - startTime, status: "ok",
    });

    if (stream) {
      setSseHeaders(res);
      await pipeStreamSSE(upstream.body, res, adapter);
      res.end();
      return;
    }

    res.json(adapter.translateResponse(await upstream.json()));
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
