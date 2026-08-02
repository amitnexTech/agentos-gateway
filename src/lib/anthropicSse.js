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

// Parse one Anthropic SSE line. The `event:` name is ignored on purpose — the
// JSON payload carries the same value in `type`, and providers are inconsistent
// about emitting the name.
function parseAnthropicSseLine(line) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// Line-buffered Anthropic SSE reader — the single parser for this event stream.
// onRaw, when given, receives every raw chunk before it is decoded, which is how
// pipeAnthropicSse forwards untouched bytes while still reading the events.
export async function* anthropicSseEvents(stream, { onRaw } = {}) {
  let buffer = "";
  for await (const raw of chunksFrom(stream)) {
    onRaw?.(raw);
    buffer += Buffer.from(raw).toString("utf8");

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      const event = parseAnthropicSseLine(line);
      if (event) yield event;
    }
  }
  const trailing = parseAnthropicSseLine(buffer.trim());
  if (trailing) yield trailing;
}

// Pipe an Anthropic Messages SSE stream to `res`, extracting the response model,
// id and usage as they appear. Returns { responseModel, responseId, usage }
// where usage is the merged Anthropic usage (use anthropicUsage() to map it).
export async function pipeAnthropicSse(upstream, res) {
  let responseModel = null;
  let responseId = null;
  let usage = null;

  for await (const evt of anthropicSseEvents(upstream.body ?? upstream, {
    onRaw: (raw) => res.write(raw), // raw bytes passthrough — do not modify the stream
  })) {
    if (evt.type === "message_start" && evt.message) {
      responseModel = responseModel || evt.message.model || null;
      responseId = responseId || evt.message.id || null;
      if (evt.message.usage) usage = { ...evt.message.usage };
    } else if (evt.type === "message_delta" && evt.usage) {
      usage = { ...usage, ...evt.usage };
    }
  }

  return { responseModel, responseId, usage };
}
