# Task: architecture and QA re-review of the W4-5b fix round (REPO-10)

Executor: cursor-agent (default model, standard tier: re-review of a test and small-fix delta). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. In zsh, pass test file lists as separate words.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-5b, branch `feat/w4-dispatch-explain-library`. The reviewed `0c40a65fc` was rebased onto `origin/main` (W4-5a merged as #975) as `bbea5ec0a`; the fix commit is `a912630ba`.

Inputs: your earlier review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5b-review.md, the fix brief `.claude/feature-orchestrator/m2-parallel/ctx/w4-5b-fix.md`, the handoff `.work/reviews/w4-5b-handoff.md` (Fix round, updated PR body), red evidence `.work/fixtures/w4-5b-fix-red-*`.

Verify:
1. The rebase only drops W4-5a's commits and duplicate trailers (range-diff `0c40a65fc` vs `bbea5ec0a`).
2. F1/F2: the three new cases catch the surviving mutations; reproduce at least two red in a `/tmp` copy.
3. F3 multi-exclusion cases; F5: no panic for a missing or null candidate binding (also in `chosen_of`), and the result matches what TypeScript does for that input (or the divergence is stated and unreachable from TypeScript-shaped input).
4. F6/F7 notes accurate.
5. Checks: fmt, clippy `-D warnings`, crate tests for `pacer-dispatch` and `pacer-dispatch-ops`, `xtask loc`/`deps`, typecheck, both dispatch parity tests, the three native-dispatch suites with both front doors built from `a912630ba`. Commits signed off, Conventional, no machine paths.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5b-rereview.md with verdict (PASS / FAIL / UNVERIFIED) against `a912630ba`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.
