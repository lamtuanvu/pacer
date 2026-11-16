# Task: independent review of PR #955 — expect the takeover progress focus ring on :focus-visible (REPO-10)

Executor: cursor-agent (default model, light tier: a one-line test fix). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Aim to finish within 15 minutes.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/focus-test, branch `fix/takeover-focus-visible-test`, one commit on `main` `e01b80032`. `main` fails `test/desktop-shell.test.ts` ("takeover disabled choice and progress focus are visible with shell tokens") because #943 (`1568b0320`) changed `desktop/ui/shell.css` from `#takeover-progress:focus` to `#takeover-progress:focus-visible`; the commit updates the test's regex to match.

PR body: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/focus-test-pr-body.md. Rules: `.project/rules/code-and-testing.md`, `.project/reviewers/qa.md`, and any UI rules in `.project/rules/` that cover focus visibility.

Verify: #943's intent (read `git show 1568b0320`) and that the updated assertion still checks a visible focus ring for keyboard focus, not a weakened check; whether any other test or generated asset (`src/app/assets.generated.ts`, `app/src/styles.css`) still expects the old `:focus` rule; `bun test test/desktop-shell.test.ts` and `bun run typecheck` pass (disposable `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`). Commit signed off and Conventional.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/focus-test-review.md with verdict (PASS / FAIL) and findings. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-focus-test.md exactly. End with orca orchestration worker_done.
