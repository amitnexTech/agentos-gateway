import { Router } from "express";
import { lookupModelForTool, executeKiroWithFallback } from "../kiro/client.js";
import { anthropicToKiro } from "../kiro/converter.js";
import { measureKiroPayload } from "../kiro/tokens.js";
import { streamKiroToAnthropic, collectKiroResponse } from "../kiro/stream.js";
import { callUpstreamWithFallback, adapterErrorToApiError, setSseHeaders, readUpstreamJson } from "../lib/proxyExecute.js";
import { pipeAnthropicSse, anthropicUsage } from "../lib/anthropicSse.js";
import { pipeChatSseAsAnthropic } from "../lib/protocolBridge.js";
import { recordError } from "../config/usageStore.js";
import { logRequest } from "../config/logStore.js";
import { toolSupportsProviderType, supportedTypesForTool } from "../config/keysStore.js";
import { createAdapter } from "../registry.js";
import { ApiError } from "../lib/errors.js";

export const anthropicRouter = Router();

// Anthropic Messages API — used by Claude Code.
// Kiro provider: request is translated Anthropic→Kiro (kiro/client.js +
// kiro/converter.js + kiro/stream.js). Other Anthropic-compat providers: the
// request is forwarded directly via the adapter. Model-id aliasing is Kiro-only
// (kiro/client.js lookupModelForTool + kiroModelCandidates); non-Kiro providers
// receive the raw id the client sent, completely untouched.

anthropicRouter.post("/messages", async (req, res, next) => {
  const rawModel = req.body?.model;
  const stream = Boolean(req.body?.stream);
  let provider, model;
  const requestStart = Date.now(); // for the error path: a failed request still took time

  try {
    if (!rawModel) throw new ApiError(400, "Missing 'model' in request body");

    // Kiro-aware lookup: applies date-suffix aliasing only when the claude tool
    // is routed to a Kiro provider. Non-Kiro providers get rawModel untouched.
    ({ provider, model } = lookupModelForTool("claude", rawModel));
    if (!provider) throw new ApiError(404, `Model "${rawModel}" not available on Claude Code provider`);

    // Same table the dashboard and admin API enforce; re-checked here because a
    // hand-edited keys.json could still name a provider this route cannot run.
    if (!toolSupportsProviderType("claude", provider.type)) {
      throw new ApiError(
        400,
        `Provider "${provider.name}" (${provider.type}) cannot serve /v1/messages — ` +
          `this route needs ${supportedTypesForTool("claude").join(" or ")}.`
      );
    }

    let adapter;
    try {
      // OpenAI-format providers get the translating adapter: the Anthropic request
      // is mapped to Chat Completions and the reply mapped back
      // (lib/protocolBridge.js). anthropic-compat is a straight passthrough.
      adapter = await createAdapter(provider, { speaks: "anthropic-messages" });
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

    // --- Standard provider: passthrough for anthropic-compat, bridged for OpenAI ---
    const { upstream, startTime, provider: served, adapter: servedAdapter, fallback } = await callUpstreamWithFallback({
      adapter, body: { ...req.body, model }, model, rawModel, tool: "claude", provider,
      anthropicVersion: req.headers["anthropic-version"],
      speaks: "anthropic-messages",
    });

    if (stream) {
      setSseHeaders(res);
      // Passthrough forwards raw Anthropic bytes; a bridged provider streams
      // OpenAI chunks that have to be re-emitted as Anthropic events.
      const sniffed = servedAdapter.bridge === "anthropic-over-chat"
        ? await pipeChatSseAsAnthropic(upstream.body, res, { model })
        : await pipeAnthropicSse(upstream, res);
      logRequest({
        tool: "claude", rawModel, model, providerId: served.id, providerName: served.name,
        latencyMs: Date.now() - startTime, fallback,
        // A bridged stream that carried no content ended in an error event, so it
        // must not be logged as a success.
        status: sniffed.failed ? "error" : "ok",
        ...(sniffed.failed ? { error: sniffed.error } : {}),
        responseModel: sniffed.responseModel, responseId: sniffed.responseId,
        usage: anthropicUsage(sniffed.usage),
      });
      res.end();
      return;
    }

    const responseJson = servedAdapter.translateResponse(await readUpstreamJson(upstream, served));
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
    // A failure that happened AFTER the upstream call — an unusable reply, a body
    // that is not JSON, a translation that cannot be done honestly — used to be
    // logged nowhere: the request cost an upstream call (and sometimes money) and
    // left no trace in the log or the spend record. Lower layers set `logged` on
    // the errors they have already written, so this never double-counts.
    if (!err.logged) {
      logRequest({
        tool: "claude", rawModel, model,
        providerId: provider?.id, providerName: provider?.name,
        latencyMs: Date.now() - requestStart, status: "error", error: err.message,
      });
    }
    if (err.name === "AbortError") return next(new ApiError(504, "Upstream timeout"));
    if (res.headersSent) { res.end(); return; }
    next(err);
  }
});
