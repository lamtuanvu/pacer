# Task: fix the flaky macOS test shards on main (issue #890)

Executor: cursor-agent (default model). Root-cause debugging of timing-dependent TypeScript tests; not a small task. No time limit; finish the fixes, checks and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-macos-flaky, branch `fix/macos-flaky-tests` at origin/main `acab1eca4`. Run `bun install` first. Avoid Rust builds: another worker is building Rust, and disk is tight (about 15 GiB free). If a test needs the Rust binary, leave that test out and say so.

Read first: AGENTS.md, `.project/rules/{code-and-testing,repository}.md`, `.project/reviewers/qa.md`, and issue #890 (`gh issue view 890`). Use the systematic-debugging approach: reproduce, find the cause, then fix.

## Scope

The tests in #890's table, except the stdio msg parity test (it needs the Rust binary). For each one:
1. Find why it can fail under load. Reproduce locally if you can, for example by running the file repeatedly, in parallel with other shards, or with CPU load (`bun run test:sharded` is what CI runs; see `package.json` and `.github/workflows/ci.yml` for the shard setup).
2. Fix the cause in the test or a test seam, for example a test-scoped timeout, a wait for the path probe instead of a race, or a deterministic clock. Do not add retries, do not raise global test timeouts, and do not change the production 2-second bounds in `src/core/repos.ts`, `src/core/path-probe.ts` and `src/tasks/creation-admission.ts`. A production change is allowed only if it fixes a real bug; explain it in the handoff.
3. Show the fix: run the file at least 20 times under load before and after, and record the failure counts.

If a test's cause cannot be found, leave it unchanged and record what you tried.

Commits: Conventional Commits, `git commit -s` (for example `test: wait for the path probe in repo filter tests`). Do not push.

## Checks

Serial and inside sbx-deny, with disposable HOME and PACER_HOME, TZ=Asia/Ho_Chi_Minh: `bun run typecheck`, the touched test files, and `git diff --check origin/main..HEAD`. Test-only changes need no live validation; if you change production code, say so in the handoff so the coordinator can schedule CT-11.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343.

## Handoff

Write `.work/reviews/fix-macos-flaky-handoff.md` in the worktree: per test the cause, the fix, before and after failure counts with the exact commands, commits, tests left unchanged and why. Report with `orca orchestration worker_done`. Always end with worker_done.
