# Task: independent re-review of owner parity PR D fix round 1 (REPO-10)

Executor: cursor-agent (default model, medium tier); GLM is out of quota. Read-only: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-d, branch `fix/plugin-frame-key-order`, head `c1ce33758`. The reviewed implementation was rebased onto wave 3 PR 6's fix round (`d207bbb5b`, PR #931) as `86479663a`; fix round 1 is `86479663a..c1ce33758`.

Inputs: review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-d-review.md; handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-d-handoff.md ("Fix round 1"); brief /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-parity-d-r1.md. Rules: `.project/rules/{rust,code-and-testing,repository}.md`, `.project/reviewers/{qa,protocol-compat}.md`, `.agents/skills/project-review/SKILL.md`.

Verify: the blocking REPO-7 finding is fixed (CHANGELOG and ledger describe the fixed behavior; nothing still calls the sorted-keys rows expected-fail); the `shift_remove` change in `hardening.rs` is correct, scoped and its test fails without it (rerun that mutation); the new known-limit ledger text (runClaim `Map::remove` reorder, producer key order) is accurate against the code; CT-11 evidence names `c1ce33758`; the rebase onto `d207bbb5b` (`2951c0aeb..86479663a` vs the original `6df765f27`) changed nothing unintended (use `git range-diff 2951c0aeb..6df765f27 d207bbb5b..86479663a`); no machine paths or personal emails in `d207bbb5b..c1ce33758`; commits signed off and Conventional.

Checks inside /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin first on `PATH`, `env -u PACER_HOST_SOCKET`, both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` with `--features test-ops`): clippy `-D warnings` and tests for `pacer-plugin-host`; `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`; report counts. One cargo command at a time; keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-d-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against `c1ce33758`, per-finding status, new findings with severity, commands and results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-parity-d.md exactly. End with orca orchestration worker_done.
