import { OpenAICompatAdapter } from "./adapters/openaiCompat.js";
import { LocalOpenAIAdapter } from "./adapters/localOpenAI.js";
import { AnthropicCompatAdapter } from "./adapters/anthropicCompat.js";
import { KiroAdapter } from "./adapters/kiro.js";
import { envGet } from "./config/envStore.js";

const REGISTRY = {
  "openai-compat": OpenAICompatAdapter,
  "anthropic-compat": AnthropicCompatAdapter,
  "local-openai": LocalOpenAIAdapter,
  "kiro": KiroAdapter,
};

const OPTIONAL_API_KEY_TYPES = new Set(["local-openai"]);

export class UnknownProviderTypeError extends Error {
  constructor(type) {
    super(`Unknown provider type: ${type}`);
    this.name = "UnknownProviderTypeError";
  }
}

export class MissingSecretError extends Error {
  constructor(providerId, ref) {
    super(`Missing secret ${ref} for provider ${providerId}`);
    this.name = "MissingSecretError";
  }
}

export function supportedTypes() {
  return Object.keys(REGISTRY);
}

export async function createAdapter(provider) {
  const Adapter = REGISTRY[provider.type];
  if (!Adapter) throw new UnknownProviderTypeError(provider.type);

  const apiKey = provider.apiKeyRef ? envGet(provider.apiKeyRef) : undefined;
  if (!apiKey && !OPTIONAL_API_KEY_TYPES.has(provider.type)) {
    throw new MissingSecretError(provider.id, provider.apiKeyRef);
  }

  // Kiro derives its endpoints from the region; it has no user-supplied baseUrl.
  if (provider.type === "kiro") {
    return new Adapter({
      apiKey,
      providerType: provider.type,
      region: provider.region || "us-east-1",
    });
  }

  return new Adapter({
    baseUrl: provider.baseUrl,
    apiKey,
    providerType: provider.type,
  });
}
