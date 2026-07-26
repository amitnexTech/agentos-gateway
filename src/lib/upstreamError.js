async function safeText(response) {
  if (typeof response.text !== "function") return "";
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseMaybeJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

export function extractUpstreamError(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return extractUpstreamError(parseMaybeJson(value)) || value.trim();
  }

  const error = value.error;
  if (typeof error === "string") return error.trim();

  const message = firstString(
    error?.message,
    error?.error,
    error?.detail,
    error?.description,
    value.message,
    value.error_description,
    value.detail,
    value.errors?.[0]?.message,
  );
  if (!message) return "";

  const code = firstString(error?.code, value.code);
  return code ? `${message} (${code})` : message;
}

function htmlErrorSummary(text) {
  if (!/^\s*<(?:!doctype|html)/i.test(text)) return "";
  const title = text
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.trim()
    .replace(/\s+/g, " ");
  const suffix = "upstream returned an HTML error page, not JSON — provider-side failure";
  return title ? `${suffix} (${title})` : suffix;
}

export async function upstreamErrorMessage(response, { limit = 500 } = {}) {
  const text = await safeText(response);
  const message =
    htmlErrorSummary(text) ||
    extractUpstreamError(text) ||
    response.statusText ||
    String(response.status || "upstream error");
  return message.slice(0, limit);
}
