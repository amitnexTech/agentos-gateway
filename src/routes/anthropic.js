import { Router } from "express";
import { lookupModelForTool, executeKiroWithFallback } from "../kiro/client.js";
import { anthropicToKiro } from "../kiro/converter.js";
import { measureKiroPayload } from "../kiro/tokens.js";
import { streamKiroToAnthropic, collectKiroResponse } from "../kiro/stream.js";
import { callUpstreamWithFallback, adapterErrorToApiError, setSseHeaders } from "../lib/proxyExecute.js";
import { pipeAnthropicSse, anthropicUsage } from "../lib/anthropicSse.js";
import { recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { createAdapter } from "../registry.js";
import { ApiError } from "../lib/errors.js";

export const anthropicRouter = Router();

// Anthropic Messages API — used by Claude Code.
// Kiro provider: request is translated Anthropic→Kiro (kiro/client.js +
// kiro/converter.js + kiro/stream.js). Other Anthropic-compat providers: the
// request is forwarded directly via the adapter. Model-id aliasing is Kiro-only
// (kiro/client.js resolveKiroModel); non-Kiro providers receive the raw id the
// client sent, completely untouched.

anthropicRouter.post("/messages", async (req, res, next) => {
  const rawModel = req.body?.model;
  const stream = Boolean(req.body?.stream);
  let provider, model;

  try {
    if (!rawModel) throw new ApiError(400, "Missing 'model' in request body");

    // Kiro-aware lookup: applies date-suffix aliasing only when the claude tool
    // is routed to a Kiro provider. Non-Kiro providers get rawModel untouched.
    ({ provider, model } = lookupModelForTool("claude", rawModel));
    if (!provider) throw new ApiError(404, `Model "${rawModel}" not available on Claude Code provider`);

    let adapter;
    try {
      adapter = await createAdapter(provider);
    } catch (err) {
      throw adapterErrorToApiError(err);
    }

    // --- Kiro provider: translate Anthropic → Kiro protocol ---
    if (provider.type === "kiro") {
      const kiroPayload = anthropicToKiro({ ...req.body, model });
      // Kiro reports no input token count, but input IS the cost there (full
      // history is re-sent every turn). Measure what we send so the log shows it.
      const { inputTokens, historyEntries, payloadChars } = measureKiroPayload(kiroPayload);
      const { upstream, startTime, provider: served, fallback } = await executeKiroWithFallback({
        adapter, provider, tool: "claude", model, rawModel, kiroPayload,
      });

      if (stream) {
        setSseHeaders(res);
        const kiroUsage = await streamKiroToAnthropic(upstream.body, res, model, inputTokens);
        logRequest({
          tool: "claude", rawModel, model, providerId: served.id, providerName: served.name,
          latencyMs: Date.now() - startTime, status: "ok", responseModel: model,
          kiroCredits: kiroUsage.credits, fallback,
          contextUsagePercent: kiroUsage.contextUsagePercent,
          historyEntries, payloadChars,
          usage: { input_tokens: inputTokens, output_tokens: kiroUsage.outputTokens },
        });
        res.end();
        return;
      }

      const responseJson = await collectKiroResponse(upstream.body, model, inputTokens);
      logRequest({
        tool: "claude", rawModel, model, providerId: served.id, providerName: served.name,
        latencyMs: Date.now() - startTime, status: "ok", responseModel: model,
        kiroCredits: responseJson._kiro?.credits, fallback,
        contextUsagePercent: responseJson._kiro?.contextUsagePercent,
        historyEntries, payloadChars,
        usage: responseJson.usage || null,
      });
      delete responseJson._kiro; // internal field, not part of the Anthropic spec
      res.json(responseJson);
      return;
    }

    // --- Standard Anthropic-compat provider: forward directly via the adapter ---
    const { upstream, startTime, provider: served, fallback } = await callUpstreamWithFallback({
      adapter, body: { ...req.body, model }, model, rawModel, tool: "claude", provider,
      anthropicVersion: req.headers["anthropic-version"],
    });

    if (stream) {
      setSseHeaders(res);
      const { responseModel, responseId, usage } = await pipeAnthropicSse(upstream, res);
      logRequest({
        tool: "claude", rawModel, model, providerId: served.id, providerName: served.name,
        latencyMs: Date.now() - startTime, status: "ok", fallback,
        responseModel, responseId, usage: anthropicUsage(usage),
      });
      res.end();
      return;
    }

    const responseJson = await upstream.json();
    logRequest({
      tool: "claude", rawModel, model, providerId: served.id, providerName: served.name,
      latencyMs: Date.now() - startTime, status: "ok", fallback,
      responseModel: responseJson.model || null,
      responseId: responseJson.id || null,
      usage: anthropicUsage(responseJson.usage),
    });
    res.json(responseJson);
  } catch (err) {
    if (model && !(err instanceof ApiError)) recordError(model);
    if (err.name === "AbortError") return next(new ApiError(504, "Upstream timeout"));
    if (res.headersSent) { res.end(); return; }
    next(err);
  }
});
