# Task: W4-5a fix round — CRATE-9 timings, tie-break and clamp tests, read-only parity statement

Executor: cursor-agent (default model, standard tier: tests, measurements and docs). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-5a, branch `feat/w4-dispatch-library`, head `4c4431f2f`.

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`.

Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5a-review.md (FAIL, "To pass" at the end). Fix:

1. **F1 CRATE-9 timings.** Measure, in #908's format: debug build, warm sccache, fresh target directories, clean dev build and incremental rebuild after touching `pacer-lifecycle`, before (`origin/main` merge-base) and after (this branch). Disk is tight (about 26 GB free, other workers building): use ONE scratch target directory under `/tmp`, run the four measurements one at a time, delete the target between before and after, and delete it at the end. Use `git worktree add --detach /tmp/w45a-before <merge-base>` for "before" and remove that worktree afterwards. Note the machine load in the table.
2. **F2 + F4.** Add to `test/dispatch-decision-parity.test.ts`: two same-tier `medium` candidates with equal headroom whose ids sort opposite to their input order; two `unknown`/null-headroom candidates in a `capacity: "unknown"` step; a usage window with `hoursLeft: 0.5`. Show red with the reversed comparator (`js_cmp(b.id, a.id)` in `ladder.rs` `order`) and with the clamp removed (`/ hours` in `candidates.rs`). Optional F5: a second `capabilities` observation with a later `observedAt` and a different value, red with the sort reversed.
3. **F3.** Replace the handoff and PR body's "the Rust structure mirrors `readonly.ts`" with the measured divergence for a cleanly closed WAL store, link issue #974, and record it as a W4-6 prerequisite next to the opener-move follow-up (deviation 5). Fix the `readonly.rs` module doc so it does not claim "creates no file" unconditionally. Do not change the opener's behaviour here.
4. Optional F7: make `canonical` `pub(crate)` if nothing outside the crate needs it.

Checks: fmt, clippy `-D warnings`, crate tests for `pacer-dispatch` and `pacer-dispatch-ops`, `xtask loc`/`deps`, typecheck, the differential test and the three native-dispatch suites.

Add a new signed-off commit (`test(dispatch): …` or `fix(dispatch): …`); do not push. Update /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-5a-handoff.md (a "Fix round" section and the updated draft PR body with the CRATE-9 table). A re-review of the delta follows.
