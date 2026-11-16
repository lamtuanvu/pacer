# Task: independent re-review of wave 1 PR 1 fix round 1 (REPO-10)

Executor: cursor-agent (default model), independent reviewer. F3 closes a data-loss path; security-adjacent. You did not write this code. Read-only: do not edit tracked files, commit, push or start live sessions. You may run `git`, `cargo test -p pacer-repos`, `cargo clippy -p pacer-repos --all-targets` (`CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, one cargo command at a time), `cargo xtask loc --check`, `cargo xtask deps`, focused `bun test` files, inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a fresh `mktemp -d` `HOME`, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`. No release or `--workspace` builds. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr1, branch `fix/native-repo-remove-ts-registries`, now rebased onto origin/main (PR 0 merged as #902): two commits, the original fix and the fix-round commit at `HEAD`. Prior review: `.work/reviews/wave1-pr1-review.md` (PASS, F1–F10). Fix brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave1-pr1-r1.md. Handoff "Fix round 1": `.work/reviews/wave1-pr1-handoff.md`.

Follow `.agents/skills/project-review/SKILL.md`; apply `.project/reviewers/{security,qa}.md` and `.project/rules/{security,rust,rust-crates,code-and-testing,repository}.md`.

Review `git diff HEAD~1..HEAD` and confirm the rebase onto main changed nothing else (`git range-diff` against `943d26417..992a9986e` if useful):
1. F3: `O_NONBLOCK` is cleared only after `fstat` confirms a regular file; an `fcntl` failure forwards rather than overwriting; FIFOs still never block. New dependency (`nix`?) acceptable under CRATE rules and already in the lockfile, or justify.
2. F4: the lock test is deterministic and fails with `with_lock` removed (spot-check by mutation in a scratch copy under /tmp, then discard).
3. F5, F6, F9: ledger row 20 wording and residuals, CHANGELOG bullet accurate against the code and TS.
4. Checks: fmt, clippy, `pacer-repos` tests, loc, deps; REPO-4 for the new commit; no `.work/` paths, machine paths or personal emails in added lines.
5. Live: read the fix round's live report summary (5 PASS) and judge it.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave1-pr1/.work/reviews/wave1-pr1-rereview.md`: verdict on the first line; scope, heads, reviewer identity; per finding status; new findings table; checks; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.
