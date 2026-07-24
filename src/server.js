import { createApp } from "./app.js";

const PORT = process.env.PORT || 9000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`[agentos-gateway] listening on http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/admin`);
  console.log(`  Claude Code: set ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(`  Codex: set base_url=http://localhost:${PORT}/v1`);
});
