import { renderLayout } from './layoutTemplate.js';

export function renderRoutingPage() {
  const content = `
    <section>
      <div class="section-head">
        <h2>Tool Routing</h2>
        <label style="display:flex;align-items:center;gap:6px;flex-direction:row;color:var(--ink);font-size:13px;font-weight:400;margin:0" title="When the bound provider fails with a retriable error (429/401/403/5xx/timeout), retry on another enabled provider allowed on this route. Off by default so it stays clear which account is spending.">
          <input type="checkbox" id="fallbackToggle" style="min-height:auto;width:16px"> Auto-fallback
        </label>
      </div>
      <div class="section-body">
        <div id="routingMessage" class="notice" style="display:none;margin-bottom:12px"></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:16px" id="routingPanel">
          <div class="stack">
            <label>Claude Code (/v1/messages)<select id="route-claude"></select></label>
            <label title="Which model to run. Leave blank for client choice.">Model<select id="force-claude"></select></label>
            <div class="subline" id="note-claude"></div>
          </div>
          <div class="stack">
            <label>Codex (/v1/responses)<select id="route-codex"></select></label>
            <label>Model<select id="force-codex"></select></label>
            <div class="subline" id="note-codex"></div>
          </div>
          <div class="stack">
            <label>OpenAI (/v1/chat/completions)<select id="route-openai"></select></label>
            <label>Model<select id="force-openai"></select></label>
            <div class="subline" id="note-openai"></div>
          </div>
        </div>
        <div style="margin-top:16px;display:flex;gap:8px">
          <button id="useAllBtn" type="button" disabled>Use selected for all</button>
          <button id="refreshRoutingBtn" type="button">Refresh</button>
        </div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Model Overrides</h2>
        <span class="pill" id="overrideCount">0</span>
      </div>
      <div class="section-body">
        <div class="subline" style="margin-bottom:12px">Route specific model IDs to different providers. Examples: use cheap model for background tasks, or pin Claude Code's subagent/classifier to a provider that serves them.</div>
        <div id="overrideList" style="margin-bottom:16px"></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:8px;align-items:end">
          <label>Tool<select id="ovTool"><option value="claude">claude</option><option value="codex">codex</option><option value="openai">openai</option></select></label>
          <label>Client asks for<input id="ovModel" list="ovModelList" autocomplete="off" placeholder="claude-sonnet-5"><datalist id="ovModelList"></datalist></label>
          <label>Send to<select id="ovProvider"></select></label>
          <label>Provider's model<select id="ovTarget"></select></label>
          <button id="ovAddBtn" type="button">Add override</button>
        </div>
        <div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:6px;flex-direction:row;font-size:13px;font-weight:400;margin:0">
            <input type="checkbox" id="ovAll" style="min-height:auto;width:16px"> Force all models (*)
          </label>
          <label style="display:flex;align-items:center;gap:6px;flex-direction:row;font-size:13px;font-weight:400;margin:0">
            <input type="checkbox" id="ovExempt" style="min-height:auto;width:16px"> Exempt from force route
          </label>
        </div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Model IDs from Logs</h2>
        <span class="pill" id="seenCount">0</span>
      </div>
      <div class="section-body">
        <div class="subline" style="margin-bottom:12px">These are model IDs clients have actually asked for (from last 1000 requests). Click to use in the override form above.</div>
        <div id="seenList"></div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Session Profiles</h2>
        <span class="pill" id="profileCount">0</span>
      </div>
      <div class="section-body">
        <div class="subline" style="margin-bottom:12px">Per-session provider routing: each session picks its profile from the base URL, allowing parallel sessions to run different models.</div>
        <div id="profileList" style="margin-bottom:16px"></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:8px;align-items:end">
          <label>Profile name<input id="pfName" autocomplete="off" placeholder="backend"></label>
          <label>Provider<select id="pfProvider"></select></label>
          <label>Model<select id="pfModel"></select></label>
          <button id="pfAddBtn" type="button">Add profile</button>
        </div>
      </div>
    </section>

    <script>
      // IIFE: separate classic <script> blocks share one global lexical scope,
      // so a top-level const here that also exists in the layout shell is a
      // redeclaration SyntaxError that kills the whole block silently.
      (function () {
      const el = (id) => document.getElementById(id);
      // Content-Type matters: express.json() only parses a body when it is set,
      // so without it every POST would arrive as {} and be rejected.
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

      let providers = [], routing = {}, overrides = {}, profiles = {}, seenModels = [];
      let messageTimer = null;

      async function loadData() {
        try {
          const [prov, rout, over, prof, seen] = await Promise.all([
            api('/admin/providers'),
            api('/admin/routing'),
            api('/admin/routing/models'),
            api('/admin/profiles'),
            api('/admin/routing/seen')
          ]);
          providers = prov;
          routing = rout;
          overrides = over;
          profiles = prof;
          seenModels = seen;
          render();
        } catch (e) {
          console.error('Load failed:', e);
        }
      }

      function render() {
        renderToolSlots();
        renderOverrides();
        renderSeen();
        renderProfiles();
        el('fallbackToggle').checked = Boolean(routing.fallbackEnabled);
        el('useAllBtn').disabled = !providers.length;
      }

      // Only provider types a route can actually serve are offered; Kiro, for
      // instance, cannot serve /v1/chat/completions.
      function providersFor(tool) {
        const allowed = routing.supportedTypes?.[tool];
        return allowed ? providers.filter(p => allowed.includes(p.type)) : providers;
      }

      function renderToolSlots() {
        for (const tool of ['claude', 'codex', 'openai']) {
          const provSelect = el('route-' + tool);
          const modelSelect = el('force-' + tool);
          const currentId = routing[tool]?.id || '';
          const usable = providersFor(tool);

          provSelect.innerHTML = '<option value="">(none)</option>' +
            usable.map(p =>
              '<option value="' + escapeHtml(p.id) + '"' + (p.id === currentId ? ' selected' : '') + '>' +
              escapeHtml(p.name) + ' (' + (p.models?.length || 0) + ' models)</option>'
            ).join('') +
            // A slot already pointing at an incompatible provider must still show
            // what it is, flagged, rather than silently reading as "(none)".
            (currentId && !usable.some(p => p.id === currentId)
              ? '<option value="' + escapeHtml(currentId) + '" selected>' + escapeHtml(routing[tool].name) +
                ' (' + escapeHtml(routing[tool].type) + ' — cannot serve this route)</option>'
              : '');

          const slot = providers.find(p => p.id === currentId);
          const force = overrides[tool]?.['*'];
          const models = slot?.models || [];

          // A force route may deliberately point at a different provider than the
          // slot. Say so rather than showing a value that is not in effect.
          if (force && !force.unavailable && force.id !== slot?.id) {
            modelSelect.innerHTML = '<option value="">forced on ' + escapeHtml(force.name || force.id) +
              ': ' + escapeHtml(force.model || '?') + '</option>';
            modelSelect.disabled = true;
            el('note-' + tool).innerHTML = 'Forced onto a different provider (<strong>' +
              escapeHtml(force.name || force.id) + '</strong>) by a model override, so the provider picked here is not serving traffic.';
            continue;
          }

          modelSelect.disabled = !slot || !models.length;
          if (!slot) {
            modelSelect.innerHTML = '<option value="">(pick a provider first)</option>';
          } else if (!models.length) {
            modelSelect.innerHTML = '<option value="">(no models — fetch them first)</option>';
          } else {
            modelSelect.innerHTML = '<option value="">(client decides)</option>' +
              models.map(m => '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>').join('');
            modelSelect.value = force && force.id === slot.id ? (force.model || '') : '';
          }
          renderForceNote(tool, slot, modelSelect.value);
        }
      }

      // The model dropdown IS the force-route toggle. Spell out what will happen,
      // plus the measurable trap: with (client decides) the client's own id goes
      // upstream, so a provider selling one model answers 403 for every other id.
      function renderForceNote(tool, slot, forcedModel) {
        const note = el('note-' + tool);
        const client = tool === 'claude' ? '/model in Claude Code' : "the client's model choice";
        if (!slot) { note.textContent = ''; return; }
        if (forcedModel) {
          note.innerHTML = 'Forced: every request runs <span class="mono">' + escapeHtml(forcedModel) +
            '</span> — ' + client + ' is ignored.';
          return;
        }
        const count = slot.models?.length || 0;
        note.innerHTML = 'Client decides: ' + client + ' is forwarded as-is' +
          (count === 1
            ? ' — <strong>but this provider serves only <span class="mono">' + escapeHtml(slot.models[0]) +
              '</span></strong>, so any other id is rejected upstream.'
            : count ? ' (' + count + ' models available).' : ' — no models fetched yet.');
      }

      function renderOverrides() {
        const rows = [];
        for (const tool of ['claude', 'codex', 'openai']) {
          for (const [modelId, route] of Object.entries(overrides[tool] || {})) {
            if (route) rows.push({ tool, modelId, route });
          }
        }
        el('overrideCount').textContent = rows.length ? rows.length + ' active' : 'none';
        el('overrideList').innerHTML = rows.length
          ? rows.map(r => {
              const label = r.modelId === '*'
                ? '<span class="status ok">all models</span>'
                : '<span class="mono">' + escapeHtml(r.modelId) + '</span>';
              let target;
              if (r.route.exempt) {
                target = r.route.servedBySlot
                  ? '<span class="status">exempt — stays on ' + escapeHtml(r.route.slotProvider || 'the tool provider') + '</span>'
                  : '<span class="status error">exempt, but ' + escapeHtml(r.route.slotProvider || 'the tool provider') +
                    (r.route.strict ? ' does not serve this id — it will 404' : ' does not list this id — it may be rejected') + '</span>';
              } else if (r.route.unavailable) {
                target = '<span class="status error">' + escapeHtml(r.route.id || '?') + ' unavailable — falls back to the tool default</span>';
              } else {
                const renamed = r.route.model && r.route.model !== r.modelId
                  ? ' <span class="status">as ' + escapeHtml(r.route.model) + '</span>' : '';
                target = '<strong>' + escapeHtml(r.route.name) + '</strong> <span class="status">' +
                  escapeHtml(r.route.type) + '</span>' + renamed;
              }
              return '<div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--field);margin-bottom:6px;flex-wrap:wrap">' +
                '<span class="status ok">' + escapeHtml(r.tool) + '</span>' + label +
                '<span style="color:var(--muted)">→</span>' + target +
                '<button type="button" class="danger" style="margin-left:auto;font-size:12px;padding:2px 8px;min-height:28px" ' +
                'data-ov-tool="' + escapeHtml(r.tool) + '" data-ov-model="' + escapeHtml(r.modelId) + '">Remove</button>' +
              '</div>';
            }).join('')
          : '<div class="empty">No overrides — every model follows the provider bound to its tool.</div>';

        const provSel = el('ovProvider');
        const keep = provSel.value;
        const usable = providersFor(el('ovTool').value);
        provSel.innerHTML = usable.map(p =>
          '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + ' (' + escapeHtml(p.type) + ')</option>'
        ).join('');
        if (keep && usable.some(p => p.id === keep)) provSel.value = keep;
        renderOverrideTargets();

        const ids = new Set();
        for (const p of providers) for (const m of (p.models || [])) ids.add(m);
        el('ovModelList').innerHTML = [...ids].sort().map(m => '<option value="' + escapeHtml(m) + '"></option>').join('');
      }

      // The target list is the selected provider's own catalog — you can only
      // send it an id it actually serves.
      function renderOverrideTargets() {
        const provider = providers.find(p => p.id === el('ovProvider').value);
        const models = provider?.models || [];
        const sel = el('ovTarget');
        const keep = sel.value;
        sel.innerHTML = models.length
          ? models.map(m => '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>').join('')
          : '<option value="">(no models — fetch them first)</option>';
        if (models.includes(keep)) sel.value = keep;
        syncOverrideClientModel();
        updateOverrideForm();
      }

      // Client id defaults to the provider's id — the common case is identical
      // names. Anything the user typed is kept.
      function syncOverrideClientModel() {
        const input = el('ovModel');
        if (!input.dataset.touched) input.value = el('ovTarget').value || '';
      }

      function updateOverrideForm() {
        const exempt = el('ovExempt').checked;
        const all = el('ovAll').checked;
        el('ovProvider').disabled = exempt;
        el('ovTarget').disabled = exempt;
        el('ovModel').disabled = all;
        el('ovAddBtn').disabled = exempt
          ? !el('ovModel').value.trim()
          : !(providers.find(p => p.id === el('ovProvider').value)?.models || []).length;
        if (!all) syncOverrideClientModel();
      }

      function renderSeen() {
        el('seenCount').textContent = seenModels.length ? seenModels.length + ' ids' : 'none yet';
        el('seenList').innerHTML = seenModels.length
          ? seenModels.map(m =>
              '<div style="display:flex;align-items:center;gap:8px;padding:6px;background:var(--field);border-radius:6px;margin-bottom:4px;flex-wrap:wrap">' +
                '<span class="status ok">' + escapeHtml(m.tool) + '</span>' +
                '<span class="mono" style="flex:1">' + escapeHtml(m.model) + '</span>' +
                '<span class="status">' + m.count + '×</span>' +
                (m.routed ? '<span class="status ok">routed</span>' : '<span class="status">no override</span>') +
                '<button type="button" style="font-size:11px;padding:2px 8px;min-height:26px" ' +
                'data-seen-tool="' + escapeHtml(m.tool) + '" data-seen-model="' + escapeHtml(m.model) + '">Use in form</button>' +
              '</div>'
            ).join('')
          : '<div class="empty">Nothing in the log yet — run a session through the gateway, then refresh.</div>';
      }

      function renderProfiles() {
        const names = Object.keys(profiles);
        el('profileCount').textContent = names.length ? names.length + ' active' : 'none';
        el('profileList').innerHTML = names.length
          ? names.map(name => {
              const pf = profiles[name];
              const target = pf.unavailable
                ? '<span class="status error">' + escapeHtml(pf.id || '?') + ' unavailable — sessions on this profile are refused</span>'
                : '<strong>' + escapeHtml(pf.name) + '</strong> <span class="status">' + escapeHtml(pf.type) + '</span>' +
                  (pf.model ? ' <span class="status ok">' + escapeHtml(pf.model) + '</span>' : ' <span class="status">client decides</span>');
              return '<div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--field);margin-bottom:6px;flex-wrap:wrap">' +
                '<span class="mono">' + escapeHtml(name) + '</span>' +
                '<span style="color:var(--muted)">→</span>' + target +
                '<span class="mono" style="font-size:11px;color:var(--muted)">' + escapeHtml(location.origin + '/p/' + name) + '</span>' +
                '<button type="button" class="danger" style="margin-left:auto;font-size:12px;padding:2px 8px;min-height:28px" ' +
                'data-pf-name="' + escapeHtml(name) + '">Remove</button>' +
              '</div>';
            }).join('')
          : '<div class="empty">No profiles — every session follows the global routing above.</div>';

        const sel = el('pfProvider');
        const keep = sel.value;
        sel.innerHTML = providers.map(p =>
          '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + ' (' + escapeHtml(p.type) + ')</option>'
        ).join('');
        if (keep && providers.some(p => p.id === keep)) sel.value = keep;
        el('pfAddBtn').disabled = !providers.length;
        renderProfileModels();
      }

      function renderProfileModels() {
        const provider = providers.find(p => p.id === el('pfProvider').value);
        const sel = el('pfModel');
        const keep = sel.value;
        sel.innerHTML = '<option value="">(client decides)</option>' +
          (provider?.models || []).map(m => '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>').join('');
        if (keep) sel.value = keep;
      }

      function showMessage(text, kind = "") {
        const box = el('routingMessage');
        box.textContent = text;
        box.className = 'notice ' + kind;
        box.style.display = 'block';
        clearTimeout(messageTimer);
        if (kind === 'ok') messageTimer = setTimeout(() => { box.style.display = 'none'; }, 5000);
      }

      async function slotChange(tool) {
        const providerId = el('route-' + tool).value || null;
        try {
          await api('/admin/routing/' + tool, { method: 'POST', body: JSON.stringify({ providerId }) });
          const name = providers.find(p => p.id === providerId)?.name || 'none';
          showMessage(tool + ' → ' + name, 'ok');
        } catch (e) {
          showMessage(e.message, 'bad');
        }
        loadData();
      }

      // Picking a model here writes the "*" force route for that tool; clearing it
      // deletes that route so the client's own id is forwarded again.
      async function forceModelChange(tool) {
        const providerId = routing[tool]?.id;
        const model = el('force-' + tool).value;
        if (!providerId) { showMessage('Pick a provider for ' + tool + ' first.', 'bad'); return; }
        try {
          await api('/admin/routing/models', {
            method: 'POST',
            body: JSON.stringify(model
              ? { tool, model: '*', providerId, targetModel: model }
              : { tool, model: '*', providerId: null }),
          });
          showMessage(model
            ? tool + ': every request now runs ' + model + '.'
            : tool + ': no forced model — the client id is forwarded as-is.', 'ok');
        } catch (e) {
          showMessage(e.message, 'bad');
        }
        loadData();
      }

      async function toggleFallback() {
        const enabled = el('fallbackToggle').checked;
        try {
          await api('/admin/routing/fallback', { method: 'POST', body: JSON.stringify({ enabled }) });
          showMessage('Auto-fallback ' + (enabled ? 'ON — retriable errors retry on another allowed provider.' : 'OFF.'), 'ok');
        } catch (e) {
          el('fallbackToggle').checked = !enabled;
          showMessage(e.message, 'bad');
        }
        loadData();
      }

      async function useForAll() {
        const providerId = el('route-claude').value || el('route-codex').value ||
          el('route-openai').value || providers[0]?.id;
        if (!providerId) return;
        try {
          const res = await api('/admin/routing/all', { method: 'POST', body: JSON.stringify({ providerId }) });
          showMessage(res.note || 'All tools routed to the same provider.', 'ok');
        } catch (e) {
          showMessage(e.message, 'bad');
        }
        loadData();
      }

      async function addOverride() {
        const exempt = el('ovExempt').checked;
        const target = el('ovTarget').value;
        const model = el('ovAll').checked ? '*' : (el('ovModel').value.trim() || target);
        if (!model) { showMessage('Pick a provider model, or type the id the client asks for.', 'bad'); return; }
        if (exempt && model === '*') { showMessage('The force route cannot be exempt from itself.', 'bad'); return; }
        if (!exempt && !target) { showMessage("Pick the provider's model first.", 'bad'); return; }
        try {
          await api('/admin/routing/models', {
            method: 'POST',
            body: JSON.stringify({
              tool: el('ovTool').value,
              model,
              providerId: exempt ? null : (el('ovProvider').value || null),
              targetModel: exempt ? null : target,
              exempt,
            }),
          });
          showMessage(exempt
            ? model + ' is now exempt — it stays on the tool\\'s own provider.'
            : (model === '*' ? 'all models' : model) + ' → ' +
              (providers.find(p => p.id === el('ovProvider').value)?.name || '?'), 'ok');
          el('ovModel').value = '';
          delete el('ovModel').dataset.touched;
          el('ovAll').checked = false;
          el('ovExempt').checked = false;
        } catch (e) {
          showMessage(e.message, 'bad');
        }
        loadData();
      }

      async function removeOverride(tool, model) {
        try {
          await api('/admin/routing/models', { method: 'POST', body: JSON.stringify({ tool, model, providerId: null }) });
          showMessage('Removed override for ' + (model === '*' ? 'all models' : model) + '.', 'ok');
        } catch (e) {
          showMessage(e.message, 'bad');
        }
        loadData();
      }

      async function addProfile() {
        const name = el('pfName').value.trim().toLowerCase();
        const providerId = el('pfProvider').value;
        const model = el('pfModel').value || null;
        if (!name) { showMessage('Give the profile a name — it becomes the URL segment.', 'bad'); return; }
        if (!providerId) { showMessage('Pick a provider.', 'bad'); return; }
        try {
          await api('/admin/profiles', { method: 'POST', body: JSON.stringify({ name, providerId, model }) });
          el('pfName').value = '';
          showMessage('Profile "' + name + '" ready — point a session at ' + location.origin + '/p/' + name + '.', 'ok');
        } catch (e) {
          showMessage(e.message, 'bad');
        }
        loadData();
      }

      async function removeProfile(name) {
        if (!confirm('Remove profile "' + name + '"? Sessions still using its URL will be refused.')) return;
        try {
          await api('/admin/profiles', { method: 'POST', body: JSON.stringify({ name, providerId: null }) });
          showMessage('Removed profile "' + name + '".', 'ok');
        } catch (e) {
          showMessage(e.message, 'bad');
        }
        loadData();
      }

      // Listeners are bound once here, not inside render(): re-binding on every
      // refresh would stack duplicate handlers and fire each action repeatedly.
      for (const tool of ['claude', 'codex', 'openai']) {
        el('route-' + tool).addEventListener('change', () => slotChange(tool));
        el('force-' + tool).addEventListener('change', () => forceModelChange(tool));
      }
      el('fallbackToggle').addEventListener('change', toggleFallback);
      el('useAllBtn').addEventListener('click', useForAll);
      el('refreshRoutingBtn').addEventListener('click', loadData);
      el('ovAddBtn').addEventListener('click', addOverride);
      el('ovTool').addEventListener('change', renderOverrides);
      el('ovProvider').addEventListener('change', renderOverrideTargets);
      el('ovTarget').addEventListener('change', syncOverrideClientModel);
      el('ovModel').addEventListener('input', (e) => { e.target.dataset.touched = '1'; updateOverrideForm(); });
      el('ovModel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOverride(); } });
      el('ovAll').addEventListener('change', updateOverrideForm);
      el('ovExempt').addEventListener('change', updateOverrideForm);
      el('overrideList').addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-ov-model]');
        if (btn) removeOverride(btn.dataset.ovTool, btn.dataset.ovModel);
      });
      el('seenList').addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-seen-model]');
        if (!btn) return;
        el('ovTool').value = btn.dataset.seenTool;
        el('ovAll').checked = false;
        const input = el('ovModel');
        input.value = btn.dataset.seenModel;
        input.dataset.touched = '1';
        renderOverrides();
        showMessage('Loaded "' + btn.dataset.seenModel + '" into the override form (nothing saved yet) — pick the provider and its model, then Add.', 'ok');
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      el('pfAddBtn').addEventListener('click', addProfile);
      el('pfName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addProfile(); } });
      el('pfProvider').addEventListener('change', renderProfileModels);
      el('profileList').addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-pf-name]');
        if (btn) removeProfile(btn.dataset.pfName);
      });

      loadData();
      })();
    </script>
  `;

  return renderLayout(content, 'routing');
}
