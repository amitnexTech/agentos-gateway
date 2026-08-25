# Index — docs home, start here, table of contents

Entry point for this project's docs. Every doc should be reachable from here
(directly or via other docs' wiki-links).

**Status:** REFERENCE

## How these docs work

- One doc per topic, kebab-case filename, split past ~15 KB.
- Every doc: H1 with aliases, purpose line, one **Status:** line, a closing
  `## Related` with at least one wiki-link.
- Create new docs with `kh-search new <name>`; check health with
  `kh-search lint`.

## Docs

- [[architecture]] — gateway design, directory structure, provider types, adapter hierarchy, tool-slot routing/resolution, key features
- [[session-profiles]] — per-session model routing: parallel sessions on different models, selected by a `/p/<name>` base URL
- [[protocol-bridge]] — OpenAI Chat ↔ Anthropic Messages translation both ways, streaming maps, what is dropped vs refused, cross-protocol routing
- [[kiro-integration]] — Kiro provider, account management, auth model, model aliasing, connect-timeout fix
- [[codex-integration]] — Codex `/v1/responses` non-Kiro path: Responses↔Chat-Completions translation, freeform tools, synthetic SSE reconstruction
- [[security]] — dashboard auth, loopback binding, admin token, why /v1 stays unauthenticated
- [[cost-and-context]] — Kiro credit/token measurement, context-window visibility, model-swap detection signals
- [[spend-tracking]] — the permanent usage record: monthly tokens and cost by project, provider and model, and how a request is attributed to a project
- [[fallback-and-verification]] — auto-fallback design, CLI verification rules, capture-real-traffic playbook

Not in the repo: `docs/provider-findings.md` holds per-vendor reliability and pricing notes. It is gitignored — it names specific resellers and dates quickly, so it stays a local file rather than shipping with the code.

See also `AGENTS.md` (architecture summary for agents) and `CLAUDE.md` (operational: what's running, what not to delete, build/run commands) in the repo root.
