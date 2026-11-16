# Task: QA and architecture re-review of the #974 fix round (REPO-10)

Executor: cursor-agent (default model, frontier tier: SQLite locking semantics on Linux and macOS, two runtimes). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash`; for temporary reverts use a `git archive HEAD` copy under `/tmp`. In zsh, pass test file lists as separate words.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/readonly-974, branch `fix/readonly-store-wal`, fix commit `7c3930ec9` on the reviewed `a94e1b5af`.

Inputs: your earlier review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/readonly-974-review.md (F1–F5), the fix brief `.claude/feature-orchestrator/m2-parallel/ctx/readonly-974-fix.md`, the handoff `.work/reviews/readonly-974-handoff.md` (Fix round, Linux evidence, updated PR body).

Verify:
1. **F1.** The immutable URI opens with `SQLITE_OPEN_READONLY | SQLITE_OPEN_URI` on both Linux Bun (bundled SQLite without `USE_URI`) and macOS; reproduce in a Linux container (Docker, Bun 1.4.2, no network beyond pulling the image, no credentials) red at `a94e1b5af` or with the flag reverted, green at `7c3930ec9`. Check the new path-escaping case (`?#%` and a space) for URI correctness on both sides.
2. **F2.** The pre-check now has a case that fails when it is deleted, on Linux.
3. **New High finding (look closely).** `a94e1b5af` read the WAL header by opening and closing `tasks.db` outside SQLite, which on Linux releases the process's POSIX advisory locks on that file (close() drops all fcntl locks the process holds on the inode), so a stock SQLite closer could delete a live connection's WAL. The fix reads the header only while `-wal` or `-shm` is absent. Judge: is that sufficient (races where a writer creates `-wal`/`-shm` between the check and the read; does Core or serve hold SQLite connections to `tasks.db` in the same process as these readers — TypeScript Core's own writer, `pacer-store` in the Rust door — so the header read can still drop that process's locks?); is the documented residual acceptable; do the Linux-only `/proc/locks` tests prove the property and go red without the change? Prefer an approach that never opens the file outside SQLite if one exists (for example reading the header through SQLite itself, or `O_RDONLY` with no close while SQLite holds locks), and say whether it is required now.
4. F3 (short-lived immutable handles) and F4 (`thiserror`) are sound; F5 recorded.
5. Checks: fmt, clippy `-D warnings`, crate tests (`pacer-store`, `pacer-dispatch`, `pacer-lifecycle`), `xtask loc`/`deps` (sccache workaround in `w4-common.md` if xtask says "No such file or directory"), typecheck, the affected bun suites with both front doors built from `7c3930ec9`. Commits signed off, Conventional, no machine paths.
6. CT-11 (6 PASS, 0 FAIL, 4 UNVERIFIED) adequacy.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/readonly-974-rereview.md with verdict (PASS / FAIL / UNVERIFIED) against `7c3930ec9`, findings with severity, commands run. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-readonly-974.md exactly. End with orca orchestration worker_done.
