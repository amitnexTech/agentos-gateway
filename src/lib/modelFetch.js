import { upstreamErrorMessage } from "./upstreamError.js";

// Fetch the list of available models from an upstream provider.
// Auto-appends /v1 if baseUrl doesn't already end with it.
export async function fetchModels({ adapter, apiKey }) {
  // If adapter has custom fetchModels (e.g. Kiro), use that
  if (typeof adapter.fetchModels === "function") {
    return adapter.fetchModels();
  }

  const headers = { ...adapter.getRequestHeaders() };
  if (apiKey !== undefined && headers.Authorization === undefined && !adapter.supportsNoAuth) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // If adapter doesn't have a models URL, return empty
  const modelsUrlBase = adapter.getModelsUrl ? adapter.getModelsUrl() : null;
  if (!modelsUrlBase && !adapter.baseUrl) {
    return { models: [], correctedBaseUrl: null };
  }

  // Normalize: ensure /v1/models path regardless of whether user gave /v1 or not
  const baseUrl = adapter.baseUrl.replace(/\/$/, "");
  const modelsUrl = baseUrl.endsWith("/v1")
    ? baseUrl + "/models"
    : baseUrl + "/v1/models";

  const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(15000) });

  if (!response.ok) {
    const detail = await upstreamErrorMessage(response);
    throw new Error(`Upstream /models failed (${response.status}): ${detail}`);
  }

  const body = await response.json();
  const models = adapter.translateModelsResponse(body);

  // Return corrected baseUrl if we had to add /v1
  const correctedBaseUrl = baseUrl.endsWith("/v1") ? null : baseUrl + "/v1";
  return { models, correctedBaseUrl };
}
