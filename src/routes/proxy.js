import { Router } from "express";
import { PassThrough } from "node:stream";
import { getEnabledModels, toolSupportsProviderType, supportedTypesForTool } from "../config/keysStore.js";
import { lookupModelForTool, executeKiroWithFallback } from "../kiro/client.js";
import { anthropicToKiro } from "../kiro/converter.js";
import { measureKiroPayload } from "../kiro/tokens.js";
import { streamKiroToAnthropic, collectKiroResponse } from "../kiro/stream.js";
import { createAdapter } from "../registry.js";
import { recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { pipeStreamSSE, openAiUsage } from "../lib/stream.js";
import { pipeAnthropicSseAsChat, chatToAnthropicRequest, anthropicToChatResponse } from "../lib/protocolBridge.js";
import { callUpstreamWithFallback, adapterErrorToApiError, setSseHeaders, readUpstreamJson } from "../lib/proxyExecute.js";
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

    // Same resolver the other two routes use: a per-model override or force route
    // wins over the slot, the id may be rewritten on the way upstream, Kiro gets
    // its catalog aliasing and its strict "must be a configured id" gate, and any
    // other provider type receives the raw id untouched (#171 item 3).
    ({ provider, model } = lookupModelForTool("openai", rawModel));
    if (!provider) throw new ApiError(404, `Model "${rawModel}" not available on OpenAI provider`);

    // Everything here is either native OpenAI Chat Completions, or reached through
    // the protocol bridge: an anthropic-compat provider gets the request mapped to
    // Anthropic Messages and its reply mapped back, and Kiro reuses that same
    // Anthropic-shaped body as the input to its own converter.
    if (!toolSupportsProviderType("openai", provider.type)) {
      throw new ApiError(
        400,
        `Provider "${provider.name}" (${provider.type}) cannot serve /v1/chat/completions — ` +
          `this route needs ${supportedTypesForTool("openai").join(" or ")}.`
      );
    }

    let adapter;
    try {
      adapter = await createAdapter(provider, { speaks: "openai-chat" });
    } catch (err) {
      throw adapterErrorToApiError(err);
    }

    if (stream && !adapter.supportsStreaming) {
      throw new ApiError(400, "Streaming not supported by provider");
    }

    // --- Kiro provider: chat body → Anthropic shape → Kiro's own protocol ---
    if (provider.type === "kiro") {
      const kiroPayload = anthropicToKiro(chatToAnthropicRequest({ ...req.body, model }));
      // Kiro reports no input token count, but input IS the cost there (full
      // history is re-sent every turn). Measure what we send so the log shows it.
      const { inputTokens, historyEntries, payloadChars } = measureKiroPayload(kiroPayload);
      const { upstream, startTime, provider: served, fallback } = await executeKiroWithFallback({
        adapter, provider, tool: "openai", model, rawModel, kiroPayload,
      });

      if (stream) {
        setSseHeaders(res);
        // Kiro stream → Anthropic SSE → OpenAI chunks. Both converters already
        // exist and are verified, so they are chained through a PassThrough
        // rather than writing a third Kiro-specific stream converter.
        // ponytail: in-memory relay, no backpressure — a turn's output is small.
        const relay = new PassThrough();
        const kiroDone = streamKiroToAnthropic(upstream.body, relay, model, inputTokens)
          .finally(() => relay.end());
        kiroDone.catch(() => {}); // the await below is what surfaces it
        const sniffed = await pipeAnthropicSseAsChat(relay, res, {
          model,
          includeUsage: Boolean(req.body?.stream_options?.include_usage),
        });
        const kiroUsage = await kiroDone;
        logRequest({
          tool: "openai", model, rawModel, providerId: served.id, providerName: served.name,
          latencyMs: Date.now() - startTime, fallback,
          status: sniffed.failed ? "error" : "ok",
          ...(sniffed.failed ? { error: sniffed.error } : {}),
          responseModel: model, responseId: sniffed.responseId,
          kiroCredits: kiroUsage.credits,
          contextUsagePercent: kiroUsage.contextUsagePercent,
          historyEntries, payloadChars,
          usage: { input_tokens: inputTokens, output_tokens: kiroUsage.outputTokens },
        });
        res.end();
        return;
      }

      const anthropicJson = await collectKiroResponse(upstream.body, model, inputTokens);
      const kiro = anthropicJson._kiro || {};
      delete anthropicJson._kiro; // internal field, not part of either spec
      const responseJson = anthropicToChatResponse(anthropicJson, { model });
      logRequest({
        tool: "openai", model, rawModel, providerId: served.id, providerName: served.name,
        latencyMs: Date.now() - startTime, status: "ok", fallback,
        responseModel: model, responseId: responseJson.id,
        kiroCredits: kiro.credits,
        contextUsagePercent: kiro.contextUsagePercent,
        historyEntries, payloadChars,
        usage: anthropicJson.usage || null,
      });
      res.json(responseJson);
      return;
    }

    const { upstream, startTime, provider: served, adapter: servedAdapter, fallback } = await callUpstreamWithFallback({
      adapter, body: { ...req.body, model }, model, rawModel, tool: "openai", provider,
      speaks: "openai-chat",
    });

    if (stream) {
      setSseHeaders(res);
      // A bridged provider streams Anthropic events, which are not a per-line
      // transform into OpenAI chunks — it needs the bridge's stateful pipe.
      const sniffed = servedAdapter.bridge === "chat-over-anthropic"
        ? await pipeAnthropicSseAsChat(upstream.body, res, {
            model,
            includeUsage: Boolean(req.body?.stream_options?.include_usage),
          })
        : await pipeStreamSSE(upstream.body, res, servedAdapter);
      logRequest({
        tool: "openai", model, rawModel, providerId: served.id, providerName: served.name,
        latencyMs: Date.now() - startTime, fallback,
        // A stream that carried no content was answered with an error payload,
        // so it must not be logged as a success.
        status: sniffed.failed ? "error" : "ok",
        ...(sniffed.failed ? { error: sniffed.error } : {}),
        responseModel: sniffed.responseModel, responseId: sniffed.responseId,
        usage: openAiUsage(sniffed.usage),
      });
      res.end();
      return;
    }

    const responseJson = servedAdapter.translateResponse(await readUpstreamJson(upstream, served));
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
