// Kiro provider adapter — authenticates with a Kiro API key (ksk_).
// Speaks Kiro's native protocol; the anthropic/responses routes handle the
// request/response translation via src/kiro/converter.js and src/kiro/stream.js.

import { ProviderAdapter } from "./base.js";
import { chatHeaders, listModels, getProfile } from "../kiro/api.js";
import { getRuntimeHost, DEFAULT_REGION } from "../kiro/config.js";

export class KiroAdapter extends ProviderAdapter {
  supportsStreaming = true;
  supportsNonStreaming = true;

  constructor({ apiKey, providerType, region = DEFAULT_REGION }) {
    super({ baseUrl: getRuntimeHost(region), apiKey, providerType });
    this.region = region;
  }

  // Chat is served from the root path of the runtime host.
  getRequestUrl(_model, _options) {
    return `${this.baseUrl}/`;
  }

  getRequestHeaders() {
    return chatHeaders(this.apiKey);
  }

  async fetchModels() {
    return { models: await listModels(this.apiKey, this.region), correctedBaseUrl: null };
  }

  // Identifies which Kiro account this key belongs to.
  async getProfile() {
    return getProfile(this.apiKey, this.region);
  }
}
