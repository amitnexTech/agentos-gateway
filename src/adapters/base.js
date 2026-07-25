export class ProviderAdapter {
  supportsStreaming = true;
  supportsNonStreaming = true;

  constructor({ baseUrl, apiKey, providerType, authType = "api-key" }) {
    if (new.target === ProviderAdapter) {
      throw new Error("ProviderAdapter is abstract; subclass it");
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.providerType = providerType;
    this.authType = authType;
  }

  translateRequest(openaiRequest) {
    return openaiRequest;
  }

  translateResponse(nativeResponse) {
    return nativeResponse;
  }

  translateStreamChunk(rawLine) {
    if (!rawLine.startsWith("data:")) return null;
    const payload = rawLine.slice(5).trim();
    if (payload === "[DONE]") return { done: true };
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  getRequestUrl(_model, _options) {
    throw new Error("getRequestUrl() not implemented");
  }

  getRequestHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  // Phase 2 hook: API-key adapters return the key; OAuth adapters receive a
  // live access token via the registry, so this just surfaces the credential.
  async getCredentials() {
    return { apiKey: this.apiKey };
  }

  // Upstream model-list URL. Override for providers with a non-standard path.
  getModelsUrl() {
    return `${this.baseUrl}/models`;
  }

  // Normalize an upstream model-list response to a flat [{ id }] array.
  // Handles OpenAI { data: [{id}] }, Gemini { models: [{name:"models/x"}] },
  // and top-level arrays (GitHub Models catalog).
  translateModelsResponse(body) {
    if (Array.isArray(body)) {
      return body.map((model) => ({ id: model.id })).filter((model) => model.id);
    }
    if (Array.isArray(body?.data)) {
      return body.data.map((model) => ({ id: model.id })).filter((model) => model.id);
    }
    if (Array.isArray(body?.models)) {
      return body.models
        .map((model) => ({ id: String(model.name || model.id || "").replace(/^models\//, "") }))
        .filter((model) => model.id);
    }
    return [];
  }
}
