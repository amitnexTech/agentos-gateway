import express from "express";
import { adminRouter } from "./routes/admin.js";
import { proxyRouter } from "./routes/proxy.js";
import { anthropicRouter } from "./routes/anthropic.js";
import { responsesRouter } from "./routes/responses.js";
import { errorHandler } from "./lib/errors.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Dashboard & provider management
  app.use("/admin", adminRouter);

  // OpenAI Chat Completions API
  app.use("/v1", proxyRouter);

  // Anthropic Messages API (Claude Code)
  app.use("/v1", anthropicRouter);

  // OpenAI Responses API (Codex)
  app.use("/v1", responsesRouter);

  app.use(errorHandler);
  return app;
}
