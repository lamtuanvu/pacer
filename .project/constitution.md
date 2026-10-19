# pacer Constitution

Status: Amendment 0.3.0 proposed; established rules remain in force. The maintainer adopts the amendment by merging its PR. | Version: 0.3.0 | Updated: 2026-10-19
Decision authority: the single maintainer, @lamtuanvu ([GOVERNANCE.md](../GOVERNANCE.md), [.github/CODEOWNERS](../.github/CODEOWNERS)). AI reviewers give advice; they do not approve.

## Purpose and scope

pacer routes and paces AI coding work across subscription budgets. A planner agent plans and reviews. pacer delegates execution to executor agents (Codex, OpenCode endpoints and others), tracks usage and pace per account, and supervises delegated runs. Delegated runs can execute locally, in Orca worktrees or on SSH remote hosts. See [README.md](../README.md) and [docs/specs/2026-10-11-pacer-design.md](../docs/specs/2026-10-11-pacer-design.md).

In scope:
- The `pacer` CLI and the local service (`pacer serve`), with its HTTP, SSE, WebSocket, stdio JSON-RPC and MCP APIs.
- Usage readers, routing and pacing, task supervision, and remote runners.
- The thin clients: the web app and tray popover, the TUI, the Orca plugin panel, and the Tauri desktop shell.
- Planner hook and config installers, plus distribution through GitHub releases, npm and Homebrew.

Out of scope (established):
- Reading or copying the native credentials or Keychain entries of planner and executor tools ([docs/accounts.md](../docs/accounts.md)).
- Running free-form text in a shell from an API operation ([docs/protocol.md](../docs/protocol.md)).
- Installing pacer or Bun on remote hosts ([ADR remote-hosts-ssh](../docs/decisions/2026-10-15-remote-hosts-ssh.md)).
- Assuming a particular planner or host.

External constraints:
- The repository is public and licensed Apache-2.0.
- Runtimes are Bun ≥ 1.4.2 and the Rust toolchain pinned for `desktop/`.
- Supported platforms are macOS and Linux, on arm64 and x64.

## Principles and boundaries

| ID | Agreement | Applies to | Evidence/source | Status |
|----|-----------|------------|-----------------|--------|
| P1 | `pacer serve` owns all work. Every surface (CLI, TUI, web/tray, Orca panel, desktop) is a thin client of the versioned API. A missing capability is first added to the core and exposed as an operation or event. | `src/`, `app/`, `orca-plugin/`, `desktop/` | [ADR clients-over-local-service](../docs/decisions/2026-10-16-clients-over-local-service.md) D1–D2 | Established |
| P2 | Operations must be safe with several clients at once. Concurrent conflicting changes return a `conflict` error. | `src/api/`, `src/serve/` | same ADR | Established |
| P3 | Neither the planner role nor the host is fixed. Nothing may hard-code Claude as the planner or Orca as the host. | all | same ADR; [ROADMAP.md](../ROADMAP.md) | Established |
| P4 | The protocol stays backward compatible. Additive fields need no version bump, and clients ignore unknown fields. Removing or renaming a field needs a major protocol bump, and the previous major is still served for one pacer minor release. | `src/api/`, `docs/protocol*.md` | [docs/protocol.md](../docs/protocol.md) | Established |
| P5 | Secrets are handled by reference. Native tool credentials are never read or copied. Endpoint keys never appear in config, logs, events or API results. | `src/endpoints/`, `src/usage/`, `src/remote/`, `src/install/` | [docs/accounts.md](../docs/accounts.md), [SECURITY.md](../SECURITY.md) | Established |
| P6 | The local service binds only to loopback and authenticates every request. Write requests also need Origin plus `X-Pacer-Client`. There is no CORS. | `src/serve/`, `app/`, `desktop/` | [ADR app-web-ui](../docs/decisions/2026-10-15-app-web-ui.md), [docs/protocol.md](../docs/protocol.md) | Established |
| P7 | The Orca plugin panel only shows information. The worker spawns nothing and touches no consoles. | `orca-plugin/` | [ADR orca-plugin-information-only](../docs/decisions/2026-10-15-orca-plugin-information-only.md) | Established |
| P8 | Core code reaches `orca-plugin/` only through `src/serve/panel.ts`. `src/core` never imports `src/exec/orca`. | `src/` | `test/core-boundaries.test.ts` | Established (enforced by test) |
| P9 | The repository is public. Agent working files stay under the untracked `.work/`. Tracked files hold no machine-specific paths and no personal emails. | all tracked files | [AGENTS.md](../AGENTS.md) | Established |
| P10 | Contributions are signed off under the DCO and use Conventional Commit PR titles. PRs are squash-merged. | all PRs | [CONTRIBUTING.md](../CONTRIBUTING.md), `.github/workflows/pr-title.yml` | Established |
| P11 | Generated artifacts (protocol docs, plugin `dist/`, embedded app assets, design tokens) are committed fresh, and tests fail when they are stale. | `scripts/`, `orca-plugin/dist/`, `src/app/assets.generated.ts`, `docs/protocol*.md` | CONTRIBUTING.md, `test/api-protocol-doc.test.ts` | Established |
| P12 | Durable architectural choices are recorded in `docs/decisions/`. | design changes | [GOVERNANCE.md](../GOVERNANCE.md) | Established |

