// Bridged adapters — a provider serving a route whose protocol it does not speak.
//
// These are mixins rather than plain classes because the bridge must keep the
// base adapter's URL and headers: chat-over-anthropic still posts to /messages
// with x-api-key, and anthropic-over-chat must keep local-openai's no-auth
// headers. Subclassing AnthropicCompatAdapter / OpenAICompatAdapter directly
// would silently send a Bearer token to a local runtime that has no key.
//
// Only translateRequest / translateResponse are overridden; streaming is not a
// per-line transform (Anthropic's event stream and OpenAI's chunk stream do not
// map 1:1), so the routes select a bridge pipe from lib/protocolBridge.js based
// on the `bridge` marker below. registry.js decides when to apply a mixin.

import {
  chatToAnthropicRequest,
  anthropicToChatResponse,
  anthropicToChatRequest,
  chatToAnthropicResponse,
} from "../lib/protocolBridge.js";

// One subclass per base class, created once. A fresh class per createAdapter()
// call would break `instanceof` and defeat the JIT for no reason.
function memoise(cache, Base, make) {
  let Bridged = cache.get(Base);
  if (!Bridged) {
    Bridged = make(Base);
    cache.set(Base, Bridged);
  }
  return Bridged;
}

const chatOverAnthropicCache = new WeakMap();
const anthropicOverChatCache = new WeakMap();

// Client speaks OpenAI Chat Completions, provider speaks Anthropic Messages.
export function chatOverAnthropic(Base) {
  return memoise(chatOverAnthropicCache, Base, (B) =>
    class ChatOverAnthropicAdapter extends B {
      bridge = "chat-over-anthropic";

      translateRequest(body) {
        return chatToAnthropicRequest(body);
      }

      translateResponse(body) {
        return anthropicToChatResponse(body);
      }
    }
  );
}

// Client speaks Anthropic Messages, provider speaks OpenAI Chat Completions.
export function anthropicOverChat(Base) {
  return memoise(anthropicOverChatCache, Base, (B) =>
    class AnthropicOverChatAdapter extends B {
      bridge = "anthropic-over-chat";

      translateRequest(body) {
        return anthropicToChatRequest(body);
      }

      translateResponse(body) {
        return chatToAnthropicResponse(body);
      }
    }
  );
}
