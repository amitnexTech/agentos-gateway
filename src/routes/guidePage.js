// Setup guide: how to point a coding agent at this gateway.
//
// Rendered from the gateway's own live state rather than hardcoded, because the
// port, the admin token and the list of session profiles all differ per machine
// and a guide that says "9000" on a gateway running on 9004 is worse than none.
// The snippets are copy-buttons, not prose, since every one of them is something
// you paste into a config file or shell.

import { renderLayout } from "./layoutTemplate.js";

// One client's setup: the fields differ enough (env var vs TOML, /v1 or not) that
// a shared template would hide the part that actually matters.
function clientCard({ id, title, subtitle, rows, note }) {
  const body = rows
    .map(
      (r) =>
        '<div class="guide-row">' +
        '<div class="guide-key">' +
        r.label +
        (r.hint ? '<div class="guide-hint">' + r.hint + "</div>" : "") +
        "</div>" +
        '<div class="guide-val">' +
        '<code class="mono" data-copy-text="' + escapeAttr(r.value) + '">' + escapeHtml(r.value) + "</code>" +
        '<button type="button" class="copy-btn" data-copy-for="' + escapeAttr(r.value) + '">Copy</button>' +
        "</div>" +
        "</div>"
    )
    .join("");
  return (
    '<section id="' + id + '">' +
    '<div class="section-head"><h2>' + title + "</h2>" +
    (subtitle ? '<span class="pill">' + subtitle + "</span>" : "") +
    "</div>" +
    '<div class="section-body">' + body +
    (note ? '<div class="guide-note">' + note + "</div>" : "") +
    "</div></section>"
  );
}

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(v) {
  return escapeHtml(v).replaceAll('"', "&quot;");
}