## Scoped conventions and ownership

Canonical rule and reviewer index: [.project/context.md](context.md).
The maintainer owns every path (`* @lamtuanvu`). The dependency direction is: clients → API (`src/api`) → core (`src/core`, `src/engine`, `src/tasks`, …) → adapters (`src/exec`, `src/remote`, `src/usage`). Adapters do not import clients.

## Validation and review agreements

Established checks, run in CI on every PR and on pushes to `main` ([.github/workflows/ci.yml](../.github/workflows/ci.yml)):
- `bun run typecheck`, `bun run test` and `bun run build`, on ubuntu and macOS.
- Amendment 0.3.0 adds `bun run ui:check` to the same CI job: every authored app TS/TSX/CSS subtree, including shell, terminal and tray, is checked without a violation baseline.
- Gitleaks over the full history.
- CodeQL for JS/TS.
- The Conventional Commit PR title check.

Established before a release:
- `release.yml` verifies that the tag matches `package.json` and smoke-tests every native binary.
- [docs/testing/orca-e2e.md](../docs/testing/orca-e2e.md) applies before a plugin release.
- Live tests on remote hosts need separate maintainer approval (ADR remote-hosts-ssh).

The maintainer's approval is the merge decision. Reviewers identify violations and evidence; they cannot approve a merge, grant an exception or accept an amendment.

**Amendment 0.3.0 — mandatory UI compliance and review evidence (proposed; adopted only by the maintainer merging this amendment PR):**

- A UI-affecting change (web/tray, TUI/status rendering, Orca panel or desktop presentation) must include an implementer compliance report against UI-1–UI-25, with applicable rule IDs, component/catalog and provenance changes, command results and evidence locations. Mark non-applicable rules with a reason.
- Independent UI/accessibility and QA reviewer reports are required evidence before the maintainer merges a UI-affecting change. They name the reviewed base/head and governance version, actual checks/evidence, unresolved findings with severity/remedy, and every **UNVERIFIED** surface or behavior. A checkbox or a statement that a review ran is not a report.
- UI-18 screenshots and CT-11 live evidence remain required for their applicable scopes. Missing reports, unresolved required-rule violations, FAIL or UNVERIFIED required behavior block a claim of completion and must be resolved before merge, unless the maintainer records a scoped, expiring exception in decisions.md. Reviewer recommendations remain advisory; required evidence and established-rule compliance are mandatory.
- CI enforces source/token/import checks and tests of negative fixtures. The PR's UI evidence contract is checked on pull requests with changed UI files; it requires compliance, UI and QA report references and reported verdicts. This checks the report manifest, not the truth of visual evidence: the maintainer examines the linked reports and actual artifacts before merging. CI cannot substitute for browser/native/live validation or human review.

Other reviewers remain advisory. This amendment changes no remote branch protection and gives no bot approval authority.

## Workflow choice

No development workflow is mandated. Contributors may use Superpowers, SpecKit, dev-cycle, a custom workflow or direct work. Workflow artifacts follow AGENTS.md: plans and reviews go in `.work/`, specs in `docs/specs/`, ADRs in `docs/decisions/`.
Project context and the applicable rules travel with the chosen workflow's artifacts. This constitution does not require any pipeline.

## Amendment and exception policy

Amendments are made by a PR that edits this file or a rule file. Use a `docs:` title, bump the version here, and add an entry to [decisions.md](decisions.md). The maintainer accepts or rejects it. A proposed rule becomes established only when the maintainer accepts it. An exception to an established rule is recorded in decisions.md with its scope and expiry; a reviewer cannot grant one. Architectural decisions still get an ADR under `docs/decisions/`, and decisions.md links to it.
Decision history: [.project/decisions.md](decisions.md)

## Open decisions

See "Open decisions" in [decisions.md](decisions.md). In short:
- ADR file naming.
- Lint, format and Rust CI.
- A target release for removing `/v2`.
- Desktop versioning and signing.
- Which additional review evidence, beyond the proposed mandatory UI/QA evidence, should become required (OD-6).
- Cleanup of stale docs and ADRs.
