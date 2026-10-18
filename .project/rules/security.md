# Security and secrets rules

Applies to: `src/serve/**`, `src/endpoints/**`, `src/usage/**`, `src/remote/**`, `src/exec/**`, `src/supervisor/**`, `src/session/**`, `src/install/**`, `src/update/**`, `src/service/**`, `desktop/**`, `orca-plugin/**`, `.github/workflows/**`. Also applies to any new subprocess, network listener, file write under `PACER_HOME`, or secret.
Out of scope: purely presentational UI changes that touch no auth or data flow.
Owner: @lamtuanvu
Canonical sources: [SECURITY.md](../../SECURITY.md), [docs/accounts.md](../../docs/accounts.md), [docs/protocol.md](../../docs/protocol.md), [ADR app-web-ui](../../docs/decisions/2026-10-15-app-web-ui.md), [ADR remote-hosts-ssh](../../docs/decisions/2026-10-15-remote-hosts-ssh.md), `desktop/src-tauri/capabilities/README.md`

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| SEC-1 | pacer never reads or copies the native credentials or Keychain entries of planner and executor tools. | Established | docs/accounts.md | Review `src/usage/**`, `src/install/**` |
| SEC-2 | Endpoint keys live in the macOS Keychain (service `pacer`), in `$PACER_HOME/secrets/<name>.key` (0600, dir 0700), or in env. They never appear in config, logs, events or API results, and are passed only to the child process as `PACER_KEY_<NAME>`. | Established | docs/accounts.md | Tests; grep the diff for key leakage |
| SEC-3 | The service binds to `127.0.0.1` only and checks the Host header (421 otherwise). Bearer auth uses a 0600 token compared in constant time. The app uses a cookie session from a single-use 60 s code (HttpOnly, SameSite=Strict). | Established | ADR app-web-ui; `src/serve/http.ts` | `test/serve-*` tests; review |
| SEC-4 | Non-GET app requests need a matching Origin and `X-Pacer-Client: app`. There is no CORS, bodies are capped at 256 KiB, and the app sends a CSP. | Established | docs/protocol.md; ADR app-web-ui | Tests; review |
| SEC-5 | Subprocesses get argument vectors, never shell strings built from user or API text. | Established | docs/protocol.md (API-5) | Review spawn sites |
| SEC-6 | SSH uses a BatchMode alias with `ConnectTimeout` and never copies credentials. A returned bundle is size- and identity-checked (≤ 50 MB, 1–500 commits). Live remote tests need separate maintainer approval. | Established | ADR remote-hosts-ssh; `src/remote/ssh.ts` | Tests; approval recorded |
| SEC-7 | Files with state or secrets are written atomically (temp file opened `wx`, then rename) with restrictive modes (0600 files, 0700 dirs). | Established | `src/activity/log.ts`, ADR app-web-ui | Review; tests |
| SEC-8 | Desktop has no static Tauri capabilities. Runtime capabilities are scoped to the exact service origin, and the CSP is `default-src 'self'`. | Established | desktop capabilities README | Review `desktop/src-tauri/**` |
| SEC-9 | CI actions are pinned to commit SHAs with `persist-credentials: false`. `pull_request_target` workflows never check out PR code. Gitleaks runs over the full history. | Established | `.github/workflows/*` | Review workflow diffs; CI |
| SEC-10 | Vulnerabilities are reported privately (GitHub Private Vulnerability Reporting), not in public issues. | Established | SECURITY.md | n/a |

Relevant reviewers: [security](../reviewers/security.md)
Exceptions and open decisions: none.
