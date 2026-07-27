// Line-buffered Anthropic SSE passthrough that extracts model + id + usage for
// logging / swap-detection. Replaces the inline regex sniffing that lived in
// routes/anthropic.js, which had two near-identical branches (getReader vs
// asyncIterator) and could miss events split across chunk boundaries because
// it regex-matched raw chunk text instead of buffering by SSE line.
//
// Bytes are passed through to the client untouched; metadata is returned.

import { chunksFrom } from "./stream.js";

// Map an Anthropic usage object (with cache_read_input_tokens /
// cache_creation_input_tokens) into the flat shape logRequest expects.
export function anthropicUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read: u.cache_read_input_tokens || u.cache_read || 0,
    cache_write: u.cache_creation_input_tokens || u.cache_write || 0,
  };
}

// Pipe an Anthropic Messages SSE stream to `res`, extracting the response model,
// id and usage as they appear. Returns { responseModel, responseId, usage }
// where usage is the merged Anthropic usage (use anthropicUsage() to map it).
export async function pipeAnthropicSse(upstream, res) {
  let buffer = "";
  let responseModel = null;
  let responseId = null;
  let usage = null;

  for await (const raw of chunksFrom(upstream.body ?? upstream)) {
    res.write(raw); // raw bytes passthrough — do not modify the stream
    buffer += Buffer.from(raw).toString("utf8");

    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      if (evt.type === "message_start" && evt.message) {
        responseModel = responseModel || evt.message.model || null;
        responseId = responseId || evt.message.id || null;
        if (evt.message.usage) usage = { ...evt.message.usage };
      } else if (evt.type === "message_delta" && evt.usage) {
        usage = { ...usage, ...evt.usage };
      }
    }
  }

  return { responseModel, responseId, usage };
}
