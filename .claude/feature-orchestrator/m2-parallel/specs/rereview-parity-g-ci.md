# Task: security re-review of PR #971 (owner parity G) CI fix — owner key for serve's supervision worker (REPO-10)

Executor: cursor-agent (default model, standard tier: one focused credential change). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-g, branch `fix/owner-bridge-caller-auth`, new commit `1498f9922` on the reviewed head `6cbb25e86`.

Inputs: handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-ci-fix-handoff.md; earlier reviews `.work/reviews/parity-g-review.md` and `parity-g-rereview.md`; ADR 0027 in the branch; `.project/reviewers/security.md`, `.project/rules/security.md`.

Verify:
1. Root cause: #959's stop reconcile runs in serve's supervision worker thread, which has its own module state and never took the key, so flag-on detached stop failed with "native process owner credential is missing".
2. The fix hands the key only inside serve's Core process (worker init message), exactly as the background worker gets it. The key never reaches executors, plugins, child processes, logs, error text or the outbox; the init message isn't logged or persisted; a worker restart gets the key again; flag off is unchanged.
3. No other Core thread or process that makes owner calls lacks the key (detached inspection, remote stop grants, sweeps, CLI paths). Grep every `owner` call site that can run outside the main thread.
4. Tests: rerun `test/plugins-native-owner-detached-stop.test.ts` (5 runs), G's caller-auth tests and the owner, native-plugin, serve-auth and worker suites with the front door built from `1498f9922`; reproduce the red by reverting the fix in a `/tmp` copy. fmt, clippy, typecheck. Commit signed off and Conventional, no machine paths.
5. ADR 0027 wording is accurate; CT-11 evidence (flag-on stop of an orphaned fake-codex run) is adequate.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-ci-rereview.md with verdict (PASS / FAIL / UNVERIFIED) against `1498f9922`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-parity-g-ci.md exactly. End with orca orchestration worker_done.
