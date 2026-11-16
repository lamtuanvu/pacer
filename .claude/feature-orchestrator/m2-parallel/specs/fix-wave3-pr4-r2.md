# Task: wave 3 PR 4 fix round 2, strip the owner socket from the enforcement canary

Executor: cursor-agent (default model). Small, security-relevant fix. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr4, branch `feat/owner-bridge-endpoint-orca`, head `58c65ee85`. Re-review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-rereview.md (FAIL on R1 only; read R1 and I1). Not pushed.

## Fix (coordinator decision: fix, not downgrade)

- **R1:** `probeNativeControl` in `src/dispatch/enforcement.ts` (around lines 328–341) builds the canary agent's environment from `ctx.env` and keeps `PACER_HOST_SOCKET`. Remove it there. Prefer the smallest change that keeps the canary's current behavior (`delete env.PACER_HOST_SOCKET;` beside the existing deletes); only switch to `executorEnv` if it keeps the account-folder logic and every existing enforcement test green, and say which you chose and why.
- Add a test in `test/dispatch-enforcement-certification.test.ts` (or the closest existing canary test) that the canary's `execProcess` environment has no `PACER_HOST_SOCKET` when the service environment has one. Show it red without the strip (log under `.work/fixtures/wave3-pr4-r2/`).
- Keep the CHANGELOG line ("Executors no longer inherit `PACER_HOST_SOCKET`") accurate; adjust the wording only if needed. Amend nothing in earlier commits; add one new commit.
- I1 is informational for PR 6; no change.

## Checks

Inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_TEST_NATIVE_FRONT_DOOR`: `bun run typecheck`; the enforcement tests (`rg -l "probeNativeControl|enforcement" test`), `test/plugins-native-owner-call.test.ts`, the exec tests; `git diff --check`. No Rust changes expected; no cargo needed. CT-11: the canary path's environment is covered by the unit test; no new live run is required unless you change more than this path (then rerun the r1 live flow).

Commit: `fix(dispatch): keep the native owner socket out of the enforcement canary`, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`.

## Handoff

Append a "Fix round 2" section to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr4-handoff.md`: commit, change, test and red evidence, checks. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave3-pr4-r2.md exactly. End with orca orchestration worker_done.
