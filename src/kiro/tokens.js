// Input-size measurement for the Kiro path.
//
// Kiro's API returns no input token count at all — it bills credits and reports
// a context-usage percentage, nothing more. But input IS the cost on Kiro: the
// protocol keeps no server-side conversation state, so converter.js re-sends the
// full history every turn and Kiro charges the whole payload each time. Logging
// `input_tokens: 0` (which the Kiro routes used to do) therefore hid the single
// largest cost driver and made the dashboard's $ column meaningless.
//
// These estimates are deliberately rough — ~4 chars per token, the same ratio
// stream.js already uses for output. They exist to show growth and relative
// scale, not to reconcile a bill. `contextUsagePercent` from Kiro is the exact
// number; this is the fallback that works even when Kiro omits it.

const CHARS_PER_TOKEN = 4;

// Kiro reports NO token counts (verified 2026-08-03 against the raw stream: the
// only numbers it sends are contextUsagePercentage and a credit figure), so every
// token number on the Kiro path is this estimate. Convert once from a total
// character count — rounding up per fragment, as the stream converters used to,
// inflated the result by up to 3 tokens per delta.
export function tokensFromChars(chars) {
  return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;
}

export function estimateTokens(text) {
  return tokensFromChars(text ? String(text).length : 0);
}

// Sum the characters of everything in a Kiro history/current message entry:
// content text, tool specifications, tool uses and tool results. All of it is
// billed input, so all of it counts.
function messageChars(entry) {
  if (!entry) return 0;
  let chars = 0;
  const msg = entry.userInputMessage || entry.assistantResponseMessage || entry;
  chars += String(msg.content || "").length;

  const ctx = msg.userInputMessageContext;
  if (ctx) {
    if (ctx.tools) chars += JSON.stringify(ctx.tools).length;
    if (ctx.toolResults) chars += JSON.stringify(ctx.toolResults).length;
  }
  if (msg.toolUses) chars += JSON.stringify(msg.toolUses).length;
  return chars;
}

/**
 * Measure the Kiro payload the gateway is about to send.
 *
 * @param {object} payload - the built Kiro request body (from anthropicToKiro
 *   or codexToKiro)
 * @returns {{ inputTokens: number, historyEntries: number, payloadChars: number }}
 *   inputTokens    — ~4-chars-per-token estimate of the whole billed payload
 *   historyEntries — how many prior turns are being re-sent this request
 *   payloadChars   — raw character count, the honest underlying measurement
 */
export function measureKiroPayload(payload) {
  const state = payload?.conversationState;
  if (!state) return { inputTokens: 0, historyEntries: 0, payloadChars: 0 };

  const history = state.history || [];
  let payloadChars = messageChars(state.currentMessage?.userInputMessage);
  for (const entry of history) payloadChars += messageChars(entry);

  return {
    inputTokens: Math.ceil(payloadChars / CHARS_PER_TOKEN),
    historyEntries: history.length,
    payloadChars,
  };
}
