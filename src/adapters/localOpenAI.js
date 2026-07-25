import { OpenAICompatAdapter } from "./openaiCompat.js";

export class LocalOpenAIAdapter extends OpenAICompatAdapter {
  getRequestHeaders() {
    return {
      "Content-Type": "application/json",
    };
  }
}
