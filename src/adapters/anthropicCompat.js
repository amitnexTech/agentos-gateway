import { ProviderAdapter } from "./base.js";

// Anthropic-compatible provider adapter — for providers that speak the
// Anthropic Messages API natively (Anthropic direct, Lumosel, etc.). The
// /v1/messages route forwards directly to these. Kiro has its own adapter type
// (adapters/kiro.js): it accepts Anthropic-shaped requests but its wire protocol
// differs, so it is handled via kiro/client.js rather than this passthrough.
// /v1/chat/completions is NOT supported for this adapter type; use openai-compat.
export class AnthropicCompatAdapter extends ProviderAdapter {
  // This adapter is used by the anthropic route directly (passthrough),
  // not by the OpenAI chat/completions proxy. So getRequestUrl is for
  // the messages endpoint.
  getRequestUrl(_model, _options) {
    return `${this.baseUrl}/messages`;
  }

  // anthropicVersion overrides the default (2023-06-01) so the /v1/messages
  // route can forward the version the client actually sent.
  getRequestHeaders({ anthropicVersion } = {}) {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey || "",
      "anthropic-version": anthropicVersion || "2023-06-01",
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
