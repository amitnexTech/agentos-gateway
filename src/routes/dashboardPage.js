import { renderLayout } from './layoutTemplate.js';

export function renderDashboardPage() {
  const content = `
    <section>
      <div class="section-head">
        <h2>Gateway Overview</h2>
      </div>
      <div class="section-body">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px;">
          <div style="background: var(--field); border-radius: 8px; padding: 16px; border: 1px solid var(--line);">
            <div class="subline" style="margin-bottom: 8px;">Uptime</div>
            <div style="font-size: 24px; font-weight: 600; font-family: monospace;" id="uptimeText">—</div>
          </div>
          <div style="background: var(--field); border-radius: 8px; padding: 16px; border: 1px solid var(--line);">
            <div class="subline" style="margin-bottom: 8px;">Request Log</div>
            <div style="font-size: 24px; font-weight: 600; font-family: monospace;" id="logCountText">—</div>
          </div>
          <div style="background: var(--field); border-radius: 8px; padding: 16px; border: 1px solid var(--line);">
            <div class="subline" style="margin-bottom: 8px;">Today's Tokens</div>
            <div style="font-size: 24px; font-weight: 600; font-family: monospace;" id="tokenCountText">—</div>
          </div>
          <div style="background: var(--field); border-radius: 8px; padding: 16px; border: 1px solid var(--line);">
            <div class="subline" style="margin-bottom: 8px;">Today's Cost</div>
            <div style="font-size: 24px; font-weight: 600; font-family: monospace;" id="costText">—</div>
          </div>
        </div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Quick Links</h2>
      </div>
      <div class="section-body">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px;">
          <a href="/admin/routing-panel" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; background: var(--field); border-radius: 8px; border: 1px solid var(--line); text-decoration: none; color: var(--accent); font-weight: 600; transition: all 200ms;" onmouseover="this.style.background='var(--active-bg)'" onmouseout="this.style.background='var(--field)'">
            <span>⚙</span> Routing
          </a>
          <a href="/admin/providers-panel" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; background: var(--field); border-radius: 8px; border: 1px solid var(--line); text-decoration: none; color: var(--accent); font-weight: 600; transition: all 200ms;" onmouseover="this.style.background='var(--active-bg)'" onmouseout="this.style.background='var(--field)'">
            <span>🔌</span> Providers
          </a>
          <a href="/admin/logs" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; background: var(--field); border-radius: 8px; border: 1px solid var(--line); text-decoration: none; color: var(--accent); font-weight: 600; transition: all 200ms;" onmouseover="this.style.background='var(--active-bg)'" onmouseout="this.style.background='var(--field)'">
            <span>📋</span> Logs
          </a>
          <a href="/admin/spend" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; background: var(--field); border-radius: 8px; border: 1px solid var(--line); text-decoration: none; color: var(--accent); font-weight: 600; transition: all 200ms;" onmouseover="this.style.background='var(--active-bg)'" onmouseout="this.style.background='var(--field)'">
            <span>💰</span> Spend
          </a>
          <a href="/admin/kiro" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; background: var(--field); border-radius: 8px; border: 1px solid var(--line); text-decoration: none; color: var(--accent); font-weight: 600; transition: all 200ms;" onmouseover="this.style.background='var(--active-bg)'" onmouseout="this.style.background='var(--field)'">
            <span>⚡</span> Kiro
          </a>
          <a href="/admin/guide" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; background: var(--field); border-radius: 8px; border: 1px solid var(--line); text-decoration: none; color: var(--accent); font-weight: 600; transition: all 200ms;" onmouseover="this.style.background='var(--active-bg)'" onmouseout="this.style.background='var(--field)'">
            <span>?</span> Setup guide
          </a>
        </div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>System Info</h2>
      </div>
      <div class="section-body">
        <div style="display: grid; gap: 8px;">
          <div style="display: grid; grid-template-columns: 150px 1fr; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--line);">
            <span class="subline" style="font-weight: 600;">Gateway Version</span>
            <span class="mono">0.1.0</span>
          </div>
          <div style="display: grid; grid-template-columns: 150px 1fr; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--line);">
            <span class="subline" style="font-weight: 600;">Server</span>
            <span class="mono">localhost:9000</span>
          </div>
          <div style="display: grid; grid-template-columns: 150px 1fr; gap: 8px;">
            <span class="subline" style="font-weight: 600;">Data Directory</span>
            <span class="mono">data/</span>
          </div>
        </div>
      </div>
    </section>

    <script>
      // IIFE: separate classic <script> blocks share one global lexical scope,
      // so a top-level const here that also exists in the layout shell is a
      // redeclaration SyntaxError that kills the whole block silently.
      (function () {
      const el = (id) => document.getElementById(id);

      async function loadStats() {
        try {
          const r = await fetch('/admin/health');
          const health = await r.json();
          const uptime = Math.floor(health.uptime);
          const hours = Math.floor(uptime / 3600);
          const mins = Math.floor((uptime % 3600) / 60);
          el('uptimeText').textContent = hours + 'h ' + mins + 'm';

          const logs = await fetch('/admin/logs/data?limit=1').then(r => r.json());
          el('logCountText').textContent = logs.length + ' entries';

          const today = new Date().toISOString().slice(0, 10);
          const spend = await fetch('/admin/spend/data?month=' + today.slice(0, 7)).then(r => r.json());

          let todayTokens = 0, todayCost = 0;
          for (const day of Object.values(spend.byDay || {})) {
            if (day.day && day.day.startsWith(today)) {
              todayTokens += day.totalTokens || 0;
              todayCost += day.cost || 0;
            }
          }
          el('tokenCountText').textContent = todayTokens.toLocaleString();
          el('costText').textContent = '$' + todayCost.toFixed(2);
        } catch (e) {
          console.error('Failed to load stats:', e);
        }
      }

      loadStats();
      setInterval(loadStats, 30000);
      })();
    </script>
  `;

  return renderLayout(content, 'dashboard');
}
