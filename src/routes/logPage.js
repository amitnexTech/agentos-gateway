export function renderLogPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentOS Gateway — Logs</title>
  <style>
    :root { --bg:#f6f7f4; --ink:#18211f; --muted:#66716b; --panel:#fff; --line:#d8dfd8; --accent:#0d6f63; --bad:#a73737; --warn:#9b4a10; font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); }
    .shell { width:min(1400px,calc(100vw - 32px)); margin:0 auto; padding:24px 0 36px; }
    header { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); padding-bottom:16px; margin-bottom:16px; }
    h1 { margin:0; font-size:22px; }
    .actions { display:flex; gap:8px; align-items:center; }
    button { border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:7px; min-height:34px; padding:0 12px; cursor:pointer; font:inherit; }
    button:hover { border-color:var(--accent); }
    button.danger { color:var(--bad); }
    select { border:1px solid var(--line); border-radius:7px; min-height:34px; padding:0 8px; font:inherit; background:var(--panel); }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .pill { display:inline-flex; align-items:center; gap:6px; min-height:28px; padding:0 10px; border:1px solid var(--line); border-radius:999px; background:var(--panel); color:var(--muted); font-size:12px; }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:8px 10px; font-size:13px; vertical-align:top; }
    th { font-size:11px; font-weight:700; text-transform:uppercase; color:var(--muted); position:sticky; top:0; background:var(--bg); }
    .mono { font-family:"SFMono-Regular",Consolas,monospace; font-size:12px; }
    .badge { display:inline-block; min-height:22px; padding:0 7px; border-radius:999px; font-size:11px; line-height:22px; }
    .badge.ok { background:#e5f3ef; color:var(--accent); }
    .badge.error { background:#f7e9e7; color:var(--bad); }
    .badge.claude { background:#f0e8ff; color:#6b21a8; }
    .badge.codex { background:#e8f4ff; color:#1d4ed8; }
    .badge.openai { background:#fef3e2; color:#92400e; }
    .latency { color:var(--muted); }
    .latency.fast { color:var(--accent); }
    .latency.slow { color:var(--warn); }
    .latency.very-slow { color:var(--bad); }
    .error-cell { color:var(--bad); font-size:12px; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .badge.error { background:#f7e9e7; color:var(--bad); font-weight:600; }
    .mismatch-row { background:#fff5f5; }
    .empty { color:var(--muted); padding:40px; text-align:center; font-size:14px; }
    .table-wrap { overflow-x:auto; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Request Logs</h1>
        <div style="margin-top:4px;color:var(--muted);font-size:13px">Last 200 requests (persisted across restarts)</div>
      </div>
      <div class="actions">
        <span class="pill" id="countPill">0 entries</span>
        <span class="pill" id="costPill">$0.00</span>
        <span class="pill" id="creditsPill" title="Kiro credits only">0 cr</span>
        <span class="pill" id="tokenPill">0 tokens</span>
        <select id="filterTool">
          <option value="">All tools</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="openai">OpenAI</option>
        </select>
        <button id="refreshBtn">Refresh</button>
        <button class="danger" id="clearBtn">Clear</button>
        <a href="/admin">&larr; Dashboard</a>
      </div>
    </header>

    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Time</th><th>Tool</th><th>Model (req → resp)</th><th>Provider</th><th>Tokens (in/out/cache)</th><th>Cost</th><th>Kiro Cr</th><th>Latency</th><th title="Output tokens per second — the speed fingerprint of the model that actually ran">tok/s</th><th>Status</th><th>Error</th></tr>
        </thead>
        <tbody id="logBody"></tbody>
      </table>
    </div>
  </main>

  <script>
    const el = (id) => document.getElementById(id);

    function escapeHtml(v) { return String(v||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }

    function formatTime(iso) {
      const d = new Date(iso);
      return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3,"0");
    }

    function latencyClass(ms) {
      if (ms < 2000) return "fast";
      if (ms < 8000) return "slow";
      return "very-slow";
    }

    function formatLatency(ms) {
      if (ms < 1000) return ms + "ms";
      return (ms / 1000).toFixed(1) + "s";
    }

    async function loadLogs() {
      const tool = el("filterTool").value;
      const url = "/admin/logs/data?limit=200" + (tool ? "&tool="+tool : "");
      try {
        const r = await fetch(url);
        const logs = await r.json();
        el("countPill").textContent = logs.length + " entries";
        const totalCost = logs.reduce((s,l) => s + (l.cost||0), 0);
        const totalTokens = logs.reduce((s,l) => s + (l.usage?.input_tokens||0) + (l.usage?.output_tokens||0), 0);
        const totalCredits = logs.reduce((s,l) => s + (l.kiroCredits||0), 0);
        el("costPill").textContent = "$" + totalCost.toFixed(3);
        el("creditsPill").textContent = totalCredits.toFixed(4) + " cr (Kiro)";
        el("tokenPill").textContent = totalTokens.toLocaleString() + " tokens";
        if (!logs.length) {
          el("logBody").innerHTML = '<tr><td colspan="11"><div class="empty">No requests logged yet. Use Claude Code, Codex, or any tool to generate traffic.</div></td></tr>';
          return;
        }
        el("logBody").innerHTML = logs.map(l => {
          const alias = l.rawModel ? '<span class="mono" style="color:var(--muted)" title="Client asked for this; the gateway alias-mapped it">'+escapeHtml(l.rawModel)+' ⇒ </span>' : '';
          const modelCell = alias + (l.responseModel
            ? (l.modelMismatch
              ? '<span class="mono">'+escapeHtml(l.model)+'</span> → <span class="badge error" title="MISMATCH! Requested '+escapeHtml(l.model)+' but got '+escapeHtml(l.responseModel)+'">'+escapeHtml(l.responseModel)+' ⚠</span>'
              : '<span class="mono">'+escapeHtml(l.model)+'</span> → <span class="badge ok">'+escapeHtml(l.responseModel)+'</span>')
            : '<span class="mono">'+escapeHtml(l.model)+'</span>')
            + (l.responseId ? '<div class="mono" style="color:var(--muted);font-size:11px" title="Upstream message id. Real Anthropic ids look like msg_01… — a synthetic shape means a proxy generated it.">'+escapeHtml(l.responseId)+'</div>' : '');
          const tokenCell = l.usage
            ? '<span class="mono">'+l.usage.input_tokens+'↓ '+l.usage.output_tokens+'↑'+(l.usage.cache_read?' C:'+l.usage.cache_read+'r':'')+(l.usage.cache_write?' '+l.usage.cache_write+'w':'')+'</span>'
            : '<span style="color:var(--muted)">—</span>';
          const costCell = l.cost !== null ? '<span class="mono">$'+l.cost.toFixed(4)+'</span>' : '—';
          const creditsCell = l.kiroCredits ? '<span class="mono">'+l.kiroCredits.toFixed(4)+' cr</span>' : '';
          const tpsCell = l.tps != null ? '<span class="mono">'+l.tps.toFixed(1)+'</span>' : '<span style="color:var(--muted)">—</span>';
          return '<tr>' +
            '<td class="mono">'+formatTime(l.ts)+'</td>' +
            '<td><span class="badge '+escapeHtml(l.tool)+'">'+escapeHtml(l.tool)+'</span></td>' +
            '<td>'+modelCell+'</td>' +
            '<td>'+escapeHtml(l.providerName)+(l.fallback?' <span class="badge" style="background:#fef3e2;color:#92400e" title="Served by a fallback provider after the primary failed">fallback</span>':'')+'</td>' +
            '<td>'+tokenCell+'</td>' +
            '<td>'+costCell+'</td>' +
            '<td>'+creditsCell+'</td>' +
            '<td><span class="latency '+latencyClass(l.latencyMs)+'">'+formatLatency(l.latencyMs)+'</span></td>' +
            '<td>'+tpsCell+'</td>' +
            '<td><span class="badge '+escapeHtml(l.status)+'">'+escapeHtml(l.status)+'</span></td>' +
            '<td class="error-cell" title="'+escapeHtml(l.error||"")+'">'+escapeHtml(l.error||"—")+'</td>' +
          '</tr>';
        }).join("");
      } catch(e) {
        el("logBody").innerHTML = '<tr><td colspan="11"><div class="empty">Failed to load logs: '+escapeHtml(e.message)+'</div></td></tr>';
      }
    }

    el("refreshBtn").addEventListener("click", loadLogs);
    el("filterTool").addEventListener("change", loadLogs);
    el("clearBtn").addEventListener("click", async () => {
      if (!confirm("Clear all logs?")) return;
      await fetch("/admin/logs", { method: "DELETE" });
      loadLogs();
    });

    loadLogs();
    // Auto-refresh every 5s
    setInterval(loadLogs, 5000);
  </script>
</body>
</html>`;
}
