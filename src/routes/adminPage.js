export function renderAdminPage() {
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
      --shadow: 0 18px 45px rgba(33, 45, 41, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); }
    button, input, select, textarea { font: inherit; }
    button {
      border: 1px solid var(--line); background: var(--panel); color: var(--ink);
      border-radius: 7px; min-height: 36px; padding: 0 12px; cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.danger { color: var(--bad); }
    button.active-btn { background: var(--accent); color: #fff; border-color: var(--accent); }
    .shell { width: min(1320px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 36px; }
    header {
      display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center;
      border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 18px;
    }
    h1 { margin: 0; font-size: 24px; }
    .subline { margin-top: 4px; color: var(--muted); font-size: 13px; }
    .header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .pill {
      display: inline-flex; align-items: center; gap: 7px; min-height: 30px; padding: 0 10px;
      border: 1px solid var(--line); border-radius: 999px; background: var(--panel);
      color: var(--muted); font-size: 12px; white-space: nowrap; text-decoration: none;
    }
    .pill.active-pill { background: var(--active-bg); border-color: var(--active-border); color: var(--accent); font-weight: 600; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--warn); }
    .dot.ok { background: var(--accent); }
    .grid { display: grid; grid-template-columns: 390px 1fr; gap: 16px; align-items: start; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    .panel-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      border-bottom: 1px solid var(--line); padding: 14px 16px;
    }
    h2 { margin: 0; font-size: 14px; }
    .panel-body { padding: 16px; }
    .stack { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
    input, select { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--field); color: var(--ink); min-height: 38px; padding: 0 10px; }
    textarea { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--field); color: var(--ink); min-height: 96px; resize: vertical; padding: 10px; line-height: 1.45; }
    .preset-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .preset-grid button { min-height: 42px; padding: 0 8px; font-size: 12px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 700px; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 10px 12px; vertical-align: middle; font-size: 13px; }
    th { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
    tr.active-row { background: var(--active-bg); }
    .mono { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; }
    .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .status {
      display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px;
      border-radius: 999px; background: #eef2ed; color: var(--muted); font-size: 12px;
    }
    .status.ok { background: #e5f3ef; color: var(--accent); }
    .status.error { background: #f7e9e7; color: var(--bad); }
    .status.active { background: var(--accent); color: #fff; font-weight: 600; }
    .lower-grid { display: grid; grid-template-columns: 1fr 360px; gap: 16px; margin-top: 16px; }
    .right-stack { display: grid; gap: 16px; }
    .model-list { display: grid; gap: 8px; max-height: 300px; overflow: auto; }
    .model-item { display: grid; grid-template-columns: 18px 1fr; gap: 8px; align-items: center; min-height: 34px; border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; background: var(--field); }
    .model-item input { min-height: auto; width: 16px; }
    .empty { color: var(--muted); font-size: 13px; padding: 18px; border: 1px dashed var(--line); border-radius: 8px; background: var(--field); }
    .notice { min-height: 32px; color: var(--muted); font-size: 13px; }
    .notice.bad { color: var(--bad); }
    .notice.ok { color: var(--accent); }
    .stats { display: grid; gap: 8px; }
    .stat-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; border-bottom: 1px solid var(--line); padding: 8px 0; font-size: 13px; }
    .stat-row:last-child { border-bottom: 0; }
    .test-output { min-height: 120px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; border: 1px solid var(--line); border-radius: 7px; background: #f0f4f1; padding: 10px; }
    .test-output.bad { background: #fbefed; border-color: #edc4bd; color: var(--bad); }
    .test-result { margin-top: 6px; font-size: 12px; color: var(--muted); white-space: pre-wrap; word-break: break-word; max-width: 350px; }
    .test-result.ok { color: var(--accent); }
    .test-result.bad { color: var(--bad); }
    @media (max-width: 980px) { .grid, .lower-grid { grid-template-columns: 1fr; } header { grid-template-columns: 1fr; } }
    @media (max-width: 560px) { .shell { width: min(100vw - 20px, 1320px); padding-top: 14px; } .preset-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>AgentOS Gateway</h1>
        <div class="subline">localhost:9000 &mdash; per-tool routing: each agent uses its own provider</div>
      </div>
      <div class="header-actions">
        <span class="pill"><span id="healthDot" class="dot"></span><span id="healthText">Checking</span></span>
        <button id="refreshBtn" type="button">Refresh</button>
        <a class="pill" href="/admin/logs">Logs</a>
      </div>
    </header>

    <!-- Routing Panel -->
    <section style="margin-bottom:16px">
      <div class="panel-head"><h2>Routing</h2><button id="useAllBtn" type="button" disabled>Use for all</button></div>
      <div class="panel-body" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px" id="routingPanel">
        <label>Claude Code (/v1/messages)<select id="route-claude"></select></label>
        <label>Codex (/v1/responses)<select id="route-codex"></select></label>
        <label>OpenAI (/v1/chat/completions)<select id="route-openai"></select></label>
      </div>
    </section>

    <div class="grid">
      <section>
        <div class="panel-head">
          <h2>Add provider</h2>
          <span class="pill" id="providerMode">remote</span>
        </div>
        <div class="panel-body">
          <form id="providerForm" class="stack">
            <label>Name<input id="name" name="name" autocomplete="off" placeholder="OpenRouter, Requesty, Anthropic..."></label>
            <label>Type
              <select id="type" name="type">
                <option value="openai-compat">openai-compat (OpenAI Chat API)</option>
                <option value="anthropic-compat">anthropic-compat (Anthropic Messages API)</option>
                <option value="local-openai">local-openai (no auth needed)</option>
              </select>
            </label>
            <label>Base URL<input id="baseUrl" name="baseUrl" autocomplete="off" placeholder="https://openrouter.ai/api/v1"></label>
            <label id="apiKeyWrap">API key<input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-..."></label>
            <div class="preset-grid">
              <button type="button" data-preset="openrouter">OpenRouter</button>
              <button type="button" data-preset="requesty">Requesty</button>
              <button type="button" data-preset="groq">Groq</button>
              <button type="button" data-preset="together">Together</button>
              <button type="button" data-preset="ollama">Ollama</button>
              <button type="button" data-preset="anthropic">Anthropic</button>
            </div>
            <button class="primary" type="submit">Add provider</button>
            <div id="notice" class="notice"></div>
          </form>
        </div>
      </section>

      <section>
        <div class="panel-head">
          <h2>Providers</h2>
          <span class="pill" id="providerCount">0 providers</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Models</th><th>Used by</th><th>Actions</th></tr></thead>
            <tbody id="providersBody"></tbody>
          </table>
        </div>
      </section>
    </div>

    <div class="lower-grid">
      <section>
        <div class="panel-head">
          <h2 id="modelsTitle">Models</h2>
          <button id="saveModelsBtn" type="button" disabled>Save models</button>
        </div>
        <div class="panel-body">
          <div id="modelList" class="model-list">
            <div class="empty">Fetch models from a provider, then select which ones to configure.</div>
          </div>
        </div>
      </section>

      <div class="right-stack">
        <section>
          <div class="panel-head"><h2>Active Models</h2><span class="pill" id="enabledCount">0 models</span></div>
          <div class="panel-body">
            <div id="stats" class="stats"><div class="empty">Activate a provider to see its models here.</div></div>
          </div>
        </section>

        <section>
          <div class="panel-head"><h2>Test Provider</h2><button id="runTestBtn" type="button">Run</button></div>
          <div class="panel-body stack">
            <label>Provider<select id="testProvider"></select></label>
            <label>Model<select id="testModel"></select></label>
            <label>Prompt<textarea id="testPrompt">Reply with only: ok</textarea></label>
            <pre id="testOutput" class="test-output">Select a provider and model to test.</pre>
          </div>
        </section>
      </div>
    </div>

    <!-- Kiro Account Management -->
    <section style="margin-top:16px">
      <div class="panel-head">
        <h2>Kiro Accounts</h2>
        <button id="kiroAddBtn" class="primary" type="button">+ Add Kiro Account</button>
      </div>
      <div class="panel-body stack">
        <div id="kiroStatus" style="color:var(--muted);font-size:13px"></div>
        <form id="kiroAddForm" style="display:none" class="stack">
          <label>API Key
            <input type="password" id="kiroKey" placeholder="ksk_..." autocomplete="off" required>
          </label>
          <div style="color:var(--muted);font-size:12px;margin-top:-4px">
            Generate at app.kiro.dev &rarr; Account &rarr; API Keys. Requires Pro/Pro+/Power with API keys enabled by your admin.
          </div>
          <label>Account Name <span style="color:var(--muted);font-weight:400">(optional)</span>
            <input type="text" id="kiroName" placeholder="e.g. Work Pro+">
          </label>
          <label>Credit Budget <span style="color:var(--muted);font-weight:400">(optional, for usage tracking)</span>
            <input type="number" id="kiroBudget" placeholder="e.g. 1000" step="any" min="0">
          </label>
          <div style="display:flex;gap:8px">
            <button type="submit" class="primary">Add Account</button>
            <button type="button" id="kiroCancelBtn">Cancel</button>
          </div>
        </form>
        <div id="kiroAccountsList"></div>
      </div>
    </section>
  </main>

  <script>
    const state = { providers: [], selectedProvider: null, fetchedModels: [], activeModels: [], stats: {}, routing: {} };
    const el = (id) => document.getElementById(id);
    function setNotice(msg, kind="") { const n=el("notice"); n.className="notice "+kind; n.textContent=msg; }
    function escapeHtml(v) { return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }

    async function api(path, opts={}) {
      const r = await fetch(path, { headers:{"Content-Type":"application/json",...(opts.headers||{})}, ...opts });
      if (r.status===204) return null;
      const body = await r.json().catch(()=>({}));
      if (!r.ok) throw new Error(body.error?.message||"Request failed");
      return body;
    }

    function updateTypeMode() {
      const t=el("type").value; const noKey=t==="local-openai";
      el("apiKeyWrap").style.display=noKey?"none":"grid"; el("apiKey").required=!noKey;
      el("providerMode").textContent=noKey?"local":"remote";
    }

    function applyPreset(name) {
      const presets = {
        openrouter:{name:"OpenRouter",type:"openai-compat",baseUrl:"https://openrouter.ai/api/v1"},
        requesty:{name:"Requesty",type:"openai-compat",baseUrl:"https://router.requesty.ai/v1"},
        groq:{name:"Groq",type:"openai-compat",baseUrl:"https://api.groq.com/openai/v1"},
        together:{name:"Together AI",type:"openai-compat",baseUrl:"https://api.together.xyz/v1"},
        ollama:{name:"Ollama Local",type:"local-openai",baseUrl:"http://localhost:11434/v1"},
        anthropic:{name:"Anthropic Direct",type:"anthropic-compat",baseUrl:"https://api.anthropic.com/v1"},
      };
      const p=presets[name]; if(!p) return;
      el("type").value=p.type; el("name").value=p.name; el("baseUrl").value=p.baseUrl; updateTypeMode();
    }

    function renderRouting() {
      const tools = ["claude","codex","openai"];
      for (const tool of tools) {
        const sel = el("route-"+tool);
        const current = state.routing[tool]?.id || "";
        sel.innerHTML = '<option value="">(none)</option>' +
          state.providers.map(p => '<option value="'+escapeHtml(p.id)+'"'+(p.id===current?' selected':'')+'>'+escapeHtml(p.name)+' ('+p.models.length+' models)</option>').join("");
      }
      el("useAllBtn").disabled = !state.providers.length;
    }

    function renderProviders() {
      const body=el("providersBody");
      el("providerCount").textContent=state.providers.length+" providers";
      if (!state.providers.length) { body.innerHTML='<tr><td colspan="5"><div class="empty">No providers configured.</div></td></tr>'; return; }
      body.innerHTML = state.providers.map(p => {
        const tools = p.assignedTools || [];
        const toolBadges = tools.length ? tools.map(t=>'<span class="status active">'+t+'</span>').join(" ") : '<span class="status">unused</span>';
        const disabled = p.enabled === false;
        const rowStyle = disabled ? ' style="opacity:0.45"' : '';
        const statusBadge = disabled ? '<span class="status error">disabled</span>' : '<span class="status ok">enabled</span>';
        return '<tr'+rowStyle+'>' +
          '<td><strong>'+escapeHtml(p.name)+'</strong> '+statusBadge+'<div class="mono">'+escapeHtml(p.id)+'</div></td>' +
          '<td><span class="status">'+escapeHtml(p.type)+'</span></td>' +
          '<td>'+(p.models?.length||0)+' models</td>' +
          '<td>'+toolBadges+'</td>' +
          '<td><div class="row-actions">'+
            '<button data-action="toggle" data-id="'+p.id+'">'+(disabled?"Enable":"Disable")+'</button>' +
            '<button data-action="fetch" data-id="'+p.id+'">Fetch</button>' +
            '<button data-action="manual" data-id="'+p.id+'">+Models</button>' +
            '<button data-action="edit" data-id="'+p.id+'">Edit</button>' +
            '<button data-action="test" data-id="'+p.id+'">Test</button>' +
            '<button class="danger" data-action="delete" data-id="'+p.id+'">Del</button>' +
          '</div><div class="test-result" id="test-'+p.id+'"></div></td></tr>';
      }).join("");
    }

    function renderActiveModels() {
      const s=el("stats");
      el("enabledCount").textContent=state.activeModels.length+" models";
      if (!state.activeModels.length) { s.innerHTML='<div class="empty">Assign providers to tools above to route requests.</div>'; return; }
      s.innerHTML = state.activeModels.map(m => '<div class="stat-row"><span class="mono">'+escapeHtml(m)+'</span><span></span></div>').join("");
    }

    function renderTestModels() {
      // Render provider dropdown
      const pSel=el("testProvider");
      const curP=pSel.value;
      pSel.innerHTML='<option value="">(select provider)</option>'+
        state.providers.map(p=>'<option value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+' ('+escapeHtml(p.type)+')</option>').join("");
      if (state.providers.find(p=>p.id===curP)) pSel.value=curP;
      updateTestModelsForProvider();
    }

    function updateTestModelsForProvider() {
      const sel=el("testModel"); const pId=el("testProvider").value;
      const provider=state.providers.find(p=>p.id===pId);
      if (!provider||!provider.models?.length) {
        sel.innerHTML='<option value="">No models</option>'; el("runTestBtn").disabled=true; return;
      }
      const cur=sel.value;
      sel.innerHTML=provider.models.map(m=>'<option value="'+escapeHtml(m)+'">'+escapeHtml(m)+'</option>').join("");
      if (provider.models.includes(cur)) sel.value=cur;
      el("runTestBtn").disabled=false;
    }

    async function refresh() {
      try {
        const [health, providers, activeModels, routing] = await Promise.all([
          api("/admin/health"), api("/admin/providers"), api("/admin/models"), api("/admin/routing"),
        ]);
        state.providers=providers; state.activeModels=activeModels; state.routing=routing;
        el("healthDot").className="dot ok"; el("healthText").textContent=health.status;
        renderRouting(); renderProviders(); renderModels(); renderActiveModels(); renderTestModels();
      } catch(e) { el("healthDot").className="dot"; el("healthText").textContent="offline"; setNotice(e.message,"bad"); }
    }

    function renderModels() {
      const ml=el("modelList");
      el("modelsTitle").textContent=state.selectedProvider?"Models / "+state.selectedProvider.name:"Models";
      el("saveModelsBtn").disabled=!state.selectedProvider||!state.fetchedModels.length;
      if (!state.fetchedModels.length) { ml.innerHTML='<div class="empty">Fetch models from a provider, then select which ones to configure.</div>'; return; }
      const configured = state.selectedProvider?.models || [];
      ml.innerHTML = state.fetchedModels.map(m => {
        const checked = configured.includes(m.id) ? "checked" : "";
        return '<label class="model-item"><input type="checkbox" value="'+escapeHtml(m.id)+'" '+checked+'><span class="mono">'+escapeHtml(m.id)+'</span></label>';
      }).join("");
    }

    async function addProviderSubmit(e) {
      e.preventDefault();
      const payload={name:el("name").value.trim(),type:el("type").value,baseUrl:el("baseUrl").value.trim()};
      if (payload.type!=="local-openai") payload.apiKey=el("apiKey").value;
      try {
        await api("/admin/providers",{method:"POST",body:JSON.stringify(payload)});
        e.target.reset(); el("type").value="openai-compat"; updateTypeMode();
        setNotice("Provider added. Fetch models and activate it.","ok"); await refresh();
      } catch(err) { setNotice(err.message,"bad"); }
    }

    async function providerAction(e) {
      const btn=e.target.closest("button[data-action]"); if(!btn) return;
      const provider=state.providers.find(p=>p.id===btn.dataset.id); if(!provider) return;
      try {
        if (btn.dataset.action==="toggle") {
          const newEnabled = provider.enabled === false;
          await api("/admin/providers/"+provider.id,{method:"PUT",body:JSON.stringify({enabled:newEnabled})});
          setNotice(provider.name+" "+(newEnabled?"enabled":"disabled")+".","ok"); await refresh();
        }
        if (btn.dataset.action==="fetch") {
          state.selectedProvider=provider;
          state.fetchedModels = await api("/admin/providers/"+provider.id+"/models");
          setNotice("Fetched "+state.fetchedModels.length+" models from "+provider.name+".","ok"); renderModels();
        }
        if (btn.dataset.action==="manual") {
          const input = prompt("Enter model IDs (comma-separated):\\ne.g.: claude-sonnet-4.5, claude-opus-4.5, claude-haiku-4.5");
          if (!input) return;
          const models = input.split(",").map(s=>s.trim()).filter(Boolean);
          if (!models.length) return;
          await api("/admin/providers/"+provider.id+"/models/add",{method:"POST",body:JSON.stringify({models})});
          setNotice("Added "+models.length+" models to "+provider.name+".","ok"); await refresh();
        }
        if (btn.dataset.action==="edit") {
          const name = prompt("Provider name:", provider.name);
          if (name===null) return;
          const baseUrl = prompt("Base URL:", provider.baseUrl);
          if (baseUrl===null) return;
          const apiKey = prompt("API key (leave empty to keep current):", "");
          const payload = {};
          if (name && name!==provider.name) payload.name=name;
          if (baseUrl && baseUrl!==provider.baseUrl) payload.baseUrl=baseUrl;
          if (apiKey) payload.apiKey=apiKey;
          if (Object.keys(payload).length) {
            await api("/admin/providers/"+provider.id,{method:"PUT",body:JSON.stringify(payload)});
            setNotice("Updated "+provider.name+".","ok"); await refresh();
          }
        }
        if (btn.dataset.action==="test") {
          const resultEl = document.getElementById("test-"+provider.id);
          if (resultEl) { resultEl.className="test-result"; resultEl.textContent="Testing..."; }
          const model = provider.models?.[0];
          if (!model) { if(resultEl) { resultEl.className="test-result bad"; resultEl.textContent="No models configured"; } return; }
          try {
            await api("/admin/providers/"+provider.id+"/test",{method:"POST",body:JSON.stringify({model})});
            if (resultEl) { resultEl.className="test-result ok"; resultEl.textContent="\u2714 PASS: "+model+" responded"; }
          } catch(err) {
            if (resultEl) { resultEl.className="test-result bad"; resultEl.textContent="\u2718 FAIL: "+err.message; }
          }
        }
        if (btn.dataset.action==="delete") {
          if (!confirm("Delete "+provider.name+"?")) return;
          await api("/admin/providers/"+provider.id,{method:"DELETE"});
          if (state.selectedProvider?.id===provider.id) { state.selectedProvider=null; state.fetchedModels=[]; }
          await refresh();
        }
      } catch(err) { setNotice(err.message,"bad"); }
    }

    async function routingChange(tool) {
      const sel=el("route-"+tool);
      const providerId=sel.value||null;
      try {
        await api("/admin/routing/"+tool,{method:"POST",body:JSON.stringify({providerId})});
        setNotice(tool+" → "+(providerId?state.providers.find(p=>p.id===providerId)?.name:"none"),"ok");
        await refresh();
      } catch(err) { setNotice(err.message,"bad"); await refresh(); }
    }

    async function useForAll() {
      const firstAssigned = el("route-claude").value || el("route-codex").value || el("route-openai").value;
      if (!firstAssigned && state.providers.length) {
        const pid = state.providers[0].id;
        await api("/admin/routing/all",{method:"POST",body:JSON.stringify({providerId:pid})});
      } else if (firstAssigned) {
        await api("/admin/routing/all",{method:"POST",body:JSON.stringify({providerId:firstAssigned})});
      }
      setNotice("All tools routed to same provider.","ok"); await refresh();
    }

    async function saveModels() {
      if (!state.selectedProvider) return;
      const checked=Array.from(el("modelList").querySelectorAll("input:checked")).map(i=>i.value);
      try {
        await api("/admin/providers/"+state.selectedProvider.id+"/models",{method:"POST",body:JSON.stringify({models:checked})});
        setNotice("Saved "+checked.length+" models for "+state.selectedProvider.name+".","ok"); await refresh();
      } catch(err) { setNotice(err.message,"bad"); }
    }

    async function runModelTest() {
      const out=el("testOutput"); const model=el("testModel").value; const pId=el("testProvider").value;
      const prompt=el("testPrompt").value.trim();
      if (!model||!pId) { out.className="test-output bad"; out.textContent="Select a provider and model."; return; }
      el("runTestBtn").disabled=true; out.className="test-output"; out.textContent="Testing "+model+" on provider...";
      try {
        const r=await api("/admin/providers/"+pId+"/test",{method:"POST",body:JSON.stringify({model})});
        out.textContent="PASS: "+model+" responded successfully.";
        await refresh();
      } catch(err) { out.className="test-output bad"; out.textContent=err.message; await refresh(); }
      finally { el("runTestBtn").disabled=false; }
    }

    el("type").addEventListener("change",updateTypeMode);
    el("providerForm").addEventListener("submit",addProviderSubmit);
    el("providersBody").addEventListener("click",providerAction);
    el("saveModelsBtn").addEventListener("click",saveModels);
    el("runTestBtn").addEventListener("click",runModelTest);
    el("refreshBtn").addEventListener("click",refresh);
    el("useAllBtn").addEventListener("click",useForAll);
    el("route-claude").addEventListener("change",()=>routingChange("claude"));
    el("route-codex").addEventListener("change",()=>routingChange("codex"));
    el("route-openai").addEventListener("change",()=>routingChange("openai"));
    el("testProvider").addEventListener("change",updateTestModelsForProvider);
    document.querySelectorAll("[data-preset]").forEach(b=>b.addEventListener("click",()=>applyPreset(b.dataset.preset)));
    updateTypeMode(); refresh();

    // --- Kiro Account Management ---
    function kiroShowForm(show) {
      el("kiroAddForm").style.display = show ? "block" : "none";
      el("kiroAddBtn").disabled = show;
      if (!show) { el("kiroKey").value = ""; el("kiroName").value = ""; el("kiroBudget").value = ""; }
    }

    async function kiroAddAccount(e) {
      e.preventDefault();
      const apiKey = el("kiroKey").value.trim();
      const name = el("kiroName").value.trim();
      const budget = parseFloat(el("kiroBudget").value);
      if (!apiKey) { el("kiroStatus").textContent = "API key is required."; return; }
      el("kiroStatus").textContent = "Validating key with Kiro...";
      try {
        const result = await api("/admin/kiro/account", {
          method: "POST",
          body: JSON.stringify({
            apiKey,
            name: name || undefined,
            creditBudget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
          }),
        });
        const p = result.provider;
        el("kiroStatus").textContent = "Added " + p.name + " — account " + (p.accountId || "?") + ", " + p.models.length + " models.";
        kiroShowForm(false);
        await refresh();
        await loadKiroAccounts();
      } catch(e) {
        el("kiroStatus").textContent = "Failed: " + e.message;
      }
    }

    let kiroAccounts = [];

    async function loadKiroAccounts() {
      try {
        const r = await fetch("/admin/kiro/accounts");
        const accounts = await r.json();
        kiroAccounts = accounts;
        if (!accounts.length) {
          el("kiroAccountsList").innerHTML = '<div style="color:var(--muted);font-size:13px">No Kiro accounts added yet.</div>';
          return;
        }
        el("kiroAccountsList").innerHTML = accounts.map(a => {
          let usage, bar = '';
          if (a.creditBudget) {
            usage = a.usedCredits.toFixed(2) + ' / ' + a.creditBudget + ' cr';
            const color = a.usedPercent >= 90 ? '#a73737' : a.usedPercent >= 70 ? '#9b4a10' : '#0d6f63';
            bar = '<div style="width:90px;height:6px;background:var(--line);border-radius:3px;overflow:hidden">' +
                  '<div style="width:' + a.usedPercent + '%;height:100%;background:' + color + '"></div></div>' +
                  '<span class="mono" style="font-size:11px;color:var(--muted);min-width:34px">' + a.usedPercent + '%</span>';
          } else {
            usage = a.usedCredits.toFixed(4) + ' cr used';
          }
          const keyWarn = a.hasKey ? '' : '<span class="badge" style="background:#a73737;color:#fff;font-size:11px">NO KEY</span>';
          return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">' +
            '<span style="font-weight:600;flex:1">' + escapeHtml(a.name) + '</span>' +
            '<span class="mono" style="font-size:12px">' + usage + '</span>' + bar + keyWarn +
            '<span class="pill" style="font-size:11px">' + escapeHtml(a.region) + '</span>' +
            '<button type="button" data-kiro-edit="' + a.id + '" style="font-size:12px;padding:2px 8px;min-height:28px">Edit</button>' +
            '<button type="button" data-kiro-rotate="' + a.id + '" style="font-size:12px;padding:2px 8px;min-height:28px">Replace key</button>' +
            '<button type="button" data-kiro-reset="' + a.id + '" style="font-size:12px;padding:2px 8px;min-height:28px">Reset credits</button>' +
            '<button type="button" class="danger" data-kiro-del="' + a.id + '" style="font-size:12px;padding:2px 8px;min-height:28px">Delete</button>' +
          '</div>';
        }).join("");
      } catch {}
    }

    async function kiroRotateKey(id) {
      const apiKey = prompt("Paste the new Kiro API key for this account (ksk_...):");
      if (!apiKey || !apiKey.trim()) return;
      el("kiroStatus").textContent = "Validating new key...";
      try {
        await api("/admin/kiro/account/" + id, { method: "PUT", body: JSON.stringify({ apiKey: apiKey.trim() }) });
        el("kiroStatus").textContent = "Key replaced.";
        await loadKiroAccounts();
      } catch(e) {
        el("kiroStatus").textContent = "Failed: " + e.message;
      }
    }

    async function kiroResetCredits(id) {
      if (!confirm("Reset the tracked credit usage for this account to zero?")) return;
      try {
        await api("/admin/kiro/account/" + id, { method: "PUT", body: JSON.stringify({ resetCredits: true }) });
        el("kiroStatus").textContent = "Credit usage reset.";
        await loadKiroAccounts();
      } catch(e) {
        el("kiroStatus").textContent = "Failed: " + e.message;
      }
    }

    async function kiroEditAccount(id) {
      const a = kiroAccounts.find(x => x.id === id);
      if (!a) return;
      const current = a.name.replace(/^Kiro:\\s*/, "");
      const name = prompt("Account name:", current);
      if (name === null) return;
      const budgetIn = prompt("Credit budget (leave blank for no budget):", a.creditBudget != null ? String(a.creditBudget) : "");
      if (budgetIn === null) return;

      const body = {};
      if (name.trim()) body.name = name.trim();
      const b = budgetIn.trim();
      if (b === "") body.creditBudget = null;
      else {
        const n = parseFloat(b);
        if (!isFinite(n) || n < 0) { el("kiroStatus").textContent = "Budget must be a positive number."; return; }
        body.creditBudget = n;
      }
      try {
        await api("/admin/kiro/account/" + id, { method: "PUT", body: JSON.stringify(body) });
        el("kiroStatus").textContent = "Account updated.";
        await loadKiroAccounts();
        await refresh();
      } catch(e) {
        el("kiroStatus").textContent = "Failed: " + e.message;
      }
    }

    async function kiroDeleteAccount(id) {
      const a = kiroAccounts.find(x => x.id === id);
      const label = a ? a.name : id;
      if (!confirm('Delete "' + label + '"? The stored API key is removed, its models are dropped, and any tool routed to it becomes unassigned. This cannot be undone.')) return;
      try {
        await api("/admin/kiro/account/" + id, { method: "DELETE" });
        el("kiroStatus").textContent = "Deleted " + label + ".";
        await loadKiroAccounts();
        await refresh();
      } catch(e) {
        el("kiroStatus").textContent = "Failed: " + e.message;
      }
    }

    el("kiroAddBtn").addEventListener("click", () => { el("kiroStatus").textContent = ""; kiroShowForm(true); });
    el("kiroCancelBtn").addEventListener("click", () => { el("kiroStatus").textContent = ""; kiroShowForm(false); });
    el("kiroAddForm").addEventListener("submit", kiroAddAccount);
    el("kiroAccountsList").addEventListener("click", (ev) => {
      const edit = ev.target.closest("[data-kiro-edit]");
      if (edit) return kiroEditAccount(edit.dataset.kiroEdit);
      const rotate = ev.target.closest("[data-kiro-rotate]");
      if (rotate) return kiroRotateKey(rotate.dataset.kiroRotate);
      const reset = ev.target.closest("[data-kiro-reset]");
      if (reset) return kiroResetCredits(reset.dataset.kiroReset);
      const del = ev.target.closest("[data-kiro-del]");
      if (del) return kiroDeleteAccount(del.dataset.kiroDel);
    });
    loadKiroAccounts();
  </script>
</body>
</html>`;
}
