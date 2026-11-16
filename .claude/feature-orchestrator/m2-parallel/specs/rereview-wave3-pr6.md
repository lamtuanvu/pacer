# Task: independent re-review of wave 3 PR 6 fix round 1 (REPO-10)

Executor: cursor-agent (default model, medium tier); GLM is out of quota. Read-only: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr6, branch `test/native-owner-consumer-matrix`, head `d207bbb5b`, open as PR #931. Fix round 1 is `2951c0aeb..d207bbb5b` (tests and docs only, plus one rustdoc move).

Inputs: review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-review.md (N1–N8, D1–D4); handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-handoff.md ("Fix round 1"); brief /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave3-pr6-r1.md. Rules: `.project/rules/{code-and-testing,repository}.md`, `.project/reviewers/qa.md`, `.agents/skills/project-review/SKILL.md`.

Verify each finding's status against the code: the exact-path `fs.read` routed case fails for the stated reason; the hint test turns red under a hint-dropping mutation in `plugin_reply_error` (rerun it); id masks are narrowed by shape or path and hide no divergence; stdio known-refused rows assert the refusal text; each run uses its own mkdtemp root and `afterAll` removes only it; the reentrant probe's shorter timeout and overlap assertion; the rustdoc is back on `rank_executors`; the ledger and PR body (`.work/reviews/wave3-pr6-pr-body.md`) are accurate. Also: the whole PR (`origin/main..d207bbb5b`) has no machine paths or personal emails, and commits are signed off and Conventional.

Checks: Inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`; both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. One cargo command at a time; other Rust workers run at the same time, keep memory modest. `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`; clippy `-D warnings` for `pacer-engine`. Also run the matrix and conformance files twice concurrently from two shells to confirm the isolation fix.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against `d207bbb5b`, a per-finding status table, new findings with severity, commands and results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-wave3-pr6.md exactly. End with orca orchestration worker_done.
