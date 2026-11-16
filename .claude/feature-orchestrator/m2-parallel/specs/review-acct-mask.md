# Task: independent review of PR #960 — mask whole-second timestamps in the native account parity events (REPO-10)

Executor: cursor-agent (default model, light tier: a one-line test mask fix). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Aim to finish within 15 minutes.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/acct-mask, branch `test/account-parity-whole-second`, one commit on `main`. PR body: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/acct-mask-pr-body.md. Rules: `.project/rules/code-and-testing.md`, `.project/reviewers/qa.md`.

Verify: the new regex in `test/native-account-parity.test.ts` (`events()`) masks every generated timestamp form the core writes (read where activity ids and `config` event `at` values are produced in `src/` and the Rust door, and their units — seconds with ms fraction?), and masks nothing that should be compared (numeric ids, counts, small `at` values, any other 10+ digit field named `id`/`at`). Confirm the mask is the same on both sides of the comparison so it cannot hide a real native/forwarded difference. Typecheck passes. Running the test needs front doors; /tmp/am-fd/pacer-plain and /tmp/am-fd/pacer-native were built from this head (use them as `PACER_TEST_FRONT_DOOR` / `PACER_TEST_NATIVE_FRONT_DOOR` with a disposable `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, `env -u PACER_HOST_SOCKET`). Commit signed off and Conventional.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`.

Output: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/acct-mask-review.md with verdict (PASS / FAIL) and findings. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-acct-mask.md exactly. End with orca orchestration worker_done.
