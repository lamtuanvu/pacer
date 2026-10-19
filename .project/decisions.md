# Governance decisions

This log holds dated governance decisions, exceptions and superseded rules. Architectural decisions keep their ADRs in [docs/decisions/](../docs/decisions/); entries here link to them.

## Log

| Date | Decision | Rules affected | Decided by | Source |
|------|----------|----------------|------------|--------|
| 2026-10-18 | Governance initialized in `.project/` (constitution 0.1.0). It imports existing agreements from AGENTS.md, CONTRIBUTING.md, GOVERNANCE.md, SECURITY.md, docs/protocol.md, the ADRs and CI workflows as established. New rules are labeled Proposed. All reviewers are advisory. | all | Drafted for the maintainer's review; not yet accepted | Governance initialization |
| 2026-10-18 | Live validation is part of done (CT-11). Agents run the live harness with real executors and record evidence before they report a behavior-changing task as complete. | CT-11, QA reviewer | @lamtuanvu | [harness spec](../docs/specs/2026-10-18-live-validation-harness-design.md) |
| 2026-10-19 | Visual craft rules UI-8 to UI-18 and an implementer checklist added to the UI rule; the UI reviewer checks them. Constitution 0.2.0. Merging the PR accepts them. | UI-8–UI-18, UI reviewer | @lamtuanvu (by merging the PR) | #134 (UI review of every app screen, 2026-10-19) |
| 2026-10-18 | 3.0 retired the Orca link transport. `/v2` is served through an adapter for one more minor release. | API-2, ARCH-10 | @lamtuanvu | #77; [ADR clients-over-local-service](../docs/decisions/2026-10-16-clients-over-local-service.md) addendum |

## Exceptions

None recorded.

## Open decisions

Each item awaits a decision from @lamtuanvu. Established rules stay in force in the meantime.

| ID | Question | Proposal | Impact if unresolved |
|----|----------|----------|----------------------|
| OD-1 | Accept this governance draft (constitution 0.1.0) and its proposed rules? | Accept as drafted, or amend specific rows | Proposed rules stay advisory |
| OD-2 | ADR file naming conflict: AGENTS.md says `NNNN-<title>.md`, but every ADR uses `YYYY-MM-DD-<title>.md` (REPO-8) | Make the date form canonical; update AGENTS.md | Agents may create inconsistently named ADRs |
| OD-3 | Adopt a TS linter and formatter, and add Rust fmt/clippy/test to PR CI (CT-9). Dependabot also ignores Cargo. | Biome for TS; a `desktop` job in ci.yml; a cargo ecosystem entry in dependabot | Style drift; Rust regressions caught only by the manual workflow |
| OD-4 | Target release for removing `/v2`, `protocol-v2.md` and `hello.previous` (API-7) | Name the next minor (0.3.0) in CHANGELOG | The compat window has no end date |
| OD-5 | Desktop versioning and signing (REL-8; clients ADR D5 open questions: bundled vs attached CLI, auth handoff, standalone tray, notification ownership) | Sync the desktop version in `release:prepare`; decide signing separately | Desktop artifacts carry a misleading 0.1.0 |
| OD-6 | Should any reviewer become a merge gate? (for example, the security reviewer for `src/serve/**`) | Keep all advisory for now | None; maintainer approval stays the gate |
| OD-7 | Clean up retired transport code and stale docs: `src/link/`, `src/console/`, the `link/consoles` watcher; the 2026-10-12 ADR's broken `../plans/` links and its "API → channel → bridge" text; outdated `autoConsole` and console fixtures in docs/testing (ARCH-10, REPO-9) | Remove the code, and mark the retired ADR sections superseded | Docs mislead contributors and agents |
| OD-8 | Commit types: AGENTS.md lists 5, while pr-title.yml allows 10 (REPO-5 takes pr-title.yml as authoritative) | Update AGENTS.md to point at pr-title.yml | Minor confusion |
| OD-9 | DCO enforcement: AGENTS.md refers to "the DCO check", but no workflow exists in the repo | Confirm the DCO GitHub App is installed, or add a workflow | Unsigned commits may merge unnoticed |
| OD-10 | Lift the coding density rule (CT-7) and the phase-named modules (ARCH-11) | Accept as conventions for new code | Readability drift |
| OD-11 | Automated accessibility tests (UI-7) | axe checks on rendered app pages | Accessibility regressions are caught only by hand |
