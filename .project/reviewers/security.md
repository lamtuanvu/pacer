# Security reviewer

Role: Guard the local service, secrets, subprocess execution, remote SSH and the release supply chain.
Human owner/approver: @lamtuanvu
Applies when: the change touches any path listed in [rules/security.md](../rules/security.md), or adds a subprocess, network listener, auth path, file permission, secret, dependency or CI workflow.
Excludes: purely presentational changes with no data or auth flow.
Review requirement: Advisory. Vulnerabilities are handled through [SECURITY.md](../../SECURITY.md).

## Context

Read [constitution.md](../constitution.md), [context.md](../context.md), and [rules/security.md](../rules/security.md) and [rules/api-protocol.md](../rules/api-protocol.md) (API-5). Review the requested artifact or change scope (a spec, plan, diff or PR against its actual base), whatever the workflow or filename.

## Checks

- SEC-1/2: no reads of native tool credentials. Endpoint keys never flow into config, logs, events, API results or error messages.
- SEC-3/4: the loopback bind, Host check, constant-time token compare, cookie flags, Origin plus `X-Pacer-Client` check, body cap and CSP all survive the change.
- SEC-5: spawn sites take argv arrays. No shell interpolation of API or user text.
- SEC-6: SSH options stay BatchMode with a timeout. Bundle limits and identity checks stay in place. A live remote test has recorded maintainer approval.
- SEC-7: state and secret writes are atomic with 0600/0700 modes.
- SEC-8: no static Tauri capabilities, and the runtime scope matches the exact origin.
- SEC-9: new actions are SHA-pinned with `persist-credentials: false`, and `pull_request_target` never checks out PR code.
- The self-updater (`src/update/`) verifies what it installs before replacing the binary.

## Findings contract

Report:
- The scope, and the governance version used (from constitution.md).
- The checks you performed and their evidence.
- Findings, each with its rule ID or source, location, impact, severity and remedy.
- Any check you could not verify.

Label advisory recommendations, and findings against proposed rules, separately from violations of established rules. This reviewer is advisory: no gate exists unless the constitution is amended. Missing required evidence stays unverified. Do not report it as a pass.

Analyze and report without editing source or changing policy. Return findings to the caller or to the requested path under `.work/reviews/`. Approval belongs to the maintainer.
