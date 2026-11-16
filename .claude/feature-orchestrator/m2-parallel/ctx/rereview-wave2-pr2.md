# Task: independent re-review of wave 2 PR 2 fix round 1 (REPO-10)

Executor: cursor-agent (default model), independent reviewer. Security-sensitive: enforcement refusal coverage and a new git read variant. You did not write this code. Read-only: do not edit tracked files, commit, push or start live sessions. You may run `git`, `cargo test -p <crate>` / `cargo clippy -p <crate> --all-targets` for touched crates (`CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, one cargo command at a time), `cargo xtask loc --check`, `bun run typecheck` and focused `bun test` files, inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a fresh `mktemp -d` `HOME`, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`. No release or `--workspace` builds. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343. Never contact a real SSH host.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr2, branch `feat/native-host-check-clean`, now rebased onto origin/main (wave 2 PR 1 merged as #893): three commits, the original feature and the two fix-round commits (`HEAD~1`, `HEAD`). Prior review: `.work/reviews/wave2-pr2-review.md` (UNVERIFIED pending live; F1–F9). Fix brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave2-pr2-r1.md. Handoff "Fix round 1": `.work/reviews/wave2-pr2-handoff.md`; live evidence under `.work/fixtures/wave2-pr2-r1/` and `.work/live/`.

Follow `.agents/skills/project-review/SKILL.md`; apply `.project/reviewers/{security,qa,protocol-compat}.md` and `.project/rules/{security,api-protocol,rust,code-and-testing,repository}.md`.

Review `git diff HEAD~2..HEAD` and confirm the rebase changed nothing else in the feature commit:
1. F2: the HTTP enforcement-identity and app-session scenarios exercise the real routing and turn red with `authorize(ctx)?` removed (spot-check by mutation in a scratch copy under /tmp, discarded afterwards).
2. F3: the dry-run proof covers `strategy.yaml` bytes and task-store contents; judge the handling of the importer writing `60.0` (filed as #911, pre-existing) — the test must not mask a real write.
3. F6: `git_read_unmarked` in `pacer-repos` does not mark the path unreachable, is used only for the dry-run reads, and no other caller changed.
4. Live CT-11: read the fix round's reports (native 7 PASS/0 FAIL/4 UNVERIFIED, forward 6/0/0) and Core-side evidence (2 `/_internal/host-effects` natively vs 2 `/v3/ops/host.check` forced). Judge whether the admitted `host.check` evidence now satisfies the prior UNVERIFIED verdict, and whether the scratch-only Core POST log could have changed behavior.
5. F1, F4, F5, F9: the PR-description text in the handoff is accurate (CRATE-1 names the `pacer-server` split).
6. Checks: fmt, clippy, crate tests, loc, parity test; REPO-4 and hygiene for the new commits.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr2/.work/reviews/wave2-pr2-rereview.md`: verdict on the first line; scope, heads, reviewer identity; per finding status; new findings table; checks; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.
