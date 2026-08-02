import { OpenAICompatAdapter } from "./adapters/openaiCompat.js";
import { LocalOpenAIAdapter } from "./adapters/localOpenAI.js";
import { AnthropicCompatAdapter } from "./adapters/anthropicCompat.js";
import { KiroAdapter } from "./adapters/kiro.js";
import { chatOverAnthropic, anthropicOverChat } from "./adapters/bridge.js";
import { envGet } from "./config/envStore.js";

const REGISTRY = {
  "openai-compat": OpenAICompatAdapter,
  "anthropic-compat": AnthropicCompatAdapter,
  "local-openai": LocalOpenAIAdapter,
  "kiro": KiroAdapter,
};

// Which mixin to wrap a provider's adapter in when the CALLER's protocol differs
// from the provider's own (see adapters/bridge.js and lib/protocolBridge.js).
// Keyed by what the inbound route speaks, then by provider type. A pairing that
// is absent here has no translation and is refused by TOOL_PROVIDER_TYPES in
// config/keysStore.js — notably Kiro, whose wire protocol is not Anthropic
// Messages despite accepting Anthropic-shaped input.
const BRIDGES = {
  "openai-chat": {
    "anthropic-compat": chatOverAnthropic,
  },
  "anthropic-messages": {
    "openai-compat": anthropicOverChat,
    "local-openai": anthropicOverChat,
  },
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

// `speaks` is the wire protocol of the ROUTE that is asking for the adapter
// ("openai-chat" | "anthropic-messages"). When it differs from the provider's own
// protocol the adapter is wrapped in a translation mixin, which is what lets an
// anthropic-compat provider serve /v1/chat/completions and an openai-compat
// provider serve /v1/messages. Omit it for a same-protocol passthrough.
export async function createAdapter(provider, { speaks } = {}) {
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

  const bridge = speaks ? BRIDGES[speaks]?.[provider.type] : null;
  const Resolved = bridge ? bridge(Adapter) : Adapter;

  return new Resolved({
    baseUrl: provider.baseUrl,
    apiKey,
    providerType: provider.type,
  });
}
