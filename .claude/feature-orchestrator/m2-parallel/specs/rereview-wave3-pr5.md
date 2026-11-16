# Task: independent re-review of wave 3 PR 5 fix round 1 (REPO-10)

Executor: cursor-agent (default model, frontier tier). The fix restructures owner locking, so this needs a security and concurrency reviewer. Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr5, branch `feat/owner-crash-backoff`. Final head `49c12070a`. The reviewed implementation ends at `89eb2d758` (stacked on #920's head `023479743`); fix round 1 is `89eb2d758..49c12070a` (four commits).

Inputs:
- First reviews: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-security-review.md (B1, N1–N10) and /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-arch-review.md (F1–F7).
- Handoff with the "Fix round 1" section: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-handoff.md.
- Fix brief with the decisions: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave3-pr5-r1.md.
- Project rules: `.project/constitution.md`, `.project/context.md`, and the scoped rules and reviewers that match (security, rust, rust-crates, api-protocol, architecture, code-and-testing, CT-11). Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **B1, shutdown with a call in flight.** The fix moved to a lane roster outside the owner lock, and Core, front-door, bridge and host-runner calls now run on their lane unlocked. Check:
   - Shutdown sends SIGTERM to every child, then SIGKILL after 2 s, without waiting on any lock a call can hold. Both serve and owning-stdio paths must do this.
   - In-flight calls fail cleanly, with no panic, hang or leaked child.
   - Unlocked lane calls don't introduce a new race: two calls on one lane, a call racing enable/disable/restart/crash handling, a call racing shutdown, or a stale lane reused after a respawn. Pay attention to whether a call can reach a child that a disable or crash already replaced, or whether a call can be sent to a plugin the owner now refuses.
   - Rerun the red-at-`89eb2d758` shutdown test against a mutation that reintroduces the lock wait, and confirm it fails.
2. **N1:** SIGTERM before SIGKILL when the transport closes, matching the TypeScript owner; test covers it.
3. **N2:** the owner floor keeps `failing` after 3 crashes until an enable. Judge the known limit the worker recorded: an attached or forwarded enable leaves a failing plugin refused until a native enable or a serve restart. Is that acceptable for flag-off-default PR 5, and is it documented where users will see it?
4. **F6:** a Core attached to another connection refuses `crashed`; test fails without the check.
5. **N3, N4, N5 and the F1, F3, F4, F5, N10 docs and PR text:** accurate against the code. Exit code 3 applies only to a second serve on another port. Crash reports during a Core restart are dropped, not retried. The CRATE-1 and loc-band reasons and the proposed plugin-service split are stated.
6. Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_TEST_NATIVE_FRONT_DOOR -u PACER_HOST_SOCKET`:
   - clippy `-D warnings` and tests for `pacer-server` and `pacer-plugin-runtime` (one cargo command at a time, debug);
   - `bun run typecheck`;
   - `test/native-plugin-ops-stdio.test.ts` and the PR's owner and crash tests, with both front doors built and copied to a temp dir: `PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer` and `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`. Without them those tests skip; report the number that ran.
   Other Rust workers run at the same time; keep memory modest.
7. CT-11 evidence names head `49c12070a` (or the head it ran on, with only test-only commits after) and its claims match the code. ADR, ledger, CHANGELOG and live-validation docs are accurate; no machine paths or personal emails; commits signed off and Conventional.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against head `49c12070a`, a table of every original finding with its status, any new findings with severity and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-wave3-pr5.md exactly. End with orca orchestration worker_done.
