# pacer Constitution

Status: Amendment 0.18.0 (Orca executor extraction) proposed; amendment 0.17.0 (paired machines) proposed; amendment 0.16.0 (Rust front door and coexistence) proposed; amendment 0.15.0 (agent work routing) proposed; amendment 0.14.0 (scoped work delegation) proposed; amendment 0.13.0 (UI readiness procedure and preflight) proposed; amendment 0.12.0 (spacing ownership) proposed; amendment 0.11.0 (affected-area CI selection) proposed; amendment 0.10.0 (portable skills and mandatory project review) proposed; amendment 0.9.0 (compact UI density) proposed; amendment 0.8.0 (plugin system: P13–P15) proposed; amendment 0.7.0 (Rust crate structure and size rules) proposed; amendment 0.6.0 (automated releases) proposed; established rules remain in force. The maintainer adopts the amendment by merging its PR. Amendment 0.5.0 was adopted on 2026-10-20 by merging #209; amendment 0.4.0 on 2026-10-19 by merging #193. | Version: 0.18.0 | Updated: 2026-10-31
Decision authority: the single maintainer, @lamtuanvu ([GOVERNANCE.md](../GOVERNANCE.md), [.github/CODEOWNERS](../.github/CODEOWNERS)). AI reviewers give advice; they do not approve.

## Purpose and scope

pacer routes and paces AI coding work across subscription budgets. A planner agent plans and reviews. pacer delegates execution to executor agents (Codex, OpenCode endpoints and others), tracks usage and pace per account, and supervises delegated runs. Delegated runs can execute locally, in Orca worktrees, on SSH remote hosts or on paired pacer machines. See [README.md](../README.md) and [docs/specs/2026-10-11-pacer-design.md](../docs/specs/2026-10-11-pacer-design.md).

