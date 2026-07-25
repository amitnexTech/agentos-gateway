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

  console.error("[agentos-gateway] unhandled error", err);
  res.status(500).json({
    error: { message: "Internal gateway error", type: "internal" },
  });
}
