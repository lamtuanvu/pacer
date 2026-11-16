# Task: independent review of owner parity PR E — runners own their plugin children (REPO-10)

Executor: cursor-agent (default model, frontier tier: process environment and plugin ownership across process lifetimes; GLM quota is exhausted). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-e, branch `fix/runners-own-plugin-children`, head `65cd4e523`, two commits (`29549707b`, `65cd4e523`) on `80b7d42f1` (wave 3 PR 6 before its final rebase; PR 6 is now merged to `main` as #931, and this branch will be rebased onto `main`).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-e-handoff.md (per-child socket table, deviations, tests, CT-11, follow-ups).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-e.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR E" in §2, item I1 and R4/R5 in §1). Maintainer decision Q3: runners drop `PACER_HOST_SOCKET` and own their plugin children.
- Project rules: `.project/constitution.md`, `.project/context.md`, and the scoped rules and reviewers that match (security, rust, rust-crates, api-protocol, code-and-testing, architecture, repository for the ADR and ledger wording, CT-11). Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Correctness and parity.** `runnerProcess` (`src/tasks/api.ts`) and `build_run_spawn_plan` (`crates/lifecycle/src/run_spawn.rs`) drop `PACER_HOST_SOCKET` and nothing else that the runner needs; the TypeScript and Rust spawn plans stay byte-for-byte equivalent (`test/run-spawn-parity.test.ts`). A runner without the socket owns its plugin children exactly as a flag-off runner does, on every door (serve, stdio attached, stdio self-owned) and across the door ending or restarting.
2. **Security.** A detached runner can no longer reach a door's owner socket it outlives; no other authority is lost or gained (credentials, work grants, sealed keys). Judge the per-child table in the handoff: is any child that still inherits the socket a security or correctness problem that must be fixed before default-on (PR 7)? In particular, service-launched terminals and sessions where a typed `pacer` would route plugin calls to serve's owner.
3. **The supervision follow-up (handoff Follow-ups 1).** With the owner on, serve's supervision set `cleanupStartedAt` but never stopped an orphaned interactive attempt (`_session` wrapper plus claude) for about 13 minutes; a flag-off in-process `stopOwnedExecutorAttempt` stopped it. Read the code path (`executor.stop` / `detachedStop` authority over the owner bridge, `inspectOwnedExecutorRun`) and judge: is this a real flag-on defect, and does it gate PR 7? Reproduce it deterministically in a test if you can (fake executor, not a real account); otherwise state what would.
4. **Tests.** Every new or flipped test fails without its fix (rerun the red mutation for the I1 matrix test and for `plan_drops_the_door_owner_socket`); tests use deterministic fakes; the matrix flake noted is the known pre-existing doctor activity race.
5. **CT-11.** The evidence matches the code at this head; the fake-codex substitution and the UNVERIFIED real-executor row are stated honestly in the draft PR body; the live runs outside `sbx-deny` kept the harness guards, a temporary home and sandbox ports, and never touched the maintainer's install.
6. **Docs.** ADR 0027 (runner consequence, R5 crashed refusal, R4 restart note), the ledger I1 row and the CHANGELOG are accurate; no machine paths or personal emails; commits signed off and Conventional.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`, with both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report the counts that ran. One cargo command at a time, debug; other Rust workers (PR A fix round, PR G) run at the same time, so keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real executor account, API key or Keychain item.

Tests to run: clippy `-D warnings` and tests for `pacer-lifecycle`; `bun run typecheck`; `test/api.test.ts`, `test/run-spawn-parity.test.ts`, `test/run-spawn-launch-parity.test.ts`, `test/runner-owned-direct-process.test.ts`, `test/plugins-native-owner-matrix.test.ts`, `test/native-plugin-ops-stdio.test.ts`.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-e-review.md: the verdict (PASS / FAIL / UNVERIFIED) against head `65cd4e523`, findings with severity (blocking / nonblocking / nit) and code references, an explicit ruling on whether the supervision follow-up and any socket-inheriting child gate PR 7, and the commands you ran with their results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-parity-e.md exactly. End with orca orchestration worker_done.
