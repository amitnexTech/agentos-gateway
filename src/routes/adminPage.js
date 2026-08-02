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
      <div class="panel-head">
        <h2>Routing</h2>
        <div style="display:flex;align-items:center;gap:14px">
          <label title="When the bound provider fails with a retriable error (429/403/5xx/timeout), retry the same request on another enabled provider allowed on this route — protocols are translated, so an Anthropic provider can back up an OpenAI one. Off by default — keeps it clear which account is spending." style="display:flex;align-items:center;gap:6px;flex-direction:row;color:var(--ink);font-size:13px;font-weight:400;margin:0">
            <input type="checkbox" id="fallbackToggle" style="min-height:auto;width:16px"> Auto-fallback
          </label>
          <button id="useAllBtn" type="button" disabled>Use for all</button>
        </div>
      </div>
      <div class="panel-body" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px" id="routingPanel">
        <div class="stack">
          <label>Claude Code (/v1/messages)<select id="route-claude"></select></label>
          <label title="Which of that provider's models to actually run. Pick one and the client's choice stops mattering — /model in Claude Code becomes cosmetic. Leave it on (client decides) to forward whatever the client asks for.">Model<select id="force-claude"></select></label>
        </div>
        <div class="stack">
          <label>Codex (/v1/responses)<select id="route-codex"></select></label>
          <label title="Which of that provider's models to actually run, regardless of what Codex asks for.">Model<select id="force-codex"></select></label>
        </div>
        <div class="stack">
          <label>OpenAI (/v1/chat/completions)<select id="route-openai"></select></label>
          <label title="Which of that provider's models to actually run, regardless of what the client asks for.">Model<select id="force-openai"></select></label>
        </div>
      </div>
      <div class="panel-body" style="border-top:1px solid var(--line)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <strong style="font-size:13px">Model overrides</strong>
          <span class="pill" id="overrideCount">0</span>
        </div>
        <div class="subline" style="margin-bottom:10px">Exceptions to the slot above: send one model id to a different provider, under whatever name that provider uses. This is where "give me fable from aeorlink but sonnet from Kiro" lives — and where Claude Code's background models (its subagent model and the auto-mode classifier) get pointed at a provider that can actually serve them, so auto mode keeps working while everything else runs on the slot's forced model. Pick the provider first; the model list then shows only what it serves.</div>
        <div id="overrideList"></div>
        <div style="display:grid;grid-template-columns:0.7fr 1.1fr 1.2fr 1.2fr auto;gap:8px;align-items:end;margin-top:10px">
          <label>Tool
            <select id="ovTool">
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="openai">openai</option>
            </select>
          </label>
          <label>Provider
            <select id="ovProvider"></select>
          </label>
          <label title="The id this provider serves — sent upstream.">Provider's model<select id="ovTarget"></select></label>
          <label title="The id the client asks for. Defaults to the provider's model; change it when the client uses a different name. Use * to force all models.">Client asks for<input id="ovModel" list="ovModelList" autocomplete="off" placeholder="claude-sonnet-5"><datalist id="ovModelList"></datalist></label>
          <button id="ovAddBtn" type="button">Add</button>
        </div>
        <div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap">
          <label title="Force every model id that has no exact entry onto the provider/model chosen above." style="display:flex;align-items:center;gap:6px;flex-direction:row;font-size:13px;font-weight:400;margin:0">
            <input type="checkbox" id="ovAll" style="min-height:auto;width:16px"> Force all models (<span class="mono">*</span>)
          </label>
          <label title="Keep this model id on the tool's own provider with its own id — the escape hatch from a force route." style="display:flex;align-items:center;gap:6px;flex-direction:row;font-size:13px;font-weight:400;margin:0">
            <input type="checkbox" id="ovExempt" style="min-height:auto;width:16px"> Exempt this id from the force route
          </label>
        </div>
        <div style="margin-top:12px;border-top:1px dashed var(--line);padding-top:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <strong style="font-size:13px">Model ids clients actually asked for</strong>
            <span class="pill" id="seenCount">0</span>
          </div>
          <div class="subline" style="margin-bottom:8px">Read from the request log, so there is no guessing about what an agent sends — this is where Claude Code's subagent id and its auto-mode classifier id show up. Click one to load it into the form above.</div>
          <div id="seenList"></div>
        </div>
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
    const state = { providers: [], selectedProvider: null, fetchedModels: [], activeModels: [], stats: {}, routing: {}, modelRoutes: {}, seenModels: [] };
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

    // Only provider types a route can actually serve are offered. That is now
    // almost everything — the protocol bridge translates OpenAI <-> Anthropic
    // both ways — but Kiro still cannot serve /v1/chat/completions.
    function providersFor(tool) {
      const allowed = state.routing.supportedTypes?.[tool];
      return allowed ? state.providers.filter(p => allowed.includes(p.type)) : state.providers;
    }

    function renderRouting() {
      const tools = ["claude","codex","openai"];
      for (const tool of tools) {
        const sel = el("route-"+tool);
        const current = state.routing[tool]?.id || "";
        const usable = providersFor(tool);
        sel.innerHTML = '<option value="">(none)</option>' +
          usable.map(p => '<option value="'+escapeHtml(p.id)+'"'+(p.id===current?' selected':'')+'>'+escapeHtml(p.name)+' ('+p.models.length+' models)</option>').join("") +
          // A slot already pointing at an incompatible provider must still show
          // what it is, flagged, rather than silently reading as "(none)".
          (current && !usable.some(p => p.id === current)
            ? '<option value="'+escapeHtml(current)+'" selected>'+escapeHtml(state.routing[tool].name)+' ('+escapeHtml(state.routing[tool].type)+' — cannot serve this route)</option>'
            : "");
        renderForceModel(tool);
      }
      el("useAllBtn").disabled = !state.providers.length;
      el("fallbackToggle").checked = !!state.routing.fallbackEnabled;
      renderOverrides();
    }

    // The slot's model dropdown IS the force route (modelRoutes[tool]["*"]).
    // Showing it next to the provider is the whole point: pick an account, pick
    // which of its models runs, and the client's /model choice stops mattering.
    function renderForceModel(tool) {
      const sel = el("force-"+tool);
      const slot = state.providers.find(p => p.id === (state.routing[tool]?.id || ""));
      const force = state.modelRoutes[tool]?.["*"];
      const models = slot?.models || [];

      // A force route may deliberately point at a different provider than the
      // slot (set from Model overrides). Say so rather than showing a wrong value.
      if (force && !force.unavailable && force.id !== slot?.id) {
        sel.innerHTML = '<option value="">forced on '+escapeHtml(force.name||force.id)+': '+escapeHtml(force.model||"?")+'</option>';
        sel.disabled = true;
        return;
      }
      sel.disabled = !slot || !models.length;
      const options = ['<option value="">(client decides)</option>']
        .concat(models.map(m => '<option value="'+escapeHtml(m)+'">'+escapeHtml(m)+'</option>'));
      sel.innerHTML = options.join("");
      sel.value = force && force.id === slot?.id ? (force.model || "") : "";
      if (!slot) sel.innerHTML = '<option value="">(pick a provider first)</option>';
      else if (!models.length) sel.innerHTML = '<option value="">(no models — fetch them first)</option>';
    }

    async function forceModelChange(tool) {
      const providerId = state.routing[tool]?.id;
      const model = el("force-"+tool).value;
      if (!providerId) { setNotice("Pick a provider for "+tool+" first.","bad"); return; }
      try {
        await api("/admin/routing/models", { method:"POST", body: JSON.stringify(
          model ? { tool, model:"*", providerId, targetModel: model } : { tool, model:"*", providerId:null }
        )});
        setNotice(model
          ? tool+": every model the client asks for now runs as "+model+" on "+(state.providers.find(p=>p.id===providerId)?.name||providerId)+"."
          : tool+": no forced model — the client's model id is forwarded as-is.", "ok");
        await refresh();
      } catch(err) { setNotice(err.message,"bad"); await refresh(); }
    }

    // Per-model overrides. Rendered from /admin/routing/models, which resolves
    // each providerId to a name and flags one whose provider is gone/disabled —
    // that row still shows, because a silently-ignored override is worse than a
    // visible broken one.
    function renderOverrides() {
      const rows = [];
      for (const tool of ["claude","codex","openai"]) {
        const byModel = state.modelRoutes[tool] || {};
        for (const [modelId, p] of Object.entries(byModel)) rows.push({ tool, modelId, p });
      }
      el("overrideCount").textContent = rows.length ? rows.length + " active" : "none";
      el("overrideList").innerHTML = rows.length
        ? rows.map(r => {
            const isForce = r.modelId === "*";
            const label = isForce
              ? '<span class="status active">all models</span>'
              : '<span class="mono">'+escapeHtml(r.modelId)+'</span>';
            let target;
            if (r.p.exempt) {
              target = r.p.servedBySlot
                ? '<span class="status">exempt — stays on '+escapeHtml(r.p.slotProvider || "the tool provider")+'</span>'
                : '<span class="status error">exempt, but '+escapeHtml(r.p.slotProvider || "the tool provider")+
                  (r.p.strict ? ' does not serve this id — it will 404' : ' does not list this id — it may be rejected')+'</span>';
            } else if (r.p.unavailable) {
              target = '<span class="status error">'+escapeHtml(r.p.id || "?")+' unavailable — falls back to the tool default</span>';
            } else {
              const renamed = r.p.model && r.p.model !== r.modelId
                ? ' <span class="status">as ' + escapeHtml(r.p.model) + '</span>'
                : "";
              target = '<strong>'+escapeHtml(r.p.name)+'</strong> <span class="status">'+escapeHtml(r.p.type)+'</span>'+renamed;
            }
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">' +
              '<span class="status active">'+escapeHtml(r.tool)+'</span>' + label +
              '<span style="color:var(--muted)">&rarr;</span>' + target +
              '<button class="danger" style="margin-left:auto" data-ov-tool="'+escapeHtml(r.tool)+'" data-ov-model="'+escapeHtml(r.modelId)+'">Remove</button>' +
            '</div>';
          }).join("")
        : '<div class="empty">No overrides — every model follows the provider bound to its tool.</div>';

      const provSel = el("ovProvider");
      const curProv = provSel.value;
      const usable = providersFor(el("ovTool").value);
      provSel.innerHTML = usable
        .map(p => '<option value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+' ('+escapeHtml(p.type)+', '+(p.models?.length||0)+' models)</option>')
        .join("");
      if (curProv && usable.some(p => p.id === curProv)) provSel.value = curProv;
      el("ovAddBtn").disabled = !usable.length;
      renderOverrideTargets();

      // Suggest every model id the gateway knows about, without restricting to
      // them: a client may send an id no provider advertises.
      const ids = new Set(state.activeModels || []);
      for (const p of state.providers) for (const m of (p.models || [])) ids.add(m);
      el("ovModelList").innerHTML = [...ids].sort().map(m => '<option value="'+escapeHtml(m)+'"></option>').join("");
      renderSeenModels();
    }
    // The target list is the selected provider's own catalog — that is the whole
    // point of picking the provider first: you can only send it an id it serves.
    function renderOverrideTargets() {
      const provider = state.providers.find(p => p.id === el("ovProvider").value);
      const models = provider?.models || [];
      const sel = el("ovTarget");
      const cur = sel.value;
      sel.innerHTML = models.length
        ? models.map(m => '<option value="'+escapeHtml(m)+'">'+escapeHtml(m)+'</option>').join("")
        : '<option value="">(no models configured — fetch them first)</option>';
      if (models.includes(cur)) sel.value = cur;
      syncOverrideClientModel();
      updateOverrideForm();
    }

    // Client id defaults to the provider's id — the common case is identical
    // names, and typing it twice is pointless. Anything the user typed is kept.
    function syncOverrideClientModel() {
      const input = el("ovModel");
      if (!input.dataset.touched) input.value = el("ovTarget").value || "";
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
        const [health, providers, activeModels, routing, modelRoutes, seenModels] = await Promise.all([
          api("/admin/health"), api("/admin/providers"), api("/admin/models"), api("/admin/routing"),
          api("/admin/routing/models"), api("/admin/routing/seen"),
        ]);
        state.providers=providers; state.activeModels=activeModels; state.routing=routing;
        state.modelRoutes=modelRoutes; state.seenModels=seenModels;
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

    // Model ids clients actually sent, straight from the request log. The point is
    // to stop guessing which id belongs to which agent role: click one and it
    // lands in the form, already scoped to the tool that sent it.
    function renderSeenModels() {
      const rows = state.seenModels || [];
      el("seenCount").textContent = rows.length ? rows.length + " ids" : "none yet";
      if (!rows.length) {
        el("seenList").innerHTML = '<div class="empty">Nothing in the log yet — run a session through the gateway, then reload.</div>';
        return;
      }
      el("seenList").innerHTML = rows.map(r =>
        '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">' +
          '<span class="status active">'+escapeHtml(r.tool)+'</span>' +
          '<span class="mono">'+escapeHtml(r.model)+'</span>' +
          '<span class="status">'+r.count+'x</span>' +
          (r.routed ? '<span class="status ok">routed</span>' : '') +
          '<button style="margin-left:auto" data-seen-tool="'+escapeHtml(r.tool)+'" data-seen-model="'+escapeHtml(r.model)+'">Use</button>' +
        '</div>').join("");
    }

    function seenAction(e) {
      const btn = e.target.closest("button[data-seen-model]"); if (!btn) return;
      el("ovTool").value = btn.dataset.seenTool;
      el("ovAll").checked = false;
      const input = el("ovModel");
      input.value = btn.dataset.seenModel;
      input.dataset.touched = "1";
      updateOverrideForm();
      setNotice("Loaded "+btn.dataset.seenModel+" — pick the provider and its model, then Add.","ok");
    }

    async function setOverride(tool, model, providerId, targetModel, exempt) {
      try {
        await api("/admin/routing/models",{method:"POST",body:JSON.stringify({tool,model,providerId,targetModel,exempt})});
        const what = model === "*" ? "all models" : model;
        setNotice(exempt
          ? tool+" / "+what+" is now exempt — stays on the tool's provider."
          : providerId
            ? tool+" / "+what+" → "+(state.providers.find(p=>p.id===providerId)?.name||providerId)+(targetModel&&targetModel!==model?" as "+targetModel:"")
            : "Override removed: "+tool+" / "+what+" now follows the tool's provider.", "ok");
        await refresh();
      } catch(err) { setNotice(err.message,"bad"); }
    }

    async function addOverride() {
      const exempt = el("ovExempt").checked;
      const target = el("ovTarget").value;
      const model = el("ovAll").checked ? "*" : (el("ovModel").value.trim() || target);
      if (!model) { setNotice("Pick a provider model, or type the id the client asks for.","bad"); return; }
      if (exempt && model === "*") { setNotice("The force route cannot be exempt from itself.","bad"); return; }
      if (!exempt && !target) { setNotice("Pick a provider model first (or fetch the provider's models).","bad"); return; }
      await setOverride(el("ovTool").value, model, exempt ? null : (el("ovProvider").value || null), exempt ? null : target, exempt);
      el("ovModel").value = ""; delete el("ovModel").dataset.touched;
      el("ovAll").checked = false; el("ovExempt").checked = false;
      updateOverrideForm();
    }

    // Exempt needs no provider/target, and a force route has no client id to type.
    function updateOverrideForm() {
      const exempt = el("ovExempt").checked;
      const all = el("ovAll").checked;
      el("ovProvider").disabled = exempt;
      el("ovTarget").disabled = exempt;
      el("ovModel").disabled = all;
      el("ovAddBtn").disabled = exempt
        ? !el("ovModel").value.trim()
        : !(state.providers.find(p => p.id === el("ovProvider").value)?.models || []).length;
      if (!all) syncOverrideClientModel();
    }

    function overrideAction(e) {
      const btn = e.target.closest("button[data-ov-model]"); if (!btn) return;
      setOverride(btn.dataset.ovTool, btn.dataset.ovModel, null);
    }

    async function toggleFallback() {
      const enabled = el("fallbackToggle").checked;
      try {
        await api("/admin/routing/fallback", { method: "POST", body: JSON.stringify({ enabled }) });
        setNotice("Auto-fallback " + (enabled ? "ON — retriable errors retry on another provider allowed on that route." : "OFF."), "ok");
        await refresh();
      } catch (err) {
        el("fallbackToggle").checked = !enabled; // revert on failure
        setNotice(err.message, "bad");
      }
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
    el("force-claude").addEventListener("change",()=>forceModelChange("claude"));
    el("force-codex").addEventListener("change",()=>forceModelChange("codex"));
    el("force-openai").addEventListener("change",()=>forceModelChange("openai"));
    el("fallbackToggle").addEventListener("change",toggleFallback);
    el("ovAddBtn").addEventListener("click",addOverride);
    el("overrideList").addEventListener("click",overrideAction);
    el("seenList").addEventListener("click",seenAction);
    el("ovProvider").addEventListener("change",renderOverrideTargets);
    el("ovTool").addEventListener("change",renderOverrides);
    el("ovTarget").addEventListener("change",syncOverrideClientModel);
    el("ovModel").addEventListener("input",(e)=>{ e.target.dataset.touched="1"; updateOverrideForm(); });
    el("ovAll").addEventListener("change",updateOverrideForm);
    el("ovExempt").addEventListener("change",updateOverrideForm);
    el("ovModel").addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); addOverride(); } });
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
