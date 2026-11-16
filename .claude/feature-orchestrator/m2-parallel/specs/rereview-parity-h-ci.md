# Task: QA re-review of PR #970 (owner parity H) CI fix — transport closed before pending calls fail (REPO-10)

Executor: cursor-agent (default model, standard tier: one concurrency fix in `plugin-runtime`). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-h, branch of PR #970, fix commit `c7294b9a7` on the reviewed head `810ea2628`.

Inputs: handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-ci-fix-handoff.md, brief `.claude/feature-orchestrator/m2-parallel/ctx/parity-h-ci-fix.md`, earlier H reviews `.work/reviews/parity-h-review.md` and `parity-h-rereview.md`, `.project/reviewers/qa.md`, `.project/rules/{rust,code-and-testing}.md`.

CI failure: `test/native-plugin-crash.test.ts:133` expected `ui.action: plugin fx-ui exited on SIGKILL`, received `plugin process unavailable: plugin process is unavailable: stdout closed`.

Verify:
1. The root cause: in `crates/plugin-runtime/src/process.rs` `Shared::close`, pending calls' reply senders were dropped before the transport's closed flag was set, so a woken call saw a live lane and `crash_message` skipped waiting for the exit. Confirm by reading the code paths (memory ordering included) and that this race exists on main too.
2. The fix sets the flag first; check no other path wakes pending calls before the flag (timeouts, stop, drop, reader EOF, write error), no deadlock or lock-order change, and that H's no-flat-deadline and drain behaviour is unchanged.
3. The new unit test is deterministic and red without the fix (reproduce in a `/tmp` copy). Optionally reproduce the forced-gap repro.
4. Checks: fmt, clippy `-D warnings`, `plugin-runtime` and server door tests, `xtask loc`/`deps`, typecheck; the crash suite at least 10 times under load and the native-plugin and owner suites once, with both front doors built from `c7294b9a7` (env per `w4-common.md`). Commit signed off, Conventional, no machine paths.
5. CT-11 evidence (rust door, owner flag on, HTTP and CLI) is adequate.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-ci-rereview.md with verdict (PASS / FAIL / UNVERIFIED) against `c7294b9a7`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-parity-h-ci.md exactly. End with orca orchestration worker_done.
