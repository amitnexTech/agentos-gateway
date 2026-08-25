import { renderLayout } from './layoutTemplate.js';

export function renderLogsPage() {
  const content = `
    <section>
      <div class="section-head">
        <h2>Request Logs</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="pill" id="countPill">0 entries</span>
          <span class="pill" id="costPill">$0.00</span>
          <span class="pill" id="creditsPill">0 cr</span>
          <span class="pill" id="tokenPill">0 tokens</span>
        </div>
      </div>
      <div class="section-body">
        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
          <select id="filterTool" style="flex:1;max-width:180px">
            <option value="">All tools</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="openai">OpenAI</option>
          </select>
          <button id="refreshBtn">Refresh</button>
          <button id="clearBtn" class="danger">Clear logs</button>
          <a href="/admin/spend" class="pill" style="text-decoration:none;cursor:pointer">Spend analytics →</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Tool</th>
                <th>Model (req → resp)</th>
                <th>Provider</th>
                <th title="~X means estimated">Tokens</th>
                <th>Context</th>
                <th>Cost</th>
                <th>Kiro Cr</th>
                <th>Latency</th>
                <th>tok/s</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody id="logBody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <script>
      // IIFE: separate classic <script> blocks share one global lexical scope,
      // so a top-level const here that also exists in the layout shell is a
      // redeclaration SyntaxError that kills the whole block silently.
      (function () {
      const el = (id) => document.getElementById(id);

      function escapeHtml(v) { return String(v||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }

      function formatTime(iso) {
        const d = new Date(iso);
        const clock = d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3,"0");
        const isToday = d.toDateString() === new Date().toDateString();
        if (isToday) return clock;
        const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
        return '<span style="color:var(--muted)">'+date+'</span> '+clock;
      }

      function latencyClass(ms) {
        if (ms < 2000) return "fast";
        if (ms < 8000) return "slow";
        return "very-slow";
      }

      function contextCell(l) {
        const pct = l.contextUsagePercent;
        const hist = l.historyEntries;
        if (pct == null && hist == null) return '<span style="color:var(--muted)">—</span>';

        let out = "";
        if (pct != null) {
          const cls = pct >= 80 ? "ctx-high" : pct >= 50 ? "ctx-mid" : "ctx-low";
          out += '<div style="width:54px;height:5px;border-radius:3px;background:var(--line);overflow:hidden;margin-bottom:2px">' +
                   '<div style="height:100%;border-radius:3px;background:var(--' + cls + ');width:' + Math.min(pct, 100).toFixed(1) + '%"></div>' +
                 '</div>' +
                 '<span class="mono" style="font-size:11px;color:var(--' + cls + ')">' + pct.toFixed(1) + '%</span>';
        }
        if (hist != null) {
          const kb = l.payloadChars != null ? " · " + Math.round(l.payloadChars / 1024) + "KB" : "";
          out += '<div class="mono" style="color:var(--muted);font-size:11px">' + hist + ' turns' + kb + '</div>';
        }
        return out;
      }

      function formatLatency(ms) {
        if (ms < 1000) return ms + "ms";
        return (ms / 1000).toFixed(1) + "s";
      }

      async function loadLogs() {
        const tool = el("filterTool").value;
        const url = "/admin/logs/data?limit=200" + (tool ? "&tool="+tool : "");
        try {
          const logs = await fetch(url).then(r => r.json());
          el("countPill").textContent = logs.length + " entries";
          const totalCost = logs.reduce((s,l) => s + (l.cost||0), 0);
          const totalTokens = logs.reduce((s,l) => s + (l.usage?.input_tokens||0) + (l.usage?.output_tokens||0), 0);
          const totalCredits = logs.reduce((s,l) => s + (l.kiroCredits||0), 0);
          el("costPill").textContent = "$" + totalCost.toFixed(3);
          el("creditsPill").textContent = totalCredits.toFixed(4) + " cr";
          el("tokenPill").textContent = totalTokens.toLocaleString() + " tokens";

          if (!logs.length) {
            el("logBody").innerHTML = '<tr><td colspan="12"><div class="empty">No requests logged yet.</div></td></tr>';
            return;
          }

          el("logBody").innerHTML = logs.map(l => {
            const est = l.usageEstimated ? '~' : '';
            const modelCell = (l.responseModel
              ? (l.modelMismatch
                ? '<span class="mono">'+escapeHtml(l.model)+'</span> → <span class="badge error">'+escapeHtml(l.responseModel)+' ⚠</span>'
                : '<span class="mono">'+escapeHtml(l.model)+'</span> → <span class="badge ok">'+escapeHtml(l.responseModel)+'</span>')
              : '<span class="mono">'+escapeHtml(l.model)+'</span>');
            const tokenCell = l.usage
              ? '<span class="mono">'+est+l.usage.input_tokens+'↓ '+est+l.usage.output_tokens+'↑'+(l.usage.cache_read?' C:'+l.usage.cache_read+'r':'')+'</span>'
              : '<span style="color:var(--muted)">—</span>';
            const costCell = l.cost !== null
              ? '<span class="mono">'+est+'$'+l.cost.toFixed(4)+'</span>'
              : '<span style="color:var(--muted)">—</span>';
            const creditsCell = l.kiroCredits ? '<span class="mono">'+l.kiroCredits.toFixed(4)+' cr</span>' : '';
            const tpsCell = l.tps != null ? '<span class="mono">'+est+l.tps.toFixed(1)+'</span>' : '<span style="color:var(--muted)">—</span>';

            return '<tr>' +
              '<td class="mono" title="'+escapeHtml(l.ts)+'">'+formatTime(l.ts)+'</td>' +
              '<td><span class="badge '+escapeHtml(l.tool)+'">'+escapeHtml(l.tool)+'</span></td>' +
              '<td>'+modelCell+'</td>' +
              '<td>'+escapeHtml(l.providerName)+(l.fallback?' <span class="badge">fallback</span>':'')+'</td>' +
              '<td>'+tokenCell+'</td>' +
              '<td>'+contextCell(l)+'</td>' +
              '<td>'+costCell+'</td>' +
              '<td>'+creditsCell+'</td>' +
              '<td><span class="latency '+latencyClass(l.latencyMs)+'">'+formatLatency(l.latencyMs)+'</span></td>' +
              '<td>'+tpsCell+'</td>' +
              '<td><span class="badge '+escapeHtml(l.status)+'">'+escapeHtml(l.status)+'</span></td>' +
              '<td style="font-size:12px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escapeHtml(l.error||"")+'">'+escapeHtml(l.error||"—")+'</td>' +
            '</tr>';
          }).join("");
        } catch(e) {
          el("logBody").innerHTML = '<tr><td colspan="12"><div class="empty">Failed to load: '+escapeHtml(e.message)+'</div></td></tr>';
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
      setInterval(loadLogs, 5000);
      })();
    </script>

    <style>
      .latency.fast { color: var(--accent); }
      .latency.slow { color: var(--warn); }
      .latency.very-slow { color: var(--bad); }
      .badge { display:inline-block;min-height:22px;padding:0 7px;border-radius:999px;font-size:11px;line-height:22px; }
      .badge.ok { background:#e5f3ef; color:var(--accent); }
      .badge.error { background:#f7e9e7; color:var(--bad); }
      .badge.claude { background:#f0e8ff; color:#6b21a8; }
      .badge.codex { background:#e8f4ff; color:#1d4ed8; }
      .badge.openai { background:#fef3e2; color:#92400e; }
      .ctx-low { background:var(--accent); color:var(--accent); }
      .ctx-mid { background:var(--warn); color:var(--warn); }
      .ctx-high { background:var(--bad); color:var(--bad); }
    </style>
  `;

  return renderLayout(content, 'logs');
}
