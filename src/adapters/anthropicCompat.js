import { ProviderAdapter } from "./base.js";

// Anthropic-compatible provider adapter. For providers that speak the
// Anthropic Messages API natively (Anthropic direct, Kiro Gateway, etc.).
// The /v1/messages route forwards directly to these; the /v1/chat/completions
// route is NOT supported for this adapter type (use openai-compat for that).
export class AnthropicCompatAdapter extends ProviderAdapter {
  // This adapter is used by the anthropic route directly (passthrough),
  // not by the OpenAI chat/completions proxy. So getRequestUrl is for
  // the messages endpoint.
  getRequestUrl(_model, _options) {
    return `${this.baseUrl}/messages`;
  }

  getRequestHeaders() {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey || "",
      "anthropic-version": "2023-06-01",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  getModelsUrl() {
    return `${this.baseUrl}/models`;
  }

  // Anthropic /models response: { data: [{ id, ... }] }
  translateModelsResponse(body) {
    if (Array.isArray(body?.data)) {
      return body.data.map((model) => ({ id: model.id })).filter((model) => model.id);
    }
    if (Array.isArray(body)) {
      return body.map((model) => ({ id: model.id })).filter((model) => model.id);
    }
    return [];
  }
}
