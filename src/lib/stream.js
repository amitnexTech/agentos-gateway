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

export async function pipeStreamSSE(upstream, client, adapter) {
  let buffer = "";
  let sawDone = false;

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
      await writeSse(client, JSON.stringify(translated));
    }
  }

  if (!sawDone) {
    await writeSse(client, "[DONE]");
  }
}
