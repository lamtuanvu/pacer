# Task: security and QA re-review of the W4-3 fix round (REPO-10)

Executor: cursor-agent (default model, standard tier: re-review of a focused delta). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-3, branch `feat/w4-opencode-models`. The reviewed commit `4a9962385` was rebased onto `origin/main` `452ca6c65` (W4-1 merged as #972) as `03c8e69e4`; the fix commit is `af3cee128`.

Inputs: your earlier review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-3-review.md (B1, B2, N1–N5, nits), the fix brief `.claude/feature-orchestrator/m2-parallel/ctx/w4-3-fix.md`, the handoff `.work/reviews/w4-3-handoff.md` ("Fix round" section and the updated PR body), `.project/reviewers/{security,qa}.md`.

Verify:
1. The rebase: `git range-diff 1a4601837..4a9962385 452ca6c65..03c8e69e4` (or equivalent) shows only base changes.
2. B1: `PACER_HOST_SOCKET_KEY` is stripped on both doors; `record_stdio` now derives the env through `HostSocket::apply`, so it cannot drift from the child's env. Simulate the merge with PR #971 (`origin/fix/owner-bridge-caller-auth`, head `be18014a5`) using `git merge-tree` or a `/tmp` worktree, and confirm the key cannot reach `opencode` on either door after merge; check that the handoff's note about the two `HostSocket::Set` test calls is accurate and complete.
3. B2: the new unit tests and the env-isolation test are meaningful; reproduce the `env_clear` mutation red and one `record_*` mutation red.
4. N1: 64 MiB cap kills the group, gives TypeScript's "could not list" note, writes no cache; no unbounded buffering remains.
5. N2/N3 docs, N5 parity cases (red with the warning blanked), the shared prototype-key list.
6. Checks: fmt, clippy `-D warnings` (with and without `test-ops`), crate tests, `xtask loc`/`deps`, typecheck, the four bun files with both front doors built from `af3cee128` (the 90 s kill test once). Commit signed off, Conventional, no machine paths.
7. CT-11: judge the w43c live run (4 PASS / 0 FAIL / 4 UNVERIFIED) together with the earlier runs.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-3-rereview.md with verdict (PASS / FAIL / UNVERIFIED) against `af3cee128`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-w4-3.md exactly. End with orca orchestration worker_done.
