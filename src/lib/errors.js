import { isNetworkError, networkErrorToApiError } from "./netError.js";

export class ApiError extends Error {
  constructor(status, message, upstreamStatus) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

export function errorHandler(err, _req, res, _next) {
  if (res.headersSent) return res.end();

  if (err instanceof ApiError) {
    const error = { message: err.message, type: "gateway_error" };
    if (err.upstreamStatus) error.upstream_status = err.upstreamStatus;
    res.status(err.status).json({ error });
    return;
  }

  // A connectivity failure that reached here bypassed the per-route mapping
  // (e.g. a fetch outside callUpstream/executeKiro). Report it as one readable
  // line instead of dumping an undici stack trace per failed request — that
  // noise buried real errors and said nothing beyond "provider unreachable".
  if (isNetworkError(err)) {
    const mapped = networkErrorToApiError(err, "upstream provider");
    console.error(`[agentos-gateway] ${mapped.message}`);
    res.status(mapped.status).json({
      error: { message: mapped.message, type: "gateway_error" },
    });
    return;
  }

  console.error("[agentos-gateway] unhandled error", err);
  res.status(500).json({
    error: { message: "Internal gateway error", type: "internal" },
  });
}
