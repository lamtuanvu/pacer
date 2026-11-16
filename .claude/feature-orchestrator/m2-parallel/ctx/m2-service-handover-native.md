# Implementation task: make service.handover and service.work native in Rust (M2)

## Worktree and branch
- Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover-native
- Branch: m2/service-handover-native, stacked on m2/service-handover at b4f476b7b (that branch is still in review and may get more commits; you will be rebased onto it or onto main later, so keep your commits self-contained and do not edit files the parent branch is changing unless necessary). Work only here.

## Background
The parent branch made service.install and update.apply native (selective) with a Core bridge, and kept `service.handover` and `service.work` FORWARDED by maintainer decision, tracked as this separate task. Current state (docs/testing/m2-ledger.md:112): `pacer-update::handover` has Rust validation and bridge plumbing (`crates/server/src/native/handover_bridge.rs`), but neither op is registered, because Core serves no `handover.effects` bridge yet. The TypeScript reference is in `src/api/ops.ts` (~395 `service.handover`: owner-only, refused for delegated callers, `wait_s` 0..60 default 60, waits for older runners to hand over live attempts and returns counts; ~401 `service.work`: running tasks and live sessions with runner and host versions and sessions that need Reopen; versions and counts only, never paths) and `src/setup/service.ts`.

## Goal
Register both ops as native in `crates/server/src/native.rs`, following the established M2 pattern (read how the parent branch did install_apply_sync.rs / core_bridge_sync.rs and other `*_sync.rs` bridges, and earlier landed M2 ops on main). Whatever Rust cannot do natively without duplicating Core's runner state goes through a Core bridge under `/_internal/...` that you add on the TypeScript side (`handover.effects` or equivalent), with the same auth/identity rules as the existing bridges.

Requirements:
- Byte-for-byte parity with the forwarded TypeScript path for every result and error: params validation (Zod messages), owner-only refusal for delegated callers (executor, work-grant, task grants), unauthenticated access, wait semantics.
- Timeouts and completion semantics must match the forwarded path: `service.handover` waits up to 60 s; the bridge must not impose a shorter deadline or report failure while Core continues (the parent branch hit exactly this bug with a 120 s bridge timeout; do not reintroduce it). Preserve the caller's auth and enforcement identity across the bridge; no new privilege or unauthenticated path.
- `service.work` must never expose paths.
- `PACER_FORWARD_OPS` must still force forwarding of each op.
- Update docs/testing/m2-ledger.md rows and totals accurately (recount; the parent branch's totals are known to be inconsistent, so recount from the registry rather than adjusting by +2).
- Respect the crate size budget in .project/rules/rust-crates.md; if you cannot, stop and report rather than editing the rule.

## Tests (required)
- Rust unit tests for validation, refusals and bridge wiring.
- Parity tests comparing native vs PACER_FORWARD_OPS forced forwarding against the real TypeScript Core (extend `test/native-install-apply-e2e.test.ts` or add a sibling): through the real Rust HTTP serve and `api --stdio` front doors, disposable homes, safe injected effects (no real runners or service manager), success and error cases, owner vs delegated callers, request ids, and a delayed handover that proves no premature deadline (use a short injectable wait where needed). The existing tests asserting these ops stay forwarded must be updated to assert native behaviour.
- `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all --check`, `bun run typecheck` (or tsc --noEmit), and affected bun tests must pass.

## Live validation (CT-11, required)
`bun run live` per docs/testing/live-validation.md at your final clean head. service.handover is refused by the harness D8 guard: record that refusal as PASS evidence; the handover effect itself stays UNVERIFIED under the maintainer-scoped exception, backed by your front-door end-to-end tests. Exercise `service.work` live over HTTP and any web surface that shows it (Orca's built-in browser, ISOLATED profile; guide: `orca skills get orca-cli --reference references/browser.md`). Op-specific stdio, desktop, the PACER_FORWARD_OPS override and real executor runs are UNVERIFIED under the maintainer exception, backed by tests. Live evidence must be from your final head with a clean tree.

## Governance
Read first: AGENTS.md, .project/constitution.md, .project/context.md, .agents/skills/project-governance/SKILL.md. Applicable rules: .project/rules/repository.md, code-and-testing.md, rust.md, rust-crates.md, architecture.md, api-protocol.md, security.md; reviewers in .project/reviewers/. Conventional Commits, `git commit -s` on every commit. Do not push. Do not commit .work/. No machine-specific paths or personal emails in tracked files.

## Hard safety rules
Never touch the maintainer's real pacer install: /Applications/pacer.app, ~/.local/bin/pacer and pacer-core, ~/.pacer, the com.pacer.serve service or launchd label (no launchctl bootstrap/bootout/kickstart). Every test and spawned process must use a disposable HOME and PACER_HOME and must not be able to reach 127.0.0.1:4317 (pin PACER_PORT to a sandbox or closed port wherever a process may contact the service). Never signal real runners. Stop everything you started.

## Report
Report with `orca orchestration worker_done`: outcome, commit hashes, test counts, live evidence path, session HEAD, the report's summary line, and what is UNVERIFIED. Always end with worker_done; if blocked or out of budget, say so in worker_done.
