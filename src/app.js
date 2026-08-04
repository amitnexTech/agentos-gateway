import express from "express";
import { adminRouter } from "./routes/admin.js";
import { proxyRouter } from "./routes/proxy.js";
import { anthropicRouter } from "./routes/anthropic.js";
import { responsesRouter } from "./routes/responses.js";
import { errorHandler, ApiError } from "./lib/errors.js";
import { adminAuth } from "./lib/adminAuth.js";
import { requestContextMiddleware, tagProfile } from "./lib/requestContext.js";
import { getProfiles, resolveProfile } from "./config/keysStore.js";

// A session picks its routing profile with the base URL it was given:
//   ANTHROPIC_BASE_URL=http://localhost:9000/p/backend -> /p/backend/v1/messages
// An unknown or broken profile is REFUSED here. Falling through to the global
// routing instead would serve the session from whatever account the dashboard
// happens to point at, so a typo would spend real money on the wrong account and
// still look like it worked. See keysStore.js "Session profiles".
function profileGate(req, _res, next) {
  const name = req.params.profile;
  if (!resolveProfile(name)) {
    const known = Object.keys(getProfiles());
    return next(
      new ApiError(
        404,
        getProfiles()[name]
          ? `Routing profile "${name}" points at a provider that is missing or disabled — fix it in the dashboard.`
          : `Unknown routing profile "${name}". ${known.length ? `Configured: ${known.join(", ")}.` : "None are configured yet."}`
      )
    );
  }
  tagProfile(name);
  next();
}

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

  // The same three routes under a session profile. Same handlers, same rules —
  // only provider/model resolution changes (kiro/client.js lookupModelForTool).
  app.use("/p/:profile", profileGate);
  app.use("/p/:profile/v1", proxyRouter, anthropicRouter, responsesRouter);

  app.use(errorHandler);
  return app;
}