In scope:
- The `pacer` CLI and the local service (`pacer serve`), with its HTTP, SSE, WebSocket, stdio JSON-RPC and MCP APIs.
- Usage readers, routing and pacing, task supervision, and remote runners.
- The thin clients: the web app and tray popover, the TUI, and the Tauri desktop shell. Orca remains a supported execution host (Orca worktrees and terminals), not a client surface.
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
| P1 | `pacer serve` owns all work. Every surface (CLI, TUI, web/tray, desktop) is a thin client of the versioned API. A missing capability is first added to the core and exposed as an operation or event. | `src/`, `app/`, `desktop/` | [ADR clients-over-local-service](../docs/decisions/2026-10-16-clients-over-local-service.md) D1–D2 | Established |
| P2 | Operations must be safe with several clients at once. Concurrent conflicting changes return a `conflict` error. | `src/api/`, `src/serve/` | same ADR | Established |
| P3 | Neither the planner role nor the host is fixed. Nothing may hard-code Claude as the planner or Orca as the host. | all | same ADR; [ROADMAP.md](../ROADMAP.md) | Established |
| P4 | The protocol stays backward compatible. Additive fields need no version bump, and clients ignore unknown fields. Removing or renaming a field needs a major protocol bump, and the previous major is still served for one pacer minor release. | `src/api/`, `docs/protocol*.md` | [docs/protocol.md](../docs/protocol.md) | Established |
| P5 | Secrets are handled by reference. Native tool credentials are never read or copied. Endpoint keys never appear in config, logs, events or API results. | `src/endpoints/`, `src/usage/`, `src/remote/`, `src/install/` | [docs/accounts.md](../docs/accounts.md), [SECURITY.md](../SECURITY.md) | Established |
| P6 | The local service binds only to loopback and authenticates every request. Write requests also need Origin plus `X-Pacer-Client`. There is no CORS. | `src/serve/`, `app/`, `desktop/` | [ADR app-web-ui](../docs/decisions/2026-10-15-app-web-ui.md), [docs/protocol.md](../docs/protocol.md) | Established |
| P7 | Retired (0.5.0). Was: the Orca plugin panel only shows information. The Orca plugin is removed. | — | [ADR retire-orca-plugin](../docs/decisions/2026-10-20-retire-orca-plugin.md) | Retired (0.5.0) |
| P8 | `src/core` never imports `src/exec/orca`. **Proposed 0.18.0 replacement:** `src/core` never imports the Orca execution adapter or `plugins/pacer-exec-orca`; Orca execution is reached through host-neutral executor interfaces. | `src/`, `plugins/` | `test/core-boundaries.test.ts`; [ADR 0018](../docs/decisions/0018-orca-terminal-worker-executor-extraction.md) | Established boundary; replacement proposed until maintainer merge |
| P9 | The repository is public. Agent working files stay under the untracked `.work/`. Tracked files hold no machine-specific paths and no personal emails. | all tracked files | [AGENTS.md](../AGENTS.md) | Established |
| P10 | Contributions are signed off under the DCO and use Conventional Commit PR titles. PRs are squash-merged. | all PRs | [CONTRIBUTING.md](../CONTRIBUTING.md), `.github/workflows/pr-title.yml` | Established |
| P11 | Generated artifacts (protocol docs, embedded app assets, design tokens) are committed fresh, and tests fail when they are stale. | `scripts/`, `src/app/assets.generated.ts`, `docs/protocol*.md` | CONTRIBUTING.md, `test/api-protocol-doc.test.ts` | Established |
| P12 | Durable architectural choices are recorded in `docs/decisions/`. | design changes | [GOVERNANCE.md](../GOVERNANCE.md) | Established |
| P13 | The host is minimal. Every capability a plugin could provide is a plugin against the versioned plugin protocol; bundled reference plugins are the open implementations, and the host never falls back to a built-in once an adapter is extracted. **Proposed Rust front-door addition (amendment 0.16.0):** From M1, the host entry point is a Rust binary; the TypeScript core runs as its child during M1/M2 until M2 completes ([ADR 0004](../docs/decisions/0004-rust-front-door-and-coexistence.md)). | `src/plugins/`, `plugins/`, adapters | [ADR plugin-host-and-rust-strangler](../docs/decisions/2026-10-19-plugin-host-and-rust-strangler.md) D1–D2 | Established |
| P14 | The plugin protocol is versioned under the same compatibility rule as the client protocol (P4) and generated from zod schemas with a freshness test (P11). | `src/plugins/protocol.ts`, `docs/plugin-protocol*.{md,json}` | same ADR | Established |
| P15 | The host never checks entitlements. A commercial plugin verifies its own license and reports status through `entitlement.report`; `tier` is informational. | `src/plugins/` | same ADR D3–D4 | Established |

## Scoped conventions and ownership

Canonical rule and reviewer index: [.project/context.md](context.md).
The maintainer owns every path (`* @lamtuanvu`). The dependency direction is: clients → API (`src/api`) → host core (`src/core`, `src/engine`, `src/tasks`, …) → plugin protocol (`src/plugins`) → plugins (`plugins/`, installed plugins). Adapters not yet extracted stay under the core until their sub-project moves them.

## Validation and review agreements

Established checks, run in CI on every PR and on pushes to `main` ([.github/workflows/ci.yml](../.github/workflows/ci.yml)):
- `bun run typecheck`, `bun run test` and `bun run build`, on ubuntu and macOS.
- Amendment 0.4.0 adds `bun run ui:check` to the same CI job: every authored app TS/TSX/CSS subtree, including shell, terminal and tray, is checked without a violation baseline.
- Gitleaks over the full history.
- CodeQL for JS/TS.
- The Conventional Commit PR title check.

Established before a release:
- `release.yml` verifies that the tag matches `package.json` and smoke-tests every native binary.
- Live tests on remote hosts need separate maintainer approval (ADR remote-hosts-ssh).

The maintainer's approval is the merge decision. Reviewers identify violations and evidence; they cannot approve a merge, grant an exception or accept an amendment.

