# Task: security and QA re-review of the Core-secrets fix round (REPO-10)

Executor: cursor-agent (default model, standard tier: a re-review of one fix commit against two known finding lists). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Never start the shared sccache server from a disposable HOME: export `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache` and keep your real `HOME` for any command that compiles Rust, or build with `RUSTC_WRAPPER=`. This includes `bun run live`: give it `RUSTC_WRAPPER=` if it builds under a fixture HOME.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/core-secrets, branch `fix/core-secrets-stdin`, head `b6fb78394` on `origin/main` `1bf4103e4` (#970 merged). Commits: `7d16d4cfd` (the change, reviewed before the rebase at `79c898d8a`), `54865db3e` (the fix round), `b6fb78394` (a test-order fix that duplicates one already in PR #963; the coordinator will drop it if #963 merges first, so do not review it beyond confirming it is test-only).

Inputs:
- The earlier reviews: `.work/reviews/core-secrets-security-review.md` (PASS, F1-F9) and `.work/reviews/core-secrets-qa-review.md` (UNVERIFIED, F1-F7).
- The author's handoff and draft PR body: `.work/reviews/core-secrets-handoff.md`.
- `.project/reviewers/{security,qa,protocol-compat}.md`, ADR 0027, `docs/testing/m2-ledger.md`, scoped rules for Rust crates, serve and tests.
- Maintainer decision (#918 item 3 = "rec"): executors run unsandboxed by design; Core's three secrets move to stdin; a test pins the codex agent-session flags; the rest is deferred to #973.

Verify:
1. The rebase over #970 kept H's ADR 0027 and ledger text and applied the stdin-frame meaning correctly. `git range-diff 79c898d8a~1..79c898d8a 1bf4103e4..7d16d4cfd` shows only context and the intended conflict resolution.
2. Each earlier finding is resolved or knowingly deferred, with evidence:
   - Security F1 / QA F2: the read is bounded on a blocking pipe and refuses a TTY; an inherited `PACER_CORE_SECRETS` marker is dropped (`child_env`, `CONSUMED`). Reproduce the earlier 25 s hang probe; it must now fail closed within the deadline.
   - Security F2: duplicate keys rejected (canonical JSON).
   - QA F1 (blocking): the paired native path writes the frame only after the ack, with a Rust test and a real-shim test; revert the ordering in a `/tmp` copy and confirm red.
   - QA F3 (same-build messages), QA F4 (`CONSUMED`), F3/F4/F5/F8 docs, F7 (`--add-dir` pin values).
   - Security F5 (Linux `/proc/<core>/fd/0` race): recorded for #973; say whether the handoff's "#973 addition" text is accurate.
3. No new route leaks a secret: no secret in argv, environment of Core or its children, logs, error messages or reports. A malformed, partial, duplicated or second frame fails closed without echoing secret bytes.
4. Rerun on `b6fb78394`: fmt, clippy `-D warnings` with and without `test-ops`, the 4 touched crates' tests, xtask, typecheck, and the Bun suites the handoff lists with front doors built from this head. Classify every failure (sandbox-only, flake with rerun evidence, or real).
5. CT-11: rerun at least the c0 serve start and the c1 stdio door checks with `bun run live` (fixture homes, separate port, stop everything you start). Keep the signed paired live run and the Linux `/proc` branch UNVERIFIED with reasons unless you exercise them.
6. Commits signed off and Conventional; no machine paths or personal emails in tracked files.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/core-secrets-rereview.md with a verdict (PASS / FAIL / UNVERIFIED) against `b6fb78394`, the status of each earlier finding, new findings with severity, and commands run. Report with `orca orchestration worker_done`. Always end with worker_done.
