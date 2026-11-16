# Task: #974 fix round — Linux Bun cannot open the immutable URI; make the TypeScript pre-check tested

Executor: cursor-agent (default model, standard tier: a targeted fix with cross-platform evidence). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/readonly-974, branch `fix/readonly-store-wal`, head `a94e1b5af`.

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`. In zsh, pass test file lists as separate words.

Review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/readonly-974-review.md (FAIL). Fix:

1. **F1 (High, blocking).** On Linux, Bun's bundled SQLite lacks `SQLITE_USE_URI` and `bun:sqlite` does not pass `SQLITE_OPEN_URI`, so the TypeScript immutable URI open fails and a cleanly closed store (the normal Linux state) reads as empty, or strict `conflict`: a regression from main. Open the immutable target with `SQLITE_OPEN_READONLY | SQLITE_OPEN_URI` (the reviewer verified this on Linux and macOS; see the report for the exact call). Get Linux evidence: run the affected parity cases in a Linux container (`docker run` with the repo mounted read-only plus a writable copy under `/tmp`, Bun 1.4.2, no network beyond pulling the image, no credentials), red before the fix and green after. If a Rust front door is needed inside the container, build it there or limit the Linux run to the TypeScript half and say so.
2. **F2 (Medium, blocking).** Deleting the TypeScript pre-check passes all 19 macOS parity cases. Add a case that fails without it (or remove the pre-check if it is truly unnecessary, with evidence on both platforms).
3. Optional: F3 (stale immutable handles: document or bound handle lifetime), F4 (`ReadOnlyError` with `thiserror` if the crate's convention wants it), F5 (busy timeout: record as not user-visible).

Checks: fmt, clippy `-D warnings`, crate tests (`pacer-store`, `pacer-dispatch`, `pacer-lifecycle`), `xtask loc`/`deps` (if `cargo xtask` says "No such file or directory", follow the workaround in `w4-common.md`), typecheck, the affected bun suites with both front doors built from the new head. Rebase onto `origin/main` first if W4-5b (#977) has merged.

CT-11: rerun the live steps that touch the TypeScript opener (route explain after a clean close, strict session slots, read-only `state/`), and report.

Add a new signed-off commit (`fix(dispatch): …`); do not push. Update /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/readonly-974-handoff.md (a "Fix round" section with the Linux evidence, the updated draft PR body). A re-review follows.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/readonly-974-fix.md exactly. End with orca orchestration worker_done.
