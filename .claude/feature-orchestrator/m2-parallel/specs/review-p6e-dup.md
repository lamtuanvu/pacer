# Task: independent review of PR #953 — load awaitsAnswer once in the P6e reference (REPO-10)

Executor: cursor-agent (default model, light tier: a two-line test-fixture fix). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Aim to finish within 20 minutes.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/p6e-dup, branch `fix/p6e-reference-duplicate`, one commit on `main` `1568b0320`. `main` fails `bun run typecheck` because `test/fixtures/p6e/reference.ts` declares `awaitsAnswer` twice (from #933 and #931 both injecting it). The commit removes the second `load` and the repeated property in the attention rules scope.

PR body: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/p6e-dup-pr-body.md. Rules: `.project/rules/code-and-testing.md`, `.project/reviewers/qa.md`.

Verify: the remaining `awaitsAnswer` binding still reaches both `src/api/read-model/tasks.ts` and `src/attention/rules.ts` scopes with the same function; nothing else in the fixture was duplicated by the same merge (check `git log -p -3 -- test/fixtures/p6e/reference.ts` on `main`, including `AGENT_BINS`); `bun run typecheck` passes; `bun test test/p6e-parity.test.ts` passes (use a disposable `mktemp -d` HOME under `/tmp` and `PACER_HOME=$HOME/.pacer`, `env -u PACER_HOST_SOCKET`). Commit signed off and Conventional.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/p6e-dup-review.md with verdict (PASS / FAIL) and findings. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-p6e-dup.md exactly. End with orca orchestration worker_done.
