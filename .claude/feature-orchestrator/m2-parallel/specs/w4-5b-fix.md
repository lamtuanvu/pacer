# Task: W4-5b fix round — rebase onto main, close the test gaps, fix the Map-index panic

Executor: cursor-agent (default model, standard tier: tests and one small fix). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-5b, branch `feat/w4-dispatch-explain-library`, head `0c40a65fc` on W4-5a `1bd85b6de`.

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`. In zsh, pass test file lists as separate words.

Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5b-review.md (FAIL). Do:

0. **Rebase**: W4-5a merged as #975. `git fetch origin && git rebase --onto origin/main 1bd85b6de`. Resolve conflicts keeping both sides' intent.
1. **F1, F2 (blocking).** Add differential cases for the comfortable threshold, the reserve subtraction and the override to a later-step executor; the reviewer's three probe cases are in the report. Show each surviving mutation from the report goes red.
2. **F3 (preferred).** A multi-exclusion case.
3. **F5 (preferred).** Fix the Map-index panic at `explain.rs:412` (no panic on input TypeScript handles; match TypeScript's result), with a test that would have panicked.
4. **F6, F7 (advisories).** Record in the handoff and PR body: the store type W4-6 preview needs (F6) and the #974 note for learning reads (F7).

Checks: fmt, clippy `-D warnings`, crate tests for `pacer-dispatch` and `pacer-dispatch-ops`, `xtask loc`/`deps` (`pacer-dispatch` must stay ≤ 3,000), typecheck, `test/dispatch-explain-parity.test.ts`, `test/dispatch-decision-parity.test.ts`, and the three native-dispatch suites with both front doors built from the new head.

Add a new signed-off commit (`test(dispatch): …` or `fix(dispatch): …`); do not push. Update /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5b-handoff.md (a "Fix round" section and the updated draft PR body). A re-review of the delta follows.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-5b-fix.md exactly. End with orca orchestration worker_done.
