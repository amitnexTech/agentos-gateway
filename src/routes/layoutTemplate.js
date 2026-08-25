// Shared layout template for all admin pages with left sidebar navigation
export function renderLayout(content, currentPage) {
  const nav = [
    { id: 'dashboard', label: 'Dashboard', icon: '◆', path: '/admin' },
    { id: 'routing', label: 'Routing', icon: '⚙', path: '/admin/routing-panel' },
    { id: 'providers', label: 'Providers', icon: '🔌', path: '/admin/providers-panel' },
    { id: 'logs', label: 'Logs', icon: '📋', path: '/admin/logs' },
    { id: 'spend', label: 'Spend', icon: '💰', path: '/admin/spend' },
    { id: 'kiro', label: 'Kiro', icon: '⚡', path: '/admin/kiro' },
  ];

  const navHtml = nav.map(item => `
    <a href="${item.path}" class="nav-item ${item.id === currentPage ? 'active' : ''}">
      <span class="nav-icon">${item.icon}</span>
      <span class="nav-label">${item.label}</span>
    </a>
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentOS Gateway</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4; --ink: #18211f; --muted: #66716b; --panel: #ffffff;
      --line: #d8dfd8; --field: #fbfcfa; --accent: #0d6f63; --warn: #9b4a10;
      --bad: #a73737; --active-bg: #e5f3ef; --active-border: #0d6f63;
      --shadow: 0 2px 8px rgba(33, 45, 41, 0.1);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); display: flex; }

    /* Sidebar */
    .sidebar {
      width: 220px; background: var(--panel); border-right: 1px solid var(--line);
      padding: 20px 0; position: fixed; left: 0; top: 0; bottom: 0;
      overflow-y: auto; box-shadow: var(--shadow);
    }
    .sidebar-header { padding: 0 16px 16px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
    .sidebar-title { font-size: 13px; font-weight: 700; text-transform: uppercase; color: var(--muted); letter-spacing: .04em; margin: 0; }
    .nav-item {
      display: flex; align-items: center; gap: 12px; padding: 12px 16px;
      color: var(--muted); text-decoration: none; font-size: 13px;
      border-left: 3px solid transparent; transition: all 200ms;
    }
    .nav-item:hover { color: var(--accent); background: var(--field); }
    .nav-item.active { background: var(--active-bg); border-left-color: var(--accent); color: var(--accent); font-weight: 600; }
    .nav-icon { font-size: 16px; min-width: 20px; }
    .nav-label { flex: 1; }

    /* Main content */
    .main-wrapper { margin-left: 220px; flex: 1; display: flex; flex-direction: column; }
    .header {
      background: var(--panel); border-bottom: 1px solid var(--line);
      padding: 16px 24px; display: flex; align-items: center; justify-content: space-between;
      box-shadow: var(--shadow);
    }
    .header h1 { margin: 0; font-size: 20px; }
    .header-actions { display: flex; gap: 8px; align-items: center; }

    .content { flex: 1; overflow-y: auto; padding: 24px; }

    /* Common styles */
    button, input, select, textarea { font: inherit; }
    button {
      border: 1px solid var(--line); background: var(--panel); color: var(--ink);
      border-radius: 7px; min-height: 36px; padding: 0 12px; cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.danger { color: var(--bad); }

    .pill {
      display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 10px;
      border: 1px solid var(--line); border-radius: 999px; background: var(--panel);
      color: var(--muted); font-size: 12px; white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--warn); }
    .dot.ok { background: var(--accent); }

    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 16px; box-shadow: var(--shadow); }
    .section-head { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding: 14px 16px; }
    .section-head h2 { margin: 0; font-size: 14px; }
    .section-body { padding: 16px; }

    .stack { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
    input, select { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--field); color: var(--ink); min-height: 38px; padding: 0 10px; }
    textarea { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--field); color: var(--ink); min-height: 96px; resize: vertical; padding: 10px; line-height: 1.45; }

    .mono { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; }
    .subline { color: var(--muted); font-size: 13px; }
    .empty { color: var(--muted); padding: 30px; text-align: center; font-size: 14px; }
    .notice { font-size: 13px; color: var(--muted); }
    .notice.ok { color: var(--accent); }
    .notice.bad { color: var(--bad); }
    .status {
      display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px;
      border-radius: 999px; background: #eef2ed; color: var(--muted); font-size: 12px;
    }
    .status.ok { background: var(--active-bg); color: var(--accent); }
    .status.error { background: #f7e9e7; color: var(--bad); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 8px 10px; font-size: 13px; vertical-align: top; }
    th { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }

    /* Responsive */
    @media (max-width: 768px) {
      .sidebar { width: 180px; }
      .main-wrapper { margin-left: 180px; }
      .content { padding: 16px; }
    }
    @media (max-width: 640px) {
      .sidebar { width: 60px; }
      .nav-label { display: none; }
      .sidebar-title { display: none; }
      .main-wrapper { margin-left: 60px; }
      .content { padding: 12px; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h2 class="sidebar-title">Gateway</h2>
    </div>
    ${navHtml}
  </aside>

  <div class="main-wrapper">
    <header class="header">
      <h1>AgentOS Gateway</h1>
      <div class="header-actions">
        <span class="pill"><span id="healthDot" class="dot"></span><span id="healthText">Checking</span></span>
        <button id="refreshBtn" type="button">Refresh</button>
      </div>
    </header>

    <main class="content">
      ${content}
    </main>
  </div>

  <script>
    // Wrapped in an IIFE on purpose. Separate classic <script> blocks share ONE
    // global lexical scope, so a top-level "const el" here and another in the
    // page's own script is a redeclaration SyntaxError that silently kills a
    // whole block — that is how the Kiro page lost its Add-account button.
    (function () {
      const byId = (id) => document.getElementById(id);
      const dot = byId("healthDot");
      const text = byId("healthText");
      async function checkHealth() {
        try {
          const r = await fetch("/admin/health");
          if (!r.ok) throw new Error(String(r.status));
          await r.json();
          dot.className = "dot ok";
          text.textContent = "Healthy";
        } catch (e) {
          dot.className = "dot";
          text.textContent = "Down";
        }
      }
      byId("refreshBtn").addEventListener("click", () => window.location.reload());
      checkHealth();
      setInterval(checkHealth, 10000);
    })();
  </script>
</body>
</html>`;
}
