# Task: independent review of owner parity PR C — append native owner plugin stderr to the plugin log (REPO-10)

Executor: cursor-agent (default model, medium tier); GLM would review this but its quota is exhausted. Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-c, branch `fix/owner-plugin-stderr-log`, head `133370ab3`, one commit(s) on wave 3 PR 6 (`2951c0aeb`, reviewed PASS; a tests-and-docs fix round on PR 6 is running, and this branch will be rebased onto it).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-c-handoff.md.
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-c.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR C" in §2 and the §1 items it closes).
- Project rules: `.project/constitution.md`, `.project/context.md`, and the scoped rules and reviewers that match (security, rust, rust-crates, api-protocol, code-and-testing, architecture, CT-11). Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. Line format, `[stderr]` tag, timestamps, the 4096-unit cut, the 1 MiB drop note, 1 MiB rotation and the 0600/0700 modes match the TypeScript plugin log writer exactly (find it from `logs/plugins` in `src/plugins/`).
2. The reader never blocks the child (a child writing faster than the disk, or never writing a newline), stops at child exit, and leaks no file descriptor or thread; serve shutdown and stdio teardown stay prompt (PR 5's 2 s guarantees).
3. A plugin cannot use stderr to write outside its own log file (id validation, symlinked log directory or file, `..`), and log files are created with the right modes even when the directory pre-exists with wider ones (compare with TypeScript's behavior).
4. CRATE-1: `pacer-plugin-runtime` 4,933 — under 5,000; state whether PRs A and B will push it over and whether that needs the split now.
6. Every new or flipped test fails without its fix; tests tell the truth (no masking that hides a divergence). CT-11 evidence names this head (or one with only test-only commits after) and matches the code. Docs, ledger and CHANGELOG are accurate; no machine paths or personal emails; commits signed off and Conventional.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`, with both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. One cargo command at a time, debug; other Rust workers run at the same time, keep memory modest. Note: the PR 6 conformance and matrix tests currently use fixed `/tmp/pcn` and `/tmp/pom-<row>` roots (being fixed on PR 6); do not run them at the same moment as another worker in the same root — if a run fails with a vanished home, rerun once and say so.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

Tests to run: clippy `-D warnings` and tests for `pacer-plugin-runtime`; `bun run typecheck`; `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/native-plugin-crash.test.ts`, `test/plugin-conformance.test.ts`. Rerun the red-first mutation for the conformance `logs` case.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-c-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `133370ab3`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-parity-c.md exactly. End with orca orchestration worker_done.
