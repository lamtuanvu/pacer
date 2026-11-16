# Task: independent re-review of wave 3 PR 4 fix round 1 (REPO-10)

Executor: cursor-agent (default model, frontier tier). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr4, branch `feat/owner-bridge-endpoint-orca`. Final head `58c65ee85`; the fix commits are `f57d33f8b` and `58c65ee85` on top of `ec28240ef` (the reviewed implementation, rebased onto `origin/main`).

Inputs:
- First review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-review.md (FAIL: B1, N1–N7).
- Handoff with the "Fix round 1" section: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-handoff.md.
- Fix brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave3-pr4-r1.md.
- Project rules: `.project/constitution.md`, `.project/context.md`, and the scoped rules and reviewers that match (security, plugins, testing, CT-11). Use `.agents/skills/project-review/SKILL.md`.
- Follow-up filed for N3's residual risk: https://github.com/lamtuanvu/pacer/issues/918.

## What to verify

1. **B1:** the empty credential-binding allowance in `src/plugins/registry.ts` now admits only `endpoint.launchEnv`. Keyless `endpoint.models` and keyless `classifier.ask` refuse flag-on with the base `plugin_unavailable` text, tests assert it, and a mutation widening the allowance turns them red (rerun at least that mutation yourself). Check no other path (Orca attempt, other methods passing `[]`) bypasses the narrowing.
2. **N1, N2:** invalid `executor.*` result refusal tests and the `$/progress` flag-off/flag-on tests exist, are meaningful, and the code comment, ledger row and CHANGELOG describe both behaviors accurately.
3. **N3:** `executorEnv` strips `PACER_HOST_SOCKET` for every executor launch path; the test would fail if the strip were removed. Look for other child-spawn paths that inherit the full environment and would still leak it (report them; nonblocking unless an executor gets it).
4. **N4:** the relay fixture's hello gate matches the Rust owner's behavior.
5. Regressions: run `bun run typecheck`, `test/plugins-native-owner-call.test.ts`, `test/serve-internal.test.ts` and the exec tests yourself inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, and `env -u PACER_TEST_NATIVE_FRONT_DOOR`. Cargo only if you need it: real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, one command at a time.
6. CT-11 evidence: the fix-round report at `.work/live/r1/evidence/report.md` in the worktree names head `58c65ee85` and its claims match the code.
7. CHANGELOG and ledger are accurate and contain no machine paths or personal emails; commits are signed off and Conventional.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-rereview.md: verdict (PASS / FAIL / UNVERIFIED) against head `58c65ee85`, a table of every original finding with its status, any new findings with severity and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.