**Amendment 0.4.0 — mandatory UI compliance and review evidence (adopted 2026-10-19 by merging #193):**

- A UI-affecting change (web/tray, TUI/status rendering or desktop presentation) must include an implementer compliance report against UI-1–UI-25, with applicable rule IDs, component/catalog and provenance changes, command results and evidence locations. Mark non-applicable rules with a reason.
- Independent UI/accessibility and QA reviewer reports are required evidence before the maintainer merges a UI-affecting change. They name the reviewed base/head and governance version, actual checks/evidence, unresolved findings with severity/remedy, and every **UNVERIFIED** surface or behavior. A checkbox or a statement that a review ran is not a report.
- UI-18 screenshots and CT-11 live evidence remain required for their applicable scopes. Missing reports, unresolved required-rule violations, FAIL or UNVERIFIED required behavior block a claim of completion and must be resolved before merge, unless the maintainer records a scoped, expiring exception in decisions.md. Reviewer recommendations remain advisory; required evidence and established-rule compliance are mandatory.
- CI enforces source/token/import checks and tests of negative fixtures. The PR's UI evidence contract is checked on pull requests with changed UI files; it requires compliance, UI and QA report references and reported verdicts. This checks the report manifest, not the truth of visual evidence: the maintainer examines the linked reports and actual artifacts before merging. CI cannot substitute for browser/native/live validation or human review.
- Draft PRs still require valid current-SHA reports, links and honest PASS/FAIL/UNVERIFIED summaries, while source checks and tests run normally. Passing draft CI does not certify completion. All three report verdicts must be PASS once the PR is ready for review; CI reruns on `ready_for_review` and `converted_to_draft`. Draft status never waives the before-merge evidence requirements above.

Other reviewers remain advisory. This amendment changes no remote branch protection and gives no bot approval authority.

**Amendment 0.5.0 — retire the Orca plugin (adopted 2026-10-20 by merging #209):**

- The Orca plugin (worker, panel, marketplace manifest, `orca-plugin` branch and tags) is removed. The Orca execution backend (`src/exec/orca`, Orca accounts) stays. See [ADR retire-orca-plugin](../docs/decisions/2026-10-20-retire-orca-plugin.md).
- Retired: P7, ARCH-6, UI-5, REL-4, REL-7 and CT-10. Their IDs stay reserved and are not reused.
- Narrowed: P8 and ARCH-4 keep only "`src/core` never imports `src/exec/orca`". P11 and CT-5 no longer cover plugin `dist/` or `plugin:build`. Client lists and Applies-to lines no longer name the Orca panel or `orca-plugin/**`.

**Amendment 0.6.0 — automated releases (proposed; adopted only by the maintainer merging this amendment PR):**

- REL-2 now describes the automated flow. The maintainer runs **Prepare release** on `main` (bump `auto`, `patch`, `minor` or `major`). It picks the version from Conventional Commit titles since the last tag, runs `release:prepare`, opens the `chore: release x.y.z` PR, dry-runs that branch and turns on auto-merge only after the dry run passes. When the PR merges, **Release tag** creates the annotated tag `vx.y.z` at the merge commit, which runs `release.yml`. The manual flow stays as a fallback.
- Running Prepare release is the maintainer's merge decision for that release PR. Auto-merge still waits for every required check, and only users with write access can dispatch the workflow. This gives no bot approval authority over any other PR.
- UI-24 does not apply to a PR whose UI-scoped changes are only version strings (`"version": "x.y.z"` and `APP_VERSION`). CI verifies every changed line of every UI-scoped file before exempting it; any other UI change in the same PR needs the full reports.
- Release writes use the repository secret `RELEASE_TOKEN`, a fine-grained token scoped to this repository (Contents, Pull requests and Workflows: read and write), because GitHub does not run workflows for `GITHUB_TOKEN` pushes. Tags are never moved, and a version whose tag exists is never re-tagged.

**Amendment 0.9.0 — compact UI density (proposed; adopted by maintainer merge):**

- UI-26 makes compact the desktop default for shared controls and recurring rows.
- The top-bar Delegate is the visual reference; buttons, dropdowns and inputs use shared density tokens. Settings retain shared form density; touch targets and multiline fields retain their useful size.
- Changes belong in shared DS primitives/tokens and layout spacing, with browser geometry and before/after evidence. Existing accessibility and review requirements remain in force.

**Amendment 0.12.0 — spacing ownership (proposed; adopted only by maintainer merge):**

- UI-27 assigns child spacing to shared layout gaps, eliminating compounded browser/child margins and inconsistent grouping of related rows.
- The existing 8px/12px/24px token scale expresses related/content/section spacing; DS owns disclosure geometry and responsive targets.
- Consumer CSS may not override shared layout spacing. Source checks and browser geometry regressions complement the existing UI-18, UI-24 and CT-11 evidence requirements.
- This amendment adds a rule; it grants no validation exception and changes no API or architecture boundary.

## Amendment 0.16.0 — Rust front door and coexistence

Proposed; adopted only by the maintainer merging this amendment PR.

- Extend P13 with the Rust entry point and supervised TypeScript child during M1/M2. Existing minimal-host and plugin constraints remain established; this addition does not claim unfinished plugin extraction is complete.
- Add ARCH-15 and ARCH-16 for public transport ownership, transparent forwarding and durable shared-state protocols. Existing ARCH-13 and ARCH-14 retain their plugin meanings.
- Record native listener transfer, Root-owned immutable helper spawning, paired packaging and the complete-app repair boundary in [ADR 0004](../docs/decisions/0004-rust-front-door-and-coexistence.md). Authenticated private IPC remains permitted; durable state retains the established file/lock and SQLite contracts.
- Adoption records the architecture, not M1 completion, crate publication, release approval or live validation success. CT-11 and all established security, protocol, UI, release and evidence requirements remain in force. Missing required behavior remains FAIL or UNVERIFIED until resolved or covered by a maintainer-recorded scoped exception.

## Workflow choice

No development workflow is mandated. Contributors may use Superpowers, SpecKit, dev-cycle, a custom workflow or direct work. Workflow artifacts follow AGENTS.md: plans and reviews go in `.work/`, specs in `docs/specs/`, ADRs in `docs/decisions/`.
Project context and the applicable rules travel with the chosen workflow's artifacts. This constitution does not require any pipeline.

## Amendment 0.10.0 — portable skills and completion review

Proposed for adoption by maintainer merge; the maintainer explicitly authorized
this setup and review loop for the current task on 2026-10-24.

Repository-local skills under `.agents/skills/` expose governance and project
review without a global installation. `AGENTS.md` references their paths for
agents without discovery; Claude adapters share the same source instructions.

REPO-10 requires independent review of every changed work product before delivery
as complete, resolution of confirmed blockers, affected revalidation and independent
review of fixes against final content. Review evidence lives under `.work/reviews/`
and is summarized in the result and PR. Missing review or unmet required behavior
is incomplete/UNVERIFIED. Specialist selection stays scoped; reviews do not grant
human approval. Existing UI and live validation gates remain unchanged. No new CI
check or remote branch protection is introduced by this amendment.

## Amendment 0.11.0 — affected-area CI

Proposed for adoption by maintainer merge; authorized for the current CI task by
the maintainer on 2026-10-24. The blanket CI list above is scoped by the affected
areas documented in [CI selection](../docs/testing/ci-selection.md). A shared
classifier selects Bun, Rust, e2e, UI evidence and CodeQL jobs. Unknown inputs or
unresolvable diffs select full validation. Required Test check names and their
UI/release evidence gates remain; failures in change detection fail those gates.
Full-history secret scanning and complete release validation remain unchanged.
Scheduled/manual CodeQL remains full; Rust build timings move to affected main
pushes. No branch protection setting or local CT-11 completion rule is relaxed.

## Amendment 0.13.0 — UI readiness procedure and preflight

Proposed for adoption by maintainer merge; authorized for the current task on
2026-10-24. The canonical UI-24 readiness procedure lives in
[rules/ui.md](rules/ui.md#ui-review-readiness-procedure). Governance/review skills
and the PR template link to it; AGENTS.md stays a lean entry point.

Agents preflight prepared/current PR metadata using the shared CI validator,
keep incomplete evidence in drafts, refresh actual reports after revision changes,
and confirm current-head readiness CI before completion. Local source-only
success is not evidence validation. The CLI is read-only and never rewrites
report SHAs or verdicts. Existing report, screenshot, live-validation and scoped
exception requirements remain; no CI or branch protection gate is relaxed.
Stale 0.4.0 proposal labels are corrected to its recorded adoption by #193.

## Amendment 0.14.0 — scoped work delegation

Proposed for adoption by maintainer merge; implementation for the current dispatcher task was explicitly authorized on 2026-10-25. API-5 permits an executor to create and manage child work only through a service-issued grant bound to its running task and attempt. The service derives parent identity and enforces subtree, repository, capability, depth, concurrency and lifetime constraints. A grant never authorizes global operations, self-review or free-form shell execution. Executor sessions without a valid grant remain unable to delegate. This amendment changes no other authentication or protocol compatibility rule.

## Amendment 0.15.0 — agent work routing

Proposed; adopted when the maintainer merges it. It adds REPO-11 to REPO-14 to [rules/repository.md](rules/repository.md#repo-11-to-repo-14-agent-work-routing): delegate execution through pacer as the mode requires, use the smallest capable model tier for work on the planner's side, record the choice in every brief and report, and keep executor state in a sandbox. The rules name no particular planner or vendor (P3). They don't relax REPO-10, CT-11, the UI evidence gates or the maintainer's merge authority.

## Amendment 0.17.0 — paired machines

Proposed; adopted only by the maintainer merging this amendment PR. It records the host side of execution on paired pacer machines, as described in the [machine peers spec](../docs/specs/2026-10-28-machine-peers-design.md), [ADR 0012](../docs/decisions/0012-machine-identity-and-paired-execution.md) and [ADR 0013](../docs/decisions/0013-lan-discovery-and-pairing-hand-over.md).

- The purpose-and-scope line adds paired pacer machines to local, Orca and SSH execution. A task runs on, and is owned by, the machine whose runner executes it.
- ARCH-7 narrows to SSH host runners. Execution on a paired machine is a second model next to it, in which the remote machine runs pacer.
- SEC-11 to SEC-16 are added to [rules/security.md](rules/security.md): presence-only discovery, plugin-owned peer listeners, tiered peer credentials, the one-hop rule, domain-separated signing and untrusted discovered values. Its "Applies to" line gains `src/plugins/**`, `src/identity/**`, `src/discovery/**` and `$PACER_HOME/identity/**`.

SEC-1, SEC-2, SEC-3 and SEC-6 are unchanged. SEC-3 governs the service's API listener; SEC-11 is the only non-loopback socket the open host opens. The amendment names no plugin; pairing is described as a host feature that plugins provide. It doesn't relax REPO-10, CT-11 or the maintainer's merge authority.

## Amendment 0.18.0 — Orca executor extraction

Proposed; adopted only when the maintainer merges this amendment PR. ARCH-4 and P8 name the plugin boundary after the Orca backend is extracted. `src/plugins/` may implement task-owned Orca capability and cleanup brokers; `src/core` may not import Orca-specific modules. The bundled `pacer-exec-orca` implements the existing #461 terminal-worker flow with pacer's composed unattended launch command and exact host-owned identity and closure checks. See [ADR 0018](../docs/decisions/0018-orca-terminal-worker-executor-extraction.md).

This amendment does not revive the retired Orca panel (P7 and ARCH-6), waive SEC-5 or CT-11, or claim extraction is complete before validation. Until adoption, the existing `src/core` to `src/exec/orca` boundary remains established.

## Amendment and exception policy

Amendments are made by a PR that edits this file or a rule file. Use a `docs:` title, bump the version here, and add an entry to [decisions.md](decisions.md). The maintainer accepts or rejects it. A proposed rule becomes established only when the maintainer accepts it. An exception to an established rule is recorded in decisions.md with its scope and expiry; a reviewer cannot grant one. Architectural decisions still get an ADR under `docs/decisions/`, and decisions.md links to it.
Decision history: [.project/decisions.md](decisions.md)

## Open decisions

See "Open decisions" in [decisions.md](decisions.md). In short:
- ADR file naming.
- Lint and format; Rust CI (required from milestone M1 of the plugin system).
- A target release for removing `/v2`.
- Which additional review evidence, beyond the proposed mandatory UI/QA evidence, should become required (OD-6).
- Cleanup of stale docs and ADRs.
