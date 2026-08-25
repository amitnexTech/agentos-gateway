import { renderLayout } from './layoutTemplate.js';

export function renderKiroPage() {
  const content = `
    <section>
      <div class="section-head">
        <h2>Kiro Account Management</h2>
        <button id="kiroAddBtn" type="button">Add Account</button>
      </div>
      <div class="section-body">
        <div id="kiroStatus" class="notice" style="display:none;margin-bottom:12px"></div>
        <form id="kiroAddForm" style="display:none;margin-bottom:16px;border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--field)">
          <div style="display:grid;gap:12px">
            <label>API Key (ksk_...)<input id="kiroKey" type="password" autocomplete="off" placeholder="ksk_..."></label>
            <label>Account name (optional)<input id="kiroName" autocomplete="off" placeholder="Production, Staging..."></label>
            <label>Credit budget (optional)<input id="kiroBudget" type="number" step="0.01" placeholder="Leave blank for unlimited"></label>
            <div style="display:flex;gap:8px">
              <button type="submit" class="primary">Add Account</button>
              <button type="button" id="kiroCancelBtn">Cancel</button>
            </div>
          </div>
        </form>
        <div id="kiroAccountsList"></div>
      </div>
    </section>

    <script>
      // IIFE: separate classic <script> blocks share one global lexical scope,
      // so a top-level const here that also exists in the layout shell is a
      // redeclaration SyntaxError that kills the whole block silently.
      (function () {
      const el = (id) => document.getElementById(id);
      const esc = (s) => String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
      const api = async (url, opts) => {
        const r = await fetch(url, opts);
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      };

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
        if (!apiKey) { el("kiroStatus").textContent = "API key required"; el("kiroStatus").style.display = "block"; return; }
        el("kiroStatus").textContent = "Validating key...";
        el("kiroStatus").style.display = "block";
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
          el("kiroStatus").textContent = "Added " + p.name + " — " + p.models.length + " models";
          el("kiroStatus").className = "notice ok";
          kiroShowForm(false);
          await loadKiroAccounts();
        } catch(e) {
          el("kiroStatus").textContent = "Failed: " + e.message;
          el("kiroStatus").className = "notice bad";
        }
      }

      let kiroAccounts = [];

      async function loadKiroAccounts() {
        try {
          const r = await fetch("/admin/kiro/accounts", { headers: { Accept: "application/json" } });
          if (!r.ok) throw new Error("the accounts endpoint answered " + r.status);
          const accounts = await r.json();
          kiroAccounts = accounts;
          if (!accounts.length) {
            el("kiroAccountsList").innerHTML = '<div class="empty">No Kiro accounts added yet.</div>';
            return;
          }
          el("kiroAccountsList").innerHTML = accounts.map(a => {
            let usage = "", bar = "";
            // Coerced rather than assumed: a missing number here throws inside
            // the map and surfaces as "failed to load accounts", blaming the
            // endpoint for what is really a rendering bug.
            const used = Number(a.usedCredits) || 0;
            if (a.creditBudget) {
              usage = used.toFixed(2) + " / " + a.creditBudget + " cr";
              const pct = Number(a.usedPercent) || 0;
              const color = pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--accent)";
              bar = '<div style="height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:4px"><div style="width:' + pct + '%;height:100%;background:' + color + '"></div></div>';
            } else {
              usage = used.toFixed(4) + " cr used";
            }
            const keyWarn = a.hasKey ? "" : '<span style="background:var(--bad);color:#fff;font-size:11px;padding:2px 6px;border-radius:4px">NO KEY</span>';
            return '<div style="background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px">' +
              '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
                '<div><div style="font-weight:600">' + esc(a.name) + '</div><div style="font-size:12px;color:var(--muted)">' + esc(a.region) + ' · ' + (a.modelCount || 0) + ' models</div></div>' +
                keyWarn +
              '</div>' +
              '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">' + usage + '</div>' +
              bar +
              '<div style="display:flex;gap:6px;margin-top:8px">' +
                '<button type="button" data-kiro-edit="' + a.id + '" style="font-size:12px;padding:4px 8px">Edit</button>' +
                '<button type="button" data-kiro-rotate="' + a.id + '" style="font-size:12px;padding:4px 8px">Replace key</button>' +
                '<button type="button" data-kiro-reset="' + a.id + '" style="font-size:12px;padding:4px 8px">Reset usage</button>' +
                '<button type="button" class="danger" data-kiro-del="' + a.id + '" style="font-size:12px;padding:4px 8px">Delete</button>' +
              '</div>' +
            '</div>';
          }).join("");
        } catch(e) {
          // Show the actual reason. The bare "Failed to load accounts" here hid a
          // TypeError thrown while rendering and read as an endpoint outage.
          el("kiroAccountsList").innerHTML =
            '<div class="empty" style="color:var(--bad)">Could not show accounts: ' + esc(e.message) + '</div>';
        }
      }

      async function kiroRotateKey(id) {
        const apiKey = prompt("Paste new Kiro API key (ksk_...):");
        if (!apiKey || !apiKey.trim()) return;
        el("kiroStatus").textContent = "Validating new key...";
        el("kiroStatus").style.display = "block";
        try {
          await api("/admin/kiro/account/" + id, { method: "PUT", body: JSON.stringify({ apiKey: apiKey.trim() }) });
          el("kiroStatus").textContent = "Key replaced";
          el("kiroStatus").className = "notice ok";
          await loadKiroAccounts();
        } catch(e) {
          el("kiroStatus").textContent = "Failed: " + e.message;
          el("kiroStatus").className = "notice bad";
        }
      }

      async function kiroResetCredits(id) {
        if (!confirm("Reset credit usage to zero?")) return;
        el("kiroStatus").textContent = "Resetting...";
        el("kiroStatus").style.display = "block";
        try {
          await api("/admin/kiro/account/" + id, { method: "PUT", body: JSON.stringify({ resetCredits: true }) });
          el("kiroStatus").textContent = "Usage reset";
          el("kiroStatus").className = "notice ok";
          await loadKiroAccounts();
        } catch(e) {
          el("kiroStatus").textContent = "Failed: " + e.message;
          el("kiroStatus").className = "notice bad";
        }
      }

      async function kiroEditAccount(id) {
        const a = kiroAccounts.find(x => x.id === id);
        if (!a) return;
        const current = a.name.replace(/^Kiro:\\s*/, "");
        const name = prompt("Account name:", current);
        if (name === null) return;
        const budgetIn = prompt("Credit budget (blank for unlimited):", a.creditBudget != null ? String(a.creditBudget) : "");
        if (budgetIn === null) return;

        const body = {};
        if (name.trim()) body.name = name.trim();
        const b = budgetIn.trim();
        if (b === "") body.creditBudget = null;
        else {
          const n = parseFloat(b);
          if (!isFinite(n) || n < 0) { alert("Budget must be positive"); return; }
          body.creditBudget = n;
        }
        el("kiroStatus").textContent = "Updating...";
        el("kiroStatus").style.display = "block";
        try {
          await api("/admin/kiro/account/" + id, { method: "PUT", body: JSON.stringify(body) });
          el("kiroStatus").textContent = "Account updated";
          el("kiroStatus").className = "notice ok";
          await loadKiroAccounts();
        } catch(e) {
          el("kiroStatus").textContent = "Failed: " + e.message;
          el("kiroStatus").className = "notice bad";
        }
      }

      async function kiroDeleteAccount(id) {
        const a = kiroAccounts.find(x => x.id === id);
        const label = a ? a.name : id;
        if (!confirm('Delete "' + label + '"? This cannot be undone.')) return;
        el("kiroStatus").textContent = "Deleting...";
        el("kiroStatus").style.display = "block";
        try {
          await api("/admin/kiro/account/" + id, { method: "DELETE" });
          el("kiroStatus").textContent = "Deleted " + label;
          el("kiroStatus").className = "notice ok";
          await loadKiroAccounts();
        } catch(e) {
          el("kiroStatus").textContent = "Failed: " + e.message;
          el("kiroStatus").className = "notice bad";
        }
      }

      el("kiroAddBtn").addEventListener("click", () => { el("kiroStatus").style.display = "none"; kiroShowForm(true); });
      el("kiroCancelBtn").addEventListener("click", () => { el("kiroStatus").style.display = "none"; kiroShowForm(false); });
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
      })();
    </script>
  `;

  return renderLayout(content, 'kiro');
}
