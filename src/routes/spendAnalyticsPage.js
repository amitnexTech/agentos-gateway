import { renderLayout } from './layoutTemplate.js';

export function renderSpendAnalyticsPage() {
  const content = `
    <section>
      <div class="section-head">
        <h2>Spending Analytics</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="month" style="max-width:180px"></select>
          <button id="refresh">Refresh</button>
        </div>
      </div>
      <div class="section-body">
        <div id="body"><div class="empty">Loading…</div></div>
      </div>
    </section>

    <script>
      // IIFE: separate classic <script> blocks share one global lexical scope,
      // so a top-level const here that also exists in the layout shell is a
      // redeclaration SyntaxError that kills the whole block silently.
      (function () {
      const el = (id) => document.getElementById(id);
      const fmt = (n) => (n || 0).toLocaleString();
      const money = (n) => "$" + (n || 0).toFixed(n && n < 1 ? 4 : 2);
      const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
      let currentMonth = "";

      function tokensCell(b) {
        const est = b.estimatedRequests > 0 ? '<span style="color:var(--warn)" title="' + b.estimatedRequests + ' of ' + b.requests + ' requests are estimated">~</span>' : "";
        return est + fmt(b.totalTokens);
      }

      function costCell(b) {
        if (!b.costedRequests) return '<span style="color:var(--muted)" title="No known price">—</span>';
        const partial = b.costedRequests < b.requests
          ? '<span style="color:var(--muted)" title="' + b.costedRequests + ' of ' + b.requests + ' priced"> *</span>'
          : "";
        return money(b.cost) + partial;
      }

      function card(label, value, sub) {
        return '<div class="card"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + esc(sub) + '</div></div>';
      }

      function breakdown(title, groups, opts) {
        const rows = Object.entries(groups).sort((a, b) => (b[1][opts.sortBy] || 0) - (a[1][opts.sortBy] || 0));
        if (!rows.length) return "";
        const max = rows[0][1][opts.sortBy] || 1;
        return '<div class="panel"><h3 style="margin:0 0 12px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">' + title + '</h3><table><thead><tr>' +
          '<th>' + opts.keyLabel + '</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Cost</th>' +
          (opts.showCredits ? '<th class="num" title="Kiro credits">Credits</th>' : "") +
          '</tr></thead><tbody>' +
          rows.map(([name, b]) =>
            '<tr><td>' + esc(name) +
            '<div style="width:100%;height:4px;border-radius:2px;background:var(--accent);opacity:.35;margin-top:3px;width:' + Math.max(2, Math.round(((b[opts.sortBy] || 0) / max) * 100)) + '%"></div></td>' +
            '<td class="num">' + fmt(b.requests) + (b.errors ? ' <span style="color:var(--bad)">(' + b.errors + ' err)</span>' : "") + '</td>' +
            '<td class="num">' + tokensCell(b) + '</td>' +
            '<td class="num">' + costCell(b) + '</td>' +
            (opts.showCredits ? '<td class="num">' + (b.credits ? b.credits.toFixed(3) : "—") + '</td>' : "") +
            '</tr>').join("") +
          '</tbody></table></div>';
      }

      function render(data) {
        if (!data.totals.requests) {
          el("body").innerHTML = '<div class="empty">Nothing recorded yet for this period.</div>';
          return;
        }
        const t = data.totals;
        const days = Object.keys(data.byDay).length || 1;
        el("body").innerHTML =
          '<div class="cards">' +
            card("Requests", fmt(t.requests), t.errors ? t.errors + " errors" : "no errors") +
            card("Tokens", tokensCell(t), fmt(t.inputTokens) + " in / " + fmt(t.outputTokens) + " out") +
            card("Cost", costCell(t), t.costedRequests < t.requests ? t.costedRequests + " of " + t.requests + " priced" : "all priced") +
            card("Kiro credits", t.credits ? t.credits.toFixed(3) : "—", "real spend on Kiro") +
            card("Per day avg", fmt(Math.round(t.totalTokens / days)), "across " + days + " active day(s)") +
          '</div>' +
          '<div class="panels">' +
            breakdown("By project", data.byProject, { keyLabel: "Project", sortBy: "totalTokens" }) +
            breakdown("By provider", data.byProvider, { keyLabel: "Provider", sortBy: "totalTokens", showCredits: true }) +
            breakdown("By model", data.byModel, { keyLabel: "Model", sortBy: "totalTokens", showCredits: true }) +
            breakdown("By session profile", data.byProfile, { keyLabel: "Profile", sortBy: "totalTokens", showCredits: true }) +
            breakdown("By tool", data.byTool, { keyLabel: "Tool", sortBy: "totalTokens" }) +
            breakdown("By day", data.byDay, { keyLabel: "Day", sortBy: "requests" }) +
          '</div>';
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
      })();
    </script>

    <style>
      .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:20px; }
      .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
      .card .label { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
      .card .value { font-size:22px; font-weight:600; margin-top:4px; font-family:"SFMono-Regular",Consolas,monospace; }
      .card .sub { font-size:11px; color:var(--muted); margin-top:2px; }
      .panels { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:16px; }
      .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
      .panel table { width:100%; border-collapse:collapse; }
      .panel th, .panel td { text-align:left; border-bottom:1px solid var(--line); padding:6px 8px; font-size:13px; }
      .panel th { font-size:11px; font-weight:700; text-transform:uppercase; color:var(--muted); }
      .panel td.num, .panel th.num { text-align:right; font-family:"SFMono-Regular",Consolas,monospace; font-size:12px; }
      .panel tr:last-child td { border-bottom:none; }
    </style>
  `;

  return renderLayout(content, 'spend');
}
