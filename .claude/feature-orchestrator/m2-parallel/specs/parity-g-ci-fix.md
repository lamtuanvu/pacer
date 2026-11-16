# Task: fix PR #971 (owner parity G) CI failure — detached stop reconcile has no owner key after the rebase onto #959

Executor: cursor-agent (default model, frontier tier: owner credential plumbing). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-g, branch `fix/owner-bridge-caller-auth`, head `6cbb25e86` (PR #971, auto-merge on; rebased onto #959 by the coordinator, verified only with typecheck and cargo check).

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`.

## Failure (CI, ubuntu, shard 3, deterministic as far as we know)

`test/plugins-native-owner-detached-stop.test.ts` — "serve stops an orphaned direct attempt flag-on as flag-off: stopped/143 and the executor is gone". Flag off passes. Flag on gives `state: running`, `exitCode: null`, `codexAlive: true` and four `reconcileErrors`:

```
pacer: task t-… stop reconcile failed: CoreError: native process owner credential is missing
```

The message comes from `src/plugins/host-bridge.ts:169` (no key taken). #959 (merged, "stop and inspect detached executor runs under the native owner") added a stop-reconcile path that runs in a Core process which G does not hand the key to. G hands the key over through `takeOwnerKey` in `src/cli.ts` and in `src/serve/background-worker.ts` (an IPC message).

## Do

1. Reproduce locally (Linux CI; macOS should reproduce too) with both front doors built from the head, in `sbx-deny`, disposable HOME and `PACER_HOME`, `env -u PACER_HOST_SOCKET -u PACER_HOST_SOCKET_KEY -u CARGO_TARGET_DIR`.
2. Find which process runs the reconcile (a serve Core child, a sweep, a background worker, a CLI child) and how it should get the key, following G's design (ADR 0027 as amended in this branch): only Core processes the owner started or vouches for get the key; it never reaches executors, plugins or logs. Do not widen exposure to make the test pass. If the right fix is that this path should not need the key (for example the call should go through a process that already holds it), do that.
3. Run the whole detached-stop suite, G's caller-auth tests, the owner suites touched by #959 and G (`plugins-native-owner-*`, `native-plugin-*`, serve auth, background worker), fmt, clippy `-D warnings`, the crate tests you touch, typecheck. Show the failing test red before the fix and green after. Run the failing test 5 times.
4. Check whether any other #959 path (detached inspection, remote stop grants) has the same gap; cover it with a test if so.
5. CT-11: if the fix changes runtime behaviour, a short `bun run live` run with the Rust front door and the owner flag on that stops a detached fixture run. Otherwise say why not.

Commit with `git commit -s` (`fix(plugins): …`), do not push. Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-g-ci-fix-handoff.md with root cause, fix, evidence and a PR-body paragraph. A security re-review follows.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-g-ci-fix.md exactly. End with orca orchestration worker_done.
