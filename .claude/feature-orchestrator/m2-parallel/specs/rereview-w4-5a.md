# Task: architecture and QA re-review of the W4-5a fix round (REPO-10)

Executor: cursor-agent (default model, standard tier: re-review of a test and docs delta). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-5a, branch `feat/w4-dispatch-library`, fix commit `8c3247ed1` on the reviewed `4c4431f2f`.

Inputs: your earlier review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5a-review.md ("To pass"), the fix brief `.claude/feature-orchestrator/m2-parallel/ctx/w4-5a-fix.md`, the handoff `.work/reviews/w4-5a-handoff.md` (fix-round section, CRATE-9 table, updated PR body), issue #974.

Verify:
1. F1: the CRATE-9 table is in #908's format with a stated method; judge whether the method (workspace build, warm sccache, jobs 4, machine load noted) satisfies CRATE-9 and whether the "no --workspace" deviation is acceptable for a measurement.
2. F2/F4/F5: the new differential cases exist and are meaningful; reproduce the reversed tie-break and the removed clamp red in a `/tmp` copy.
3. F3: the `readonly.rs` doc and the handoff/PR body state the measured divergence accurately and record #974 as a W4-6 prerequisite.
4. F7: `canonical` is `pub(crate)` and nothing else changed behaviour.
5. Checks: fmt, clippy `-D warnings`, crate tests for `pacer-dispatch` and `pacer-dispatch-ops`, `xtask loc`/`deps`, typecheck, the differential test and the three native-dispatch suites. Commit signed off, Conventional, no machine paths.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5a-rereview.md with verdict (PASS / FAIL / UNVERIFIED) against `8c3247ed1`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-w4-5a.md exactly. End with orca orchestration worker_done.