export function renderGuidePage({ port, host, adminToken, profiles = [] } = {}) {
  const p = port || 9000;
  const originBase = "http://localhost:" + p;
  // The token is already visible to anyone who got past the Basic prompt, so
  // showing it here leaks nothing new — and it is the one value people cannot
  // guess when scripting against the admin API.
  const token = adminToken || "(run the gateway to generate one)";

  const profileRows = profiles.length
    ? profiles
        .map(
          (name) =>
            '<div class="guide-row">' +
            '<div class="guide-key"><span class="mono">' + escapeHtml(name) + "</span></div>" +
            '<div class="guide-val">' +
            '<code class="mono" data-copy-text="' + escapeAttr(originBase + "/p/" + name) + '">' +
            escapeHtml(originBase + "/p/" + name) + "</code>" +
            '<button type="button" class="copy-btn" data-copy-for="' + escapeAttr(originBase + "/p/" + name) + '">Copy</button>' +
            "</div></div>"
        )
        .join("")
    : '<div class="empty">No session profiles yet. Create one on the <a href="/admin/routing-panel">Routing</a> page to give a single session its own provider and model.</div>';

  const content = `
    <section>
      <div class="section-head">
        <h2>What this gateway is</h2>
        <span class="pill">${escapeHtml(host || "127.0.0.1")}:${p}</span>
      </div>
      <div class="section-body">
        <p class="guide-lead">One local endpoint that every coding agent can point at. You choose
        which provider and model actually serves each tool on the
        <a href="/admin/routing-panel">Routing</a> page, so switching models becomes a dropdown
        change instead of editing each agent's config again.</p>
        <div class="guide-facts">
          <div><span class="guide-fact-label">Bound to</span><span class="mono">${escapeHtml(host || "127.0.0.1")}</span>
            <div class="guide-hint">Loopback only. Set <span class="mono">HOST</span> to expose it on the LAN — read <span class="mono">docs/security.md</span> first.</div></div>
          <div><span class="guide-fact-label">Client auth</span><span class="mono">none on /v1</span>
            <div class="guide-hint">Agents need no gateway key; the gateway holds the provider keys. Most clients still insist on <em>some</em> value, so pass any dummy string.</div></div>
          <div><span class="guide-fact-label">Dashboard auth</span><span class="mono">Basic — any user</span>
            <div class="guide-hint">Password is the admin token below. Only <span class="mono">/admin</span> is protected.</div></div>
        </div>
      </div>
    </section>

    ${clientCard({
      id: "claude",
      title: "Claude Code",
      subtitle: "/v1/messages",
      rows: [
        { label: "ANTHROPIC_BASE_URL", value: originBase, hint: "No <span class='mono'>/v1</span> — the client appends it itself." },
        { label: "ANTHROPIC_API_KEY", value: "dummy", hint: "Any non-empty string. The gateway ignores it and uses the routed provider's key." },
      ],
      note:
        "Put these in <span class='mono'>.claude/settings.json</span> under <span class='mono'>env</span> to scope them to one repo, " +
        "or export them for every session. A project-level file wins over the user-level one, which is how different repos can use different profiles.",
    })}

    ${clientCard({
      id: "codex",
      title: "Codex CLI",
      subtitle: "/v1/responses",
      rows: [
        { label: "base_url", value: originBase + "/v1", hint: "Codex needs the <span class='mono'>/v1</span> spelled out — unlike Claude Code." },
        { label: "env_key", value: "dummy", hint: "Any value; same reason as above." },
      ],
      note:
        "Goes in <span class='mono'>~/.codex/config.toml</span> under a provider entry. " +
        "Codex reads stdin, so a scripted <span class='mono'>codex exec</span> hangs unless you redirect <span class='mono'>&lt; /dev/null</span>.",
    })}

    ${clientCard({
      id: "openai",
      title: "Anything OpenAI-compatible",
      subtitle: "/v1/chat/completions",
      rows: [
        { label: "Base URL", value: originBase + "/v1", hint: "Cursor, Zed, aider, LangChain, the OpenAI SDKs." },
        { label: "API key", value: "dummy", hint: "Any value." },
      ],
      note:
        "The gateway translates between OpenAI and Anthropic formats in both directions, so an " +
        "OpenAI-shaped client can be served by an Anthropic provider and vice versa.",
    })}

    <section>
      <div class="section-head">
        <h2>Session profiles</h2>
        <span class="pill">${profiles.length ? profiles.length + " active" : "none"}</span>
      </div>
      <div class="section-body">
        <p class="guide-lead">The routing above is global — every session follows it. A profile is the
        same pairing scoped to <strong>one session</strong>, selected by the base URL that session
        starts with, so parallel sessions can run different models: backend on one, docs on another.</p>
        ${profileRows}
        <div class="guide-note">Claude Code takes the URL as-is; for Codex and OpenAI clients add
        <span class="mono">/v1</span> to the end. A profile whose provider was deleted answers 404
        rather than quietly falling back to the default account.</div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Admin API</h2>
        <span class="pill">scripting</span>
      </div>
      <div class="section-body">
        <div class="guide-row">
          <div class="guide-key">Admin token
            <div class="guide-hint">Stored in <span class="mono">data/.env</span>, generated on first boot.</div>
          </div>
          <div class="guide-val">
            <code class="mono" data-copy-text="${escapeAttr(token)}">${escapeHtml(token)}</code>
            <button type="button" class="copy-btn" data-copy-for="${escapeAttr(token)}">Copy</button>
          </div>
        </div>
        <div class="guide-row">
          <div class="guide-key">Read current routing
            <div class="guide-hint">Username is ignored; the token is the password.</div>
          </div>
          <div class="guide-val">
            <code class="mono" data-copy-text="${escapeAttr("curl -su any:" + token + " " + originBase + "/admin/routing")}">curl -su any:&lt;token&gt; ${escapeHtml(originBase)}/admin/routing</code>
            <button type="button" class="copy-btn" data-copy-for="${escapeAttr("curl -su any:" + token + " " + originBase + "/admin/routing")}">Copy</button>
          </div>
        </div>
        <div class="guide-note">These paths return JSON, not HTML:
          <span class="mono">/admin/routing</span>, <span class="mono">/admin/providers</span>,
          <span class="mono">/admin/routing/models</span>, <span class="mono">/admin/profiles</span>,
          <span class="mono">/admin/logs/data</span>, <span class="mono">/admin/spend/data</span>.
          The dashboard pages for routing and providers live on
          <span class="mono">-panel</span> URLs so these stay machine-readable.
          Any POST must send <span class="mono">Content-Type: application/json</span> — without it the
          body is ignored and a routing call will clear the slot instead of setting it.</div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>When something looks wrong</h2>
      </div>
      <div class="section-body">
        <div class="guide-trouble">
          <div><strong>An agent answers as the wrong model.</strong> Check the
            <a href="/admin/logs">log</a>'s "Model (req → resp)" column — it shows what was asked for
            and what replied. The response <span class="mono">model</span> field is rewritten by some
            vendors, so the log is the honest source.</div>
          <div><strong>Model choice in the client seems ignored.</strong> That is a force route doing its
            job: a model picked in a slot's dropdown on
            <a href="/admin/routing-panel">Routing</a> overrides what the client asks for. Set it back
            to "client decides" to hand control over.</div>
          <div><strong>403 for every model except one.</strong> The provider sells a single model and the
            client's own id is being forwarded. Force that model in the slot.</div>
          <div><strong>UI edits do not show up.</strong> The page modules load once at boot — restart the
            gateway.</div>
          <div><strong>Tool calls get interrupted on slow providers.</strong> Claude Code gives up after
            5 minutes of stream silence on a custom base URL. Raise
            <span class="mono">CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS</span>, and check whether the provider
            is registered as the type it natively speaks — a vendor's compatibility shim can be far
            slower than its native protocol.</div>
        </div>
      </div>
    </section>

    <script>
      // IIFE: separate classic <script> blocks share one global lexical scope,
      // so a top-level const here that also exists in the layout shell is a
      // redeclaration SyntaxError that kills the whole block silently.
      (function () {
        // Delegated listener rather than inline onclick: this file is a JS
        // template literal, so an escaped quote inside an attribute would reach
        // the browser as a bare quote and end the string early.
        document.addEventListener("click", async (ev) => {
          const btn = ev.target.closest("[data-copy-for]");
          if (!btn) return;
          const text = btn.getAttribute("data-copy-for");
          const done = (msg) => {
            const was = btn.textContent;
            btn.textContent = msg;
            setTimeout(() => { btn.textContent = was; }, 1200);
          };
          try {
            // navigator.clipboard needs a secure context; localhost counts, but a
            // LAN-exposed gateway over plain http does not, hence the fallback.
            if (navigator.clipboard && window.isSecureContext) {
              await navigator.clipboard.writeText(text);
              done("Copied");
              return;
            }
            throw new Error("insecure context");
          } catch (e) {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand && document.execCommand("copy");
            document.body.removeChild(ta);
            done(ok ? "Copied" : "Select manually");
          }
        });
      })();
    </script>

    <style>
      .guide-lead { margin: 0 0 14px; font-size: 13px; line-height: 1.55; color: var(--ink); }
      .guide-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
      .guide-facts > div { background: var(--field); border: 1px solid var(--line); border-radius: 7px; padding: 10px 12px; }
      .guide-fact-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
      .guide-row { display: grid; grid-template-columns: minmax(160px, 240px) 1fr; gap: 12px; align-items: start; padding: 10px 0; border-bottom: 1px solid var(--line); }
      .guide-row:last-of-type { border-bottom: 0; }
      .guide-key { font-size: 13px; font-weight: 600; }
      .guide-hint { font-weight: 400; font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.45; }
      .guide-val { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .guide-val code { background: var(--field); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; word-break: break-all; }
      .copy-btn { min-height: 28px; padding: 0 10px; font-size: 12px; }
      .guide-note { margin-top: 12px; padding: 10px 12px; background: var(--field); border: 1px solid var(--line); border-radius: 7px; font-size: 12px; color: var(--muted); line-height: 1.55; }
      .guide-trouble { display: grid; gap: 12px; font-size: 13px; line-height: 1.55; }
      .guide-trouble > div { padding-left: 12px; border-left: 3px solid var(--line); }
      .guide-trouble strong { display: block; margin-bottom: 2px; }
      @media (max-width: 640px) { .guide-row { grid-template-columns: 1fr; gap: 6px; } }
    </style>
  `;

  return renderLayout(content, "guide");
}
