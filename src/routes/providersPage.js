import { renderLayout } from './layoutTemplate.js';

export function renderProvidersPage() {
  const content = `
    <section>
      <div class="section-head">
        <h2>Providers</h2>
        <span class="pill" id="provCount">0</span>
      </div>
      <div class="section-body">
        <div id="providerList"></div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Test a provider</h2>
        <button type="button" id="runTestBtn" class="primary">Run test</button>
      </div>
      <div class="section-body">
        <div class="subline" style="margin-bottom:12px">
          Sends one minimal request upstream and reports what came back. This spends real
          credits on a metered account. The probe's prompt is fixed
          (<span class="mono">Reply with only: ok</span>) and it reports reachability, not the
          reply text — so it answers "does this key and model work", not "is the answer good".
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;align-items:end">
          <label>Provider<select id="testProvider"></select></label>
          <label>Model<select id="testModel"></select></label>
        </div>
        <pre id="testOutput" style="margin:12px 0 0;padding:12px;border:1px solid var(--line);border-radius:7px;background:var(--field);white-space:pre-wrap;word-break:break-word;font-family:'SFMono-Regular',Consolas,monospace;font-size:12px;min-height:64px">Pick a provider and model, then Run test.</pre>
      </div>
    </section>

    <section id="modelSection" style="display:none">
      <div class="section-head">
        <h2 id="modelTitle">Models</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="pill" id="modelSelectedCount">0 selected</span>
          <button type="button" id="modelSaveBtn" class="primary">Save selection</button>
        </div>
      </div>
      <div class="section-body">
        <div class="subline" style="margin-bottom:12px">Ticked models are the ones this provider is allowed to serve. Routing and profile dropdowns only offer what is saved here.</div>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <input id="modelFilter" placeholder="Filter models…" autocomplete="off" style="flex:1;min-width:180px">
          <button type="button" id="modelAllBtn">Select all shown</button>
          <button type="button" id="modelNoneBtn">Clear all</button>
          <button type="button" id="modelManualBtn">Add manually</button>
        </div>
        <div id="modelList" style="display:grid;gap:6px;max-height:340px;overflow:auto"></div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Add New Provider</h2>
        <span class="pill" id="providerMode">remote</span>
      </div>
      <div class="section-body">
        <div class="subline" style="margin-bottom:14px;padding:10px 12px;background:var(--field);border:1px solid var(--line);border-radius:7px">
          Adding a <strong>Kiro</strong> account? It has its own one-step flow — paste the
          <span class="mono">ksk_</span> key and the account, region and model list are detected
          for you. Use <a href="/admin/kiro">Kiro &rarr;</a> instead of this form.
        </div>
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
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(110px, 1fr));gap:8px;margin:12px 0">
            <button type="button" data-preset="openrouter">OpenRouter</button>
            <button type="button" data-preset="requesty">Requesty</button>
            <button type="button" data-preset="groq">Groq</button>
            <button type="button" data-preset="together">Together</button>
            <button type="button" data-preset="ollama">Ollama (local)</button>
            <button type="button" data-preset="lmstudio">LM Studio (local)</button>
            <button type="button" data-preset="anthropic">Anthropic</button>
            <button type="button" data-preset="openai">OpenAI</button>
          </div>
          <button type="submit" class="primary" id="submitBtn">Add provider</button>
          <button type="button" id="cancelEditBtn" style="display:none">Cancel edit</button>
        </form>
        <div id="formMessage" class="notice" style="margin-top:12px;display:none"></div>
      </div>
    </section>

    <script>
      // IIFE: separate classic <script> blocks share one global lexical scope,
      // so a top-level const here that also exists in the layout shell is a
      // redeclaration SyntaxError that kills the whole block silently.
      (function () {
      const el = (id) => document.getElementById(id);
      // Content-Type matters: express.json() only parses a body when it is set,
      // so without it every POST/PUT would arrive as {} and fail validation.
      const api = async (path, opts = {}) => {
        const r = await fetch(path, {
          ...opts,
          headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
        });
        if (r.status === 204) return null;
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error?.message || r.statusText || "Request failed");
        return body;
      };
      const escapeHtml = (s) => String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

      let providers = [];
      let selectedProviderId = null;
      let fetchedModels = [];
      let messageTimer = null;

      function showMessage(text, kind = "") {
        const box = el('formMessage');
        box.textContent = text;
        box.className = 'notice ' + kind;
        box.style.display = 'block';
        clearTimeout(messageTimer);
        if (kind === 'ok') messageTimer = setTimeout(() => { box.style.display = 'none'; }, 4000);
      }

      // Single source of truth for "does this type need a key". Called on type
      // change, on preset click and on reset — the pill was previously hardcoded
      // to "remote" and never moved.
      function applyTypeMode() {
        const noKey = el('type').value === 'local-openai';
        el('apiKeyWrap').style.display = noKey ? 'none' : 'grid';
        el('apiKey').required = !noKey && !el('providerForm').dataset.editId;
        el('providerMode').textContent = noKey ? 'local — no key' : 'remote';
      }

      function resetForm() {
        el('providerForm').reset();
        delete el('providerForm').dataset.editId;
        el('submitBtn').textContent = 'Add provider';
        el('cancelEditBtn').style.display = 'none';
        applyTypeMode();
      }

      // Presets fill the form only — nothing is saved until Add is pressed. The
      // local ones use type local-openai, which needs no API key.
      const presets = {
        openrouter: { name: 'OpenRouter', type: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' },
        requesty: { name: 'Requesty', type: 'openai-compat', baseUrl: 'https://router.requesty.ai/v1' },
        groq: { name: 'Groq', type: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1' },
        together: { name: 'Together AI', type: 'openai-compat', baseUrl: 'https://api.together.xyz/v1' },
        ollama: { name: 'Ollama Local', type: 'local-openai', baseUrl: 'http://localhost:11434/v1' },
        lmstudio: { name: 'LM Studio', type: 'local-openai', baseUrl: 'http://localhost:1234/v1' },
        anthropic: { name: 'Anthropic Direct', type: 'anthropic-compat', baseUrl: 'https://api.anthropic.com/v1' },
        openai: { name: 'OpenAI', type: 'openai-compat', baseUrl: 'https://api.openai.com/v1' },
      };

      async function loadProviders() {
        try {
          providers = await api('/admin/providers');
          el('provCount').textContent = providers.length + (providers.length === 1 ? ' provider' : ' providers');
          renderProviders();
          renderTestPanel();
          if (selectedProviderId && !providers.some(p => p.id === selectedProviderId)) {
            selectedProviderId = null;
            fetchedModels = [];
            el('modelSection').style.display = 'none';
          } else if (selectedProviderId) {
            renderModelList();
          }
        } catch (e) {
          el('providerList').innerHTML = '<div class="empty" style="color:var(--bad)">Failed to load providers: ' + escapeHtml(e.message) + '</div>';
        }
      }

      function renderProviders() {
        const html = providers.map(p => {
          const status = p.status === 'ok' ? '<span class="status ok">✓ OK</span>' :
                        p.status === 'error' ? '<span class="status error">✗ Error</span>' :
                        '<span class="status">Unknown</span>';
          const tested = p.lastTestedAt ? new Date(p.lastTestedAt).toLocaleString('en-GB', { hour12: false }) : 'Never';
          const modelCount = (p.models || []).length;

          return '<div style="border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:12px">' +
            '<div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:10px">' +
            '<div>' +
            '<h3 style="margin:0;font-size:14px">' + escapeHtml(p.name) + '</h3>' +
            '<div class="subline" style="margin-top:4px">' + escapeHtml(p.type) + ' • ' + escapeHtml(p.baseUrl) + '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap">' + status + '</div>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:auto auto auto auto;gap:12px;margin-bottom:12px;font-size:12px">' +
            '<div><span class="subline">Models</span><div style="font-weight:600">' + modelCount + '</div></div>' +
            '<div><span class="subline">Status</span><div>' + (p.enabled ? 'Enabled' : 'Disabled') + '</div></div>' +
            '<div><span class="subline">Tested</span><div>' + tested + '</div></div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button type="button" data-prov-test="' + escapeHtml(p.id) + '">Test</button>' +
            '<button type="button" data-prov-edit="' + escapeHtml(p.id) + '">Edit</button>' +
            '<button type="button" data-prov-fetch="' + escapeHtml(p.id) + '">Fetch models</button>' +
            '<button type="button" class="danger" data-prov-del="' + escapeHtml(p.id) + '">Delete</button>' +
            '</div>' +
            '</div>';
        }).join('');

        el('providerList').innerHTML = html || '<div class="empty">No providers yet. Add one above.</div>';
      }

      async function testProvider(id) {
        const p = providers.find(x => x.id === id);
        showMessage("Testing " + (p ? p.name : id) + "…");
        try {
          const res = await api('/admin/providers/' + id + '/test', { method: 'POST' });
          const model = res.probe?.modelId || '(default model)';
          showMessage("Test passed: " + model + " responded.", "ok");
          loadProviders();
        } catch (e) {
          showMessage("Test failed: " + e.message, "bad");
          loadProviders();
        }
      }

      async function fetchModels(id) {
        const p = providers.find(x => x.id === id);
        showMessage("Fetching models from " + (p ? p.name : id) + "…");
        try {
          const models = await api('/admin/providers/' + id + '/models');
          selectedProviderId = id;
          fetchedModels = models.map(m => m.id).filter(Boolean);
          const cached = models.some(m => m.cached);
          renderModelList();
          showMessage("Found " + fetchedModels.length + " models" +
            (cached ? " (cached — the live fetch failed, so these are the already-configured ids)." : ". Tick the ones to enable, then Save selection."), "ok");
          el('modelSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (e) {
          showMessage("Fetch failed: " + e.message, "bad");
        }
      }

      // Model selection: fetching a catalog is only half the job — nothing routes
      // until the chosen ids are saved back onto the provider.
      function renderModelList() {
        const provider = providers.find(p => p.id === selectedProviderId);
        if (!provider) { el('modelSection').style.display = 'none'; return; }
        el('modelSection').style.display = 'block';
        el('modelTitle').textContent = 'Models — ' + provider.name;

        const filter = el('modelFilter').value.trim().toLowerCase();
        const enabled = new Set(provider.models || []);
        // Already-enabled ids stay listed even when a fresh fetch omits them,
        // otherwise saving would silently drop them.
        const ids = [...new Set([...fetchedModels, ...enabled])].sort();
        const shown = filter ? ids.filter(m => m.toLowerCase().includes(filter)) : ids;

        el('modelList').innerHTML = shown.length
          ? shown.map(m =>
              '<label style="display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:7px;padding:7px 9px;background:var(--field)">' +
                '<input type="checkbox" value="' + escapeHtml(m) + '" style="min-height:auto;width:16px"' + (enabled.has(m) ? ' checked' : '') + '>' +
                '<span class="mono">' + escapeHtml(m) + '</span>' +
              '</label>'
            ).join('')
          : '<div class="empty">No models match that filter.</div>';
        updateSelectedCount();
      }

      function updateSelectedCount() {
        const n = el('modelList').querySelectorAll('input:checked').length;
        el('modelSelectedCount').textContent = n + ' selected';
      }

      async function saveModelSelection() {
        if (!selectedProviderId) return;
        const provider = providers.find(p => p.id === selectedProviderId);
        const shown = [...el('modelList').querySelectorAll('input')].map(i => i.value);
        const ticked = [...el('modelList').querySelectorAll('input:checked')].map(i => i.value);
        // Only reconcile the rows currently rendered, so a filtered view cannot
        // wipe out selections that are scrolled out of sight.
        const kept = (provider?.models || []).filter(m => !shown.includes(m));
        const models = [...new Set([...kept, ...ticked])];
        try {
          await api('/admin/providers/' + selectedProviderId + '/models', {
            method: 'POST',
            body: JSON.stringify({ models }),
          });
          showMessage('Saved ' + models.length + ' models for ' + (provider ? provider.name : 'provider') + '.', 'ok');
          await loadProviders();
        } catch (e) {
          showMessage('Save failed: ' + e.message, 'bad');
        }
      }

      async function addModelsManually() {
        if (!selectedProviderId) return;
        const input = prompt('Model ids to add (comma-separated):');
        if (!input) return;
        const models = input.split(',').map(s => s.trim()).filter(Boolean);
        if (!models.length) return;
        try {
          await api('/admin/providers/' + selectedProviderId + '/models/add', {
            method: 'POST',
            body: JSON.stringify({ models }),
          });
          fetchedModels = [...new Set([...fetchedModels, ...models])];
          showMessage('Added ' + models.length + ' model id(s).', 'ok');
          await loadProviders();
        } catch (e) {
          showMessage('Failed: ' + e.message, 'bad');
        }
      }

      el('modelSaveBtn').addEventListener('click', saveModelSelection);
      el('modelManualBtn').addEventListener('click', addModelsManually);
      el('modelFilter').addEventListener('input', renderModelList);
      el('modelList').addEventListener('change', updateSelectedCount);
      el('modelAllBtn').addEventListener('click', () => {
        el('modelList').querySelectorAll('input').forEach(i => { i.checked = true; });
        updateSelectedCount();
      });
      el('modelNoneBtn').addEventListener('click', () => {
        el('modelList').querySelectorAll('input').forEach(i => { i.checked = false; });
        updateSelectedCount();
      });

      async function deleteProvider(id) {
        const p = providers.find(x => x.id === id);
        const label = p ? p.name : id;
        if (!confirm('Delete "' + label + '"? Any tool routed to it becomes unassigned.')) return;
        try {
          await api('/admin/providers/' + id, { method: 'DELETE' });
          showMessage("Deleted " + label + ".", "ok");
          loadProviders();
        } catch (e) {
          showMessage("Failed: " + e.message, "bad");
        }
      }

      function editProvider(id) {
        const p = providers.find(x => x.id === id);
        if (!p) return;
        el('name').value = p.name;
        el('type').value = p.type;
        el('baseUrl').value = p.baseUrl;
        el('providerForm').dataset.editId = id;
        applyTypeMode();
        el('submitBtn').textContent = 'Save changes';
        el('cancelEditBtn').style.display = 'inline-flex';
        showMessage('Editing "' + p.name + '". Leave the API key blank to keep the current one.');
        el('name').scrollIntoView({ behavior: 'smooth', block: 'center' });
        el('name').focus();
      }

      el('providerList').addEventListener('click', (ev) => {
        const test = ev.target.closest('[data-prov-test]');
        if (test) return testProvider(test.dataset.provTest);
        const edit = ev.target.closest('[data-prov-edit]');
        if (edit) return editProvider(edit.dataset.provEdit);
        const fetchBtn = ev.target.closest('[data-prov-fetch]');
        if (fetchBtn) return fetchModels(fetchBtn.dataset.provFetch);
        const del = ev.target.closest('[data-prov-del]');
        if (del) return deleteProvider(del.dataset.provDel);
      });

      el('type').addEventListener('change', applyTypeMode);

      document.querySelectorAll('[data-preset]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const preset = presets[btn.dataset.preset];
          if (!preset) return;
          el('name').value = preset.name;
          el('type').value = preset.type;
          el('baseUrl').value = preset.baseUrl;
          // Keep the key field and the mode pill in step with the chosen type —
          // a local-openai preset needs no key, and leaving the field visible
          // reads as "still required".
          applyTypeMode();
          el(preset.type === 'local-openai' ? 'name' : 'apiKey').focus();
        });
      });

      el('cancelEditBtn').addEventListener('click', () => {
        resetForm();
        el('formMessage').style.display = 'none';
      });

      el('providerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const editId = el('providerForm').dataset.editId;
        const name = el('name').value.trim();
        const baseUrl = el('baseUrl').value.trim();
        const type = el('type').value;
        const apiKey = el('apiKey').value;

        if (!name || !baseUrl) { showMessage('Name and base URL are required.', 'bad'); return; }
        if (!editId && type !== 'local-openai' && !apiKey) {
          showMessage('An API key is required for this provider type.', 'bad');
          return;
        }

        const body = { name, type, baseUrl };
        // On edit an empty field means "keep the stored key" — sending "" would
        // overwrite the real key with a blank one.
        if (apiKey) body.apiKey = apiKey;

        try {
          if (editId) {
            await api('/admin/providers/' + editId, { method: 'PUT', body: JSON.stringify(body) });
            showMessage('Provider updated.', 'ok');
          } else {
            await api('/admin/providers', { method: 'POST', body: JSON.stringify(body) });
            showMessage('Provider added. Fetch its models next.', 'ok');
          }
          resetForm();
          loadProviders();
        } catch (err) {
          showMessage('Failed: ' + err.message, 'bad');
        }
      });

      // --- Test panel ---
      // Kept separate from the per-row Test button: this one lets you choose WHICH
      // model to probe, which matters on a provider whose first configured model is
      // not the one actually routed.
      function renderTestPanel() {
        const sel = el('testProvider');
        const keep = sel.value;
        sel.innerHTML = '<option value="">(select provider)</option>' + providers.map(p =>
          '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + ' (' + escapeHtml(p.type) + ')</option>'
        ).join('');
        if (keep && providers.some(p => p.id === keep)) sel.value = keep;
        renderTestModels();
      }

      function renderTestModels() {
        const sel = el('testModel');
        const provider = providers.find(p => p.id === el('testProvider').value);
        const models = provider?.models || [];
        const keep = sel.value;
        if (!provider) {
          sel.innerHTML = '<option value="">(pick a provider first)</option>';
          el('runTestBtn').disabled = true;
          return;
        }
        if (!models.length) {
          sel.innerHTML = '<option value="">(no models — fetch them first)</option>';
          el('runTestBtn').disabled = true;
          return;
        }
        sel.innerHTML = models.map(m => '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>').join('');
        if (models.includes(keep)) sel.value = keep;
        el('runTestBtn').disabled = false;
      }

      async function runTest() {
        const providerId = el('testProvider').value;
        const model = el('testModel').value;
        const out = el('testOutput');
        if (!providerId || !model) { out.textContent = 'Pick a provider and model first.'; return; }
        const provider = providers.find(p => p.id === providerId);
        el('runTestBtn').disabled = true;
        out.style.color = '';
        out.textContent = 'Testing ' + model + ' on ' + provider.name + '…';
        const started = Date.now();
        try {
          const res = await api('/admin/providers/' + providerId + '/test', {
            method: 'POST',
            body: JSON.stringify({ model }),
          });
          const ms = Date.now() - started;
          out.style.color = 'var(--accent)';
          out.textContent = 'PASS — ' + (res.probe?.modelId || model) + ' responded in ' + ms + 'ms.\\n' +
            'provider: ' + provider.name + ' (' + provider.type + ')\\n' +
            'status now: ' + (res.status || 'ok') +
            '\\n\\nThe probe confirms reachability only; it does not return the reply text.';
          loadProviders();
        } catch (e) {
          const ms = Date.now() - started;
          out.style.color = 'var(--bad)';
          out.textContent = 'FAIL after ' + ms + 'ms\\n\\n' + e.message;
          loadProviders();
        } finally {
          el('runTestBtn').disabled = false;
        }
      }

      el('runTestBtn').addEventListener('click', runTest);
      el('testProvider').addEventListener('change', renderTestModels);

      // No polling here on purpose: a periodic re-render would reset the model
      // checkboxes and the edit form mid-edit. The header Refresh button reloads.
      applyTypeMode();
      loadProviders();
      })();
    </script>
  `;

  return renderLayout(content, 'providers');
}
