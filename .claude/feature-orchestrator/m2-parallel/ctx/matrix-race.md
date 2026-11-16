# Task: fix the consumer matrix's usage-refresh race (N9) — test only

Executor: cursor-agent (default model; test-only change, GLM quota exhausted). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/matrix-race, branch `test/matrix-usage-refresh-race`, on `main` `2c019db4f`. Run `bun install --frozen-lockfile` first.

Read first: AGENTS.md, `.project/rules/code-and-testing.md`, and the finding: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-rereview.md (N9, around lines 59–63).

## Problem

`test/plugins-native-owner-matrix.test.ts` "doctor and setup consumers: doctor.run, setup.check and setup.health" fails intermittently on required CI (latest: PR #941, ubuntu shard 3, "activity: http forward vs http off"; excerpt in /Users/vulam/orca/workspaces/pacer/pinfish/.work/fixtures/matrix-race/ci-941-shard3.log). `usageRefreshSettled` (around `:121-130`) waits for `arkcli.log` and `codex-cursors.json`, then a fixed 500 ms; the `budget_refreshed` activity line is appended later by `src/link/pump.ts` (around `:128`), and the 20 s deadline carries on silently. So one mode's activity sometimes lacks the `budget_refreshed` line.

## Fix

- Make the settle condition deterministic: wait for the observable end of serve's background usage refresh (the `budget_refreshed` activity line, or whatever `src/link/pump.ts` writes last) in every HTTP mode before comparing, instead of a fixed sleep.
- Fail loudly with a clear message at the deadline instead of continuing.
- Check the other matrix rows that compare activity for the same race (the PR 4 endpoint shapes row has been reported flaky too) and fix them the same way if they share the cause.
- Do not weaken the comparison (no masking of `budget_refreshed`, no dropping rows) — the matrix is the default-on gate for PR 7. Do not change product code.

## Validate

Run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache` (shared server already running; never stop it), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, sandbox-bin first on `PATH`, `env -u PACER_HOST_SOCKET -u CARGO_TARGET_DIR`, with both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). `bun run typecheck`; run the full matrix file at least 5 times, including 2 runs under CPU load (for example a concurrent `yes > /dev/null` per core for the duration, killed afterwards) — all must pass. Show the old code fails under the same load at least once if you can (red evidence), or explain why it could not be forced. Live validation (CT-11) is not required: test-only, no runtime change; say so.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Output

Commit with `git commit -s` (`test: wait for the background usage refresh in the consumer matrix`). Do not push. Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/matrix-race-handoff.md: the change, runs and results, red evidence, and a short draft PR body. Report with `orca orchestration worker_done`. Always end with worker_done.
