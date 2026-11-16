# Task: independent QA and protocol-compatibility review of "Core secrets on stdin" (REPO-10)

Executor: cursor-agent (default model, standard tier: test adequacy and compatibility of one change whose security is reviewed separately). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`. Follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md for the test environment, the sandbox and the sccache workaround. A security reviewer works in parallel in the same worktree; if `cargo` waits on the target-dir lock, wait.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/core-secrets, branch `fix/core-secrets-stdin`, commit `79c898d8a` on base `3275b5e35`.

Inputs: handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/core-secrets-handoff.md; `.project/reviewers/qa.md`, `.project/rules/testing.md` (or the closest), `.project/rules/api.md`, `.project/rules/rust.md`; `docs/testing/live-validation.md`.

Verify:
1. Compatibility: every way Core is started still works: serve, the stdio door (owning and attaching), the desktop/web paths that go through serve, the signed paired native path, `pacer-core` run directly for CLI commands that don't need secrets, and the test and live fixtures. A newer front door with an older Core or the reverse is either impossible (shipped together) or fails with a clear message; say which. Check `crates/pacer/tests/stdio_proxy.rs`, `discovery_radio.rs`, the four fixture Cores and `native-host-parity/core.ts`.
2. Startup latency and robustness: reading fd 0 synchronously, byte by byte, with a 10 s EAGAIN deadline can't stall a Core whose stdin is a TTY, `/dev/null`, a closed fd or a pipe with no frame when no frame is announced (`PACER_CORE_SECRETS` unset). Measure the startup cost against `main`.
3. Tests: the new tests (`core-secrets-frame`, `core-secrets-environ`, the agent-session pin, the matrix I1 change, `serve-internal`, `host-bridge-auth`) go red on `main` or with the fix reverted, and green on the head. The I1 change asserts the corrected property, not a weaker one. No test was weakened or deleted without a replacement.
4. Run with front doors built from `79c898d8a` (plain and `--features test-ops`): the handoff's test list, the owner, native-plugin, serve, stdio-proxy, discovery and session suites, the Rust tests for `pacer-server` and `pacer` (with and without test-ops), fmt, clippy `-D warnings`, `cargo xtask loc --check`, `cargo xtask deps`, typecheck. Report flakes separately from failures.
5. Rebase risk: `git merge-tree --write-tree origin/main HEAD`. Main now has #977, and PR #970 (H, auto-merge on) edits ADR 0027 Q1 follow-ups, the ledger and `src/plugins/host-bridge.ts`; list the expected conflicts against `origin/fix/door-plugin-calls-via-core` too.
6. The draft PR body in the handoff is accurate and complete.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/core-secrets-qa-review.md with a verdict (PASS / FAIL / UNVERIFIED) against `79c898d8a`, findings with severity, and the commands run. Report with `orca orchestration worker_done`. Always end with worker_done.
