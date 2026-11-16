# Task: independent QA review of the consumer-matrix reconcile-row wait and Link-latency remedy mask (REPO-10)

Executor: cursor-agent (default model, standard tier: a test-only timing fix in one file). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/matrix-reconcile, branch `test/matrix-reconcile-race`, head `58483fdc2`, one commit on `main` `d5035d17b`. Only `test/plugins-native-owner-matrix.test.ts` changes. The executor wrote and validated it as `6bebb474f` on an older base that also carried a usage-refresh settle commit; the coordinator rebased it onto `main` and dropped that settle commit, because `main` now has #946 (`d5035d17b`), which filters `budget_refreshed` out of `activityLines`. That filter stays (maintainer decision); do not suggest reverting it here.

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/matrix-reconcile-handoff.md (its evidence ran on the old base).
- Diagnosis: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/matrix-race-review.md, finding F1 and "Point 4".
- CI failure excerpt: /Users/vulam/orca/workspaces/pacer/pinfish/.work/fixtures/matrix-race/ci-941-reconcile.log.
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/matrix-reconcile.md.
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/code-and-testing.md`, `.project/reviewers/qa.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. `reconcileCommitted`: waits on the right signals (journal absent after the restored file appeared, manifest changed from the pre-restart bytes), cannot pass on a stale manifest, cannot hang (20 s deadline, loud failure), and paths match where reconcile writes (`install-transaction.json`, `install-manifest.json` under the state home). Check the journal order in `packages/plugin-sdk/src/install/journal.ts` and `src/install/reconcile.ts`.
2. The `integration` fingerprint assertion makes an all-modes-stale read fail.
3. The Link-latency mask drops only setup.health remedy repairs whose `check` is `Link` or `Link latency`; nothing else is masked, and `expectIdentical`, known lists and row coverage are unchanged.
4. Evidence on this head: build both front doors from it, `bun run typecheck`, the full matrix file twice (19 pass each), and once each: the forward-only delayed manifest write (old row fails with the CI diff, new passes) and a forced one-mode Link warn (old doctor row fails, new passes). Temporary edits only, reverted; `git status` clean at the end. Commit signed off and Conventional; no machine paths or personal emails.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache` (the shared sccache server is running; never stop it or start it inside a disposable HOME), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET -u PACER_HOST_SOCKET_KEY -u CARGO_TARGET_DIR`, with both front doors built from this head and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). Run `bun install --frozen-lockfile` first. One matrix run at a time; no added CPU load. Stop every process you started before you finish and confirm none remain.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/matrix-reconcile-review.md: the verdict (PASS / FAIL / UNVERIFIED) against head `58483fdc2`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with their results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-matrix-reconcile.md exactly. End with orca orchestration worker_done.
