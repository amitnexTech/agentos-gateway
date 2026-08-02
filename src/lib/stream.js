import { once } from "node:events";

async function writeSse(client, payload) {
  if (!client.write(`data: ${payload}\n\n`)) {
    await once(client, "drain");
  }
  client.flush?.();
}

export async function* chunksFrom(stream) {
  if (!stream) return;
  if (typeof stream[Symbol.asyncIterator] === "function") {
    yield* stream;
    return;
  }
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// Normalise Chat Completions usage into the shape logStore expects (the same
// field names the Anthropic path produces), so cost/tok-s work on this route too.
// OpenAI reports cached prompt tokens under prompt_tokens_details.cached_tokens
// and counts them inside prompt_tokens, so they are split out here.
export function openAiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const cacheRead = usage.prompt_tokens_details?.cached_tokens || 0;
  const prompt = usage.prompt_tokens || 0;
  return {
    input_tokens: Math.max(prompt - cacheRead, 0),
    output_tokens: usage.completion_tokens || 0,
    ...(cacheRead ? { cache_read: cacheRead } : {}),
  };
}

export async function pipeStreamSSE(upstream, client, adapter) {
  let buffer = "";
  let sawDone = false;
  // Sniffed from the chunks as they pass, so the request log can record what the
  // upstream actually answered with. Without this the OpenAI route logged no
  // responseModel and no usage at all, which left model-swap detection and token
  // accounting dead on /v1/chat/completions.
  const seen = { responseModel: null, responseId: null, usage: null };

  const observe = (payload) => {
    if (!payload || typeof payload !== "object") return;
    if (!seen.responseModel && typeof payload.model === "string") seen.responseModel = payload.model;
    if (!seen.responseId && typeof payload.id === "string") seen.responseId = payload.id;
    // Only present when the client asked for stream_options.include_usage.
    if (payload.usage) seen.usage = payload.usage;
  };

  for await (const chunk of chunksFrom(upstream)) {
    buffer += Buffer.from(chunk).toString("utf8");
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      const translated = adapter.translateStreamChunk(line);
      if (translated === null) continue;
      if (translated.done) {
        sawDone = true;
        await writeSse(client, "[DONE]");
        continue;
      }
      observe(translated);
      await writeSse(client, JSON.stringify(translated));
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const translated = adapter.translateStreamChunk(trailing);
    if (translated?.done) {
      sawDone = true;
      await writeSse(client, "[DONE]");
    } else if (translated) {
      observe(translated);
      await writeSse(client, JSON.stringify(translated));
    }
  }

  if (!sawDone) {
    await writeSse(client, "[DONE]");
  }

  return seen;
}
