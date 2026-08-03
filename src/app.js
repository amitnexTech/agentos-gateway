import express from "express";
import { adminRouter } from "./routes/admin.js";
import { proxyRouter } from "./routes/proxy.js";
import { anthropicRouter } from "./routes/anthropic.js";
import { responsesRouter } from "./routes/responses.js";
import { errorHandler } from "./lib/errors.js";
import { adminAuth } from "./lib/adminAuth.js";
import { requestContextMiddleware } from "./lib/requestContext.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  // Resolves which project/client each request came from, once, so spend can be
  // attributed without threading an argument through every logRequest call site.
  app.use(requestContextMiddleware);

  // Dashboard & provider management (secret-protected: it exposes API keys)
  app.use("/admin", adminAuth, adminRouter);

  // OpenAI Chat Completions API
  app.use("/v1", proxyRouter);

  // Anthropic Messages API (Claude Code)
  app.use("/v1", anthropicRouter);

  // OpenAI Responses API (Codex)
  app.use("/v1", responsesRouter);

  app.use(errorHandler);
  return app;
}
