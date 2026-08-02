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
- [[kiro-integration]] — Kiro provider, account management, auth model, model aliasing, connect-timeout fix
- [[codex-integration]] — Codex `/v1/responses` non-Kiro path: Responses↔Chat-Completions translation, freeform tools, synthetic SSE reconstruction
- [[security]] — dashboard auth, loopback binding, admin token, why /v1 stays unauthenticated
- [[cost-and-context]] — Kiro credit/token measurement, context-window visibility, model-swap detection signals
- [[fallback-and-verification]] — auto-fallback design, CLI verification rules, capture-real-traffic playbook
- [[provider-findings]] — Lumosel/Aerolink reliability and backend-switching findings

See also `AGENTS.md` (architecture summary for agents) and `CLAUDE.md` (operational: what's running, what not to delete, build/run commands) in the repo root.
