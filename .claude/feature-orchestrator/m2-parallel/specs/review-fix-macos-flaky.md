# Task: independent review of the macOS flaky-test fix for issue #890 (REPO-10)

Executor: OpenCode Go GLM 5.3, independent reviewer. You did not write this code. Read-only: do not edit tracked files, commit, push or start live sessions. You may run `git`, `bun run typecheck` and focused `bun test` files, serially, inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a fresh `mktemp -d` `HOME`, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`, `--timeout 30000`. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-macos-flaky, branch `fix/macos-flaky-tests`, base origin/main `acab1eca4`, 4 test-only commits (`8299c1584`, `43074aa6c`, `d9e98080f`, `e51dfec32` head), 3 files, +57/−37. Implementer handoff: `.work/reviews/fix-macos-flaky-handoff.md` in the worktree. Issue: `gh issue view 890` (and its comments) lists the flaky tests. Brief the implementer had: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-macos-flaky.md.

Follow `.agents/skills/project-review/SKILL.md`. Apply `.project/reviewers/qa.md` and `.project/rules/{code-and-testing,repository}.md`.

Review:
1. Each fix addresses the stated root cause rather than hiding it: the path-probe cache leak across shard files (canonical repo roots in the task-list repo-filter tests), orphan cleanup with late forks, slow session hosts and an exiting wrapper read as PID reuse (fork-once agent, deadline waits, waiting for the killed wrapper to exit in the stop tests), and a cold per-HOME `xcrun git` exceeding the 2 s `registerRepo` bound (stored repo identity in the detached-runner test). Confirm no production code and no production timeouts changed, and no test was weakened (assertions removed, timeouts merely raised, retries that mask real failures, skips).
2. Do the tests still check the behavior they were written for? For the stop tests especially: they must still fail if orphan cleanup or missing-exit handling regresses (spot-check one by mutation of the production code in a scratch copy under /tmp, then discard).
3. Read the handoff's two "conservative orphan-cleanup production observations": are they real production bugs that need an issue, or test artifacts? Say which, with evidence.
4. Coverage of #890: which listed flakes are fixed, which are left (stdio msg parity needs Rust; the self-update 300 s timeout and the settings-sliders 15 s timeout from the issue comments), and whether the PR should say "Refs #890" rather than "Fixes #890".
5. Run the touched test files several times (at least 5 runs each, serially) and report pass counts.
6. REPO-4: signed-off commits, Conventional Commit subjects, identity Vu Lam; no `.work/` paths, machine paths or personal emails in added lines.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-macos-flaky/.work/reviews/fix-macos-flaky-review.md`: verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, base, head, reviewer identity (OpenCode Go GLM 5.3); findings (rule, severity blocking/nonblocking, location, evidence, impact, remedy), introduced separate from pre-existing; checks run with results; what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and execute the review brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-fix-macos-flaky.md. Read-only review. Always finish with orca orchestration worker_done.
