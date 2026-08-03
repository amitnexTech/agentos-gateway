// Spend page: what the 200-entry request log cannot answer — how many tokens went
// out this month, on which project, through which provider and model, and what it
// cost. Reads /admin/spend/data (spendStore aggregates). Same inline-HTML, no-build
// approach as the log page.

export function renderSpendPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentOS Gateway — Spend</title>
  <style>
    :root { --bg:#f6f7f4; --ink:#18211f; --muted:#66716b; --panel:#fff; --line:#d8dfd8; --accent:#0d6f63; --bad:#a73737; --warn:#9b4a10; font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); }
    .shell { width:min(1400px,calc(100vw - 32px)); margin:0 auto; padding:24px 0 36px; }
    header { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); padding-bottom:16px; margin-bottom:16px; }
    h1 { margin:0; font-size:22px; }
    h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 8px; }
    .actions { display:flex; gap:8px; align-items:center; }
    button, select { border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:7px; min-height:34px; padding:0 10px; cursor:pointer; font:inherit; }
    button:hover { border-color:var(--accent); }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:20px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
    .card .label { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
    .card .value { font-size:24px; font-weight:600; margin-top:4px; font-family:"SFMono-Regular",Consolas,monospace; }
    .card .sub { font-size:11px; color:var(--muted); margin-top:2px; }
    .panels { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:16px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:6px 8px; font-size:13px; }
    th { font-size:11px; font-weight:700; text-transform:uppercase; color:var(--muted); }
    td.num, th.num { text-align:right; font-family:"SFMono-Regular",Consolas,monospace; font-size:12px; }
    tr:last-child td { border-bottom:none; }
    .bar { height:4px; border-radius:2px; background:var(--accent); opacity:.35; margin-top:3px; }
    .note { color:var(--muted); font-size:12px; margin:14px 0 0; }
    .empty { color:var(--muted); padding:30px; text-align:center; font-size:14px; }
    .est { color:var(--warn); }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Spend</h1>
        <div class="note" style="margin:2px 0 0">Every request ever proxied, not the last 200. <a href="/admin/logs">Request log</a> · <a href="/admin">Dashboard</a></div>
      </div>
      <div class="actions">
        <select id="month"></select>
        <button id="refresh">Refresh</button>
      </div>
    </header>

    <div id="body"><div class="empty">Loading…</div></div>
  </main>

<script>
  const el = (id) => document.getElementById(id);
  const fmt = (n) => (n || 0).toLocaleString();
  const money = (n) => "$" + (n || 0).toFixed(n && n < 1 ? 4 : 2);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  let currentMonth = "";

  function tokensCell(b) {
    // A row whose tokens are partly estimated is marked, because on Kiro every
    // token number is a ~4-chars-per-token estimate rather than a count.
    const est = b.estimatedRequests > 0 ? '<span class="est" title="' + b.estimatedRequests + ' of ' + b.requests + ' requests report no token counts upstream; those are ~4-chars-per-token estimates">~</span>' : "";
    return est + fmt(b.totalTokens);
  }

  function costCell(b) {
    if (!b.costedRequests) return '<span style="color:var(--muted)" title="No request in this group has a known price">—</span>';
    const partial = b.costedRequests < b.requests
      ? '<span style="color:var(--muted)" title="Covers ' + b.costedRequests + ' of ' + b.requests + ' requests; the rest are models with no known rate"> *</span>'
      : "";
    return money(b.cost) + partial;
  }

  function breakdown(title, groups, opts) {
    const rows = Object.entries(groups).sort((a, b) => (b[1][opts.sortBy] || 0) - (a[1][opts.sortBy] || 0));
    if (!rows.length) return "";
    const max = rows[0][1][opts.sortBy] || 1;
    return '<div class="panel"><h2>' + title + '</h2><table><thead><tr>' +
      '<th>' + opts.keyLabel + '</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Cost</th>' +
      (opts.showCredits ? '<th class="num" title="Kiro credits — the real spend on Kiro accounts">Credits</th>' : "") +
      '</tr></thead><tbody>' +
      rows.map(([name, b]) =>
        '<tr><td>' + esc(name) +
        '<div class="bar" style="width:' + Math.max(2, Math.round(((b[opts.sortBy] || 0) / max) * 100)) + '%"></div></td>' +
        '<td class="num">' + fmt(b.requests) + (b.errors ? ' <span style="color:var(--bad)">(' + b.errors + ' err)</span>' : "") + '</td>' +
        '<td class="num">' + tokensCell(b) + '</td>' +
        '<td class="num">' + costCell(b) + '</td>' +
        (opts.showCredits ? '<td class="num">' + (b.credits ? b.credits.toFixed(3) : "—") + '</td>' : "") +
        '</tr>').join("") +
      '</tbody></table></div>';
  }

  function render(data) {
    if (!data.totals.requests) {
      el("body").innerHTML = '<div class="empty">Nothing recorded yet for this period. Every proxied request is appended to <span class="mono">data/spend.jsonl</span>.</div>';
      return;
    }
    const t = data.totals;
    const days = Object.keys(data.byDay).length || 1;
    el("body").innerHTML =
      '<div class="cards">' +
        card("Requests", fmt(t.requests), t.errors ? t.errors + " errors" : "no errors") +
        card("Tokens", tokensCell(t), fmt(t.inputTokens) + " in / " + fmt(t.outputTokens) + " out") +
        card("Cost", costCell(t), t.costedRequests < t.requests ? t.costedRequests + " of " + t.requests + " priced" : "all requests priced") +
        card("Kiro credits", t.credits ? t.credits.toFixed(3) : "—", "real spend on Kiro") +
        card("Cache", fmt(t.cacheReadTokens) + " r", fmt(t.cacheWriteTokens) + " written") +
        card("Per day", fmt(Math.round(t.totalTokens / days)), "tokens across " + days + " active day(s)") +
      '</div>' +
      '<div class="panels">' +
        breakdown("By project", data.byProject, { keyLabel: "Project", sortBy: "totalTokens" }) +
        breakdown("By provider", data.byProvider, { keyLabel: "Provider", sortBy: "totalTokens", showCredits: true }) +
        breakdown("By model", data.byModel, { keyLabel: "Model", sortBy: "totalTokens", showCredits: true }) +
        breakdown("By tool", data.byTool, { keyLabel: "Tool", sortBy: "totalTokens" }) +
        breakdown("By client", data.byClient, { keyLabel: "Client", sortBy: "totalTokens" }) +
        breakdown("By day", data.byDay, { keyLabel: "Day", sortBy: "requests" }) +
      '</div>' +
      '<p class="note">A <span class="est">~</span> means those token numbers are the gateway estimate: the provider reported none (that is every Kiro request). A <b>*</b> on a cost means it covers only the requests whose model has a known rate — see <span class="mono">MODEL_RATES</span> in logStore.js. "unknown" under a project means the client sent nothing identifying; set <span class="mono">x-agentos-project</span> to label it.</p>';
  }

  function card(label, value, sub) {
    return '<div class="card"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + esc(sub) + '</div></div>';
  }

  async function load() {
    const r = await fetch("/admin/spend/data" + (currentMonth ? "?month=" + encodeURIComponent(currentMonth) : ""));
    const data = await r.json();
    const sel = el("month");
    if (!sel.options.length) {
      const opts = ['<option value="">All time</option>'].concat(
        (data.months || []).map((m) => '<option value="' + m + '">' + m + '</option>')
      );
      sel.innerHTML = opts.join("");
      // Default to the current month when there is data for it.
      const now = new Date().toISOString().slice(0, 7);
      if ((data.months || []).includes(now)) {
        sel.value = now;
        currentMonth = now;
        return load();
      }
    }
    render(data);
  }

  el("month").addEventListener("change", (e) => { currentMonth = e.target.value; load(); });
  el("refresh").addEventListener("click", load);
  load();
  setInterval(load, 30000);
</script>
</body>
</html>`;
}
