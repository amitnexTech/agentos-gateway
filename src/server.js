import { createApp } from "./app.js";
import { adminToken } from "./lib/adminAuth.js";

const PORT = process.env.PORT || 9000;
// Loopback by default: the proxy spends real credits and the dashboard holds
// API keys, so it must not be exposed to the LAN unless asked for explicitly.
const HOST = process.env.HOST || "127.0.0.1";
const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(`[agentos-gateway] listening on http://${HOST}:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/admin  (user: any, password: admin token)`);
  console.log(`  Admin token: ${adminToken()}`);
  console.log(`  Claude Code: set ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(`  Codex: set base_url=http://localhost:${PORT}/v1`);
});
