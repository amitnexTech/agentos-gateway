import { ProviderAdapter } from "./base.js";

export class OpenAICompatAdapter extends ProviderAdapter {
  getRequestUrl(_model, _options) {
    return `${this.baseUrl}/chat/completions`;
  }
}
