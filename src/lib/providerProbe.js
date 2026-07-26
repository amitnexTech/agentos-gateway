import { createAdapter } from "../registry.js";
import { upstreamErrorMessage } from "./upstreamError.js";

// Test a provider by sending a minimal chat request to a specific model.
// Does NOT fetch /models — uses the modelId provided directly.
export async function probeProvider(provider, { modelId } = {}) {
  if (!modelId) {
    return { ok: false, chat: "skipped", reason: "No model specified for probe" };
  }

  const adapter = await createAdapter(provider);

  // Kiro providers speak their own protocol — build the payload via the converter.
  if (provider.type === "kiro") {
    const { anthropicToKiro } = await import("../kiro/converter.js");
    const payload = anthropicToKiro({
      model: modelId,
      messages: [{ role: "user", content: "Reply with only: ok" }],
      max_tokens: 10,
    });

    const response = await fetch(adapter.getRequestUrl(modelId, { stream: false }), {
      method: "POST",
      headers: adapter.getRequestHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Kiro probe failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    return { ok: true, chat: "ok", modelId };
  }

  // For anthropic-compat providers, test via /messages endpoint
  if (provider.type === "anthropic-compat") {
    const messagesUrl = `${adapter.baseUrl}/messages`;
    const response = await fetch(messagesUrl, {
      method: "POST",
      headers: adapter.getRequestHeaders(),
      body: JSON.stringify({
        model: modelId,
        max_tokens: 10,
        messages: [{ role: "user", content: "Reply with only: ok" }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const detail = await upstreamErrorMessage(response);
      throw new Error(`Chat probe failed (${response.status}): ${detail}`);
    }

    return { ok: true, chat: "ok", modelId };
  }

  // For openai-compat / local-openai, test via chat/completions
  if (typeof adapter.completeChat === "function") {
    await adapter.completeChat({
      model: modelId,
      messages: [{ role: "user", content: "Reply with only: ok" }],
      max_tokens: 8,
    });
    return { ok: true, chat: "ok", modelId };
  }

  const response = await fetch(adapter.getRequestUrl(modelId, { stream: false }), {
    method: "POST",
    headers: adapter.getRequestHeaders(),
    body: JSON.stringify(
      adapter.translateRequest({
        model: modelId,
        messages: [{ role: "user", content: "Reply with only: ok" }],
        max_tokens: 8,
      }),
    ),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const detail = await upstreamErrorMessage(response);
    throw new Error(`Chat probe failed (${response.status}): ${detail}`);
  }

  return { ok: true, chat: "ok", modelId };
}
