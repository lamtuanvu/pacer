# Task: W4-3 fix round — keep the owner key out of `opencode`, test the recorded env, cap stdout

Executor: cursor-agent (default model, standard tier: targeted fixes with tests). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-3, branch `feat/w4-opencode-models`, head `4a9962385` on W4-1 (PR #972; its branch was rebased onto #968 and is now `origin/feat/w4-runner-models` at `b327f277c`).

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`.

Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-3-review.md (verdict FAIL). Fix:

0. **Rebase first**: `git fetch origin && git rebase --onto origin/feat/w4-runner-models a50af2957` (if #972 has merged by then, use `origin/main`). Resolve any conflict, keeping both sides' intent.
1. **B1.** Add `PACER_HOST_SOCKET_KEY` to `CONSUMED` in `crates/server/src/core_process.rs` (#971 adds a per-start owner key Core takes out of its env at startup; it must never reach `opencode`). Make `record_stdio` robust to #971's change to `HostSocket` (it becomes `Set(String, OwnerKey)` with the key removed on `Inherit`/`Unset`): structure the code so the stripping does not depend on matching that enum's exact shape where possible, and note in the handoff what the second-merged PR must adjust.
2. **B2.** Unit tests for `record_serve` and `record_stdio`: consumed keys (including `PACER_HOST_SOCKET_KEY`) stripped; `BUN_OPTIONS`/`NODE_OPTIONS` dropped on serve; `PACER_INTERNAL_PARENT_PIPE=1` set; the host-socket decision applied. In `pacer-models`, a test that a variable present only in the test process does not reach the `opencode` child (so the `env_clear` mutation goes red). Show red evidence for both.
3. **N1.** Cap `opencode models` stdout at 64 MiB: past the cap, kill the group and treat the run as failed (TypeScript's "could not list" note). Test it with the fake CLI or a Rust test.
4. **N2, N3.** Document in the handoff, the PR body and the ledger row that native strips `PACER_INTERNAL_TOKEN` and `PACER_NATIVE_CONFIG_SYNC_KEY` on both doors (TypeScript passes one of them on each door) and the rare `unavailable` after the CLI ran when the catalog changes between the check and the run.
5. **N5.** Add parity cases for a failing and an empty listing on `runner.set` and `runner.models.set` (warning text and the written strategy, native against forwarded).
6. Nit: reuse one prototype-key list (`available_ops::INHERITED` vs `pacer_models::available::PROTOTYPE_KEYS`).

Checks: fmt, clippy `-D warnings` (`pacer-models`, `pacer-config-ops`, `pacer-server`, with and without `test-ops`), crate tests, `xtask loc`/`deps`, typecheck, and the four bun files (both front doors built from the new head; the 90 s kill test once). CT-11: the stdout cap and env changes are runtime changes; rerun the HTTP `executor.models.available` live steps on a fixture sandbox (Rust front door), or explain in the handoff why the parity tests suffice.

Amend nothing already reviewed; add a new signed-off commit (`fix(models): …`). Do not push. Update /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-3-handoff.md (new "Fix round" section, updated draft PR body). A re-review follows.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-3-fix.md exactly. End with orca orchestration worker_done.
