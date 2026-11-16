# Task: fix issue #974 — read-only store on a cleanly closed WAL database (TypeScript first, then both Rust copies); W4-6 prerequisite

Executor: cursor-agent (default model, frontier tier: SQLite open semantics across Bun and rusqlite, two implementations plus a shared opener). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/readonly-974, branch `fix/readonly-store-wal`, based on `main` (includes W4-5a #975; W4-5b is PR #977, auto-merge pending — rebase onto main after it merges if it touches the same files).

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`. In zsh, pass test file lists as separate words.

## Problem

Read issue #974 (`gh issue view 974`) and the W4-5a review's F3 (`.work/reviews/w4-5a-review.md`). Summary: `openReadOnlyStore` (`src/dispatch/readonly.ts`) opens `state/tasks.db` read-only with an `immutable: true` fallback, but for a WAL-mode store closed cleanly (no `-wal`/`-shm`), the failure surfaces on the first read, outside the fallback's `try`. On macOS (Bun, system SQLite) TypeScript reads a healthy store as empty, or `conflict` when strict; the Rust port (`crates/dispatch/src/readonly.rs`, rusqlite bundled) reads it but leaves `-wal`/`-shm` behind. `crates/lifecycle/src/files_search/mod.rs` `running_tasks` has the same structure. W4-5b (PR #977) made learned-fit reads of `work_reviews` use the same opener.

## Do (RUST-7: TypeScript first)

1. **TypeScript.** Make the first read part of the fallback: if the read-only open or its first read fails because the WAL is absent or empty, retry with `immutable: true` (or another approach you justify) so a cleanly closed store reads its rows, with no file created, on both writable and read-only `state/`. Keep the strict/non-strict semantics for genuinely unreadable stores (garbage, missing tables, locked). Decide and document whether a read-only open may create `-wal`/`-shm`: the contract should be "creates no file".
2. **Rust.** One opener, moved to `pacer-store` (or the lowest layer that both `pacer-dispatch` and `pacer-lifecycle` may depend on; check `cargo xtask deps`), matching the new TypeScript behaviour, used by `pacer-dispatch` `readonly.rs` (including the learned-fit reads) and `pacer-lifecycle` `files_search`. Remove the duplicates.
3. **Tests.** Differential cases (extend `test/dispatch-decision-parity.test.ts`, `dispatch-explain-parity.test.ts` or a new `test/readonly-store-parity.test.ts`): a cleanly closed WAL store with writable and read-only `state/`, strict and not; a live WAL store with an open writer; missing, garbage and no-tables stores. Assert rows and that no file is created. A Rust unit test for the shared opener. Red evidence against the current behaviour on both sides. Also cover `files_search` (the op that uses `running_tasks`) with its existing parity test or a new case.
4. Fix the `readonly.rs` module doc (the W4-5a re-review's R2: qualify "reads the rows" by directory writability, or simply state the new behaviour).

CT-11: required (runtime change to TypeScript dispatch reads and native `files_search`). `bun run live` with the Rust front door on a fixture home: dispatch preview/explain (TypeScript path) and the session/file search surfaces that read the store, after a clean serve stop that leaves no `-wal`; show rows are read and no file is created. Report surfaces you could not exercise as UNVERIFIED.

Checks: fmt, clippy `-D warnings` and tests for every touched crate, `xtask loc`/`deps`, typecheck, the affected bun suites (dispatch, session reservations, files search, native-dispatch suites) with both front doors built from your head.

Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/readonly-974-handoff.md with a draft PR body ("Closes #974"). PR title: `fix(dispatch): read a cleanly closed WAL store without creating files`. QA review follows.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/readonly-store-974.md exactly. End with orca orchestration worker_done.
