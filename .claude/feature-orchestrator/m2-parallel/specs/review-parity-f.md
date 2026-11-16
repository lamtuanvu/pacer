# Task: independent review of owner parity PR F — observation generations under the native owner (REPO-10)

Executor: cursor-agent (default model, frontier tier: task-data authority and a cross-process event channel; GLM quota is exhausted). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-f, branch `feat/owner-observation-generations`, head `ef73883c9`, seven commits (`8d3a35f93..ef73883c9`) on PR B (`693b1b182`, reviewed PASS, not yet merged; it will be rebased onto main after wave 3 PR 6 / #931 merges).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-f-handoff.md (design as built, deviations, tests, CT-11 evidence).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-f.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR F" in §2, item 4 and D4 in §1). Maintainer decision Q2: port observations before default-on; PR F gates PR 7.
- Project rules: `.project/constitution.md`, `.project/context.md`, and the scoped rules and reviewers that match (security, rust, rust-crates, api-protocol, code-and-testing, architecture, performance, CT-11). Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Authority.** The sealed `observation.generation` (SHA-256 of the observation fingerprint) cannot be forged or replayed by a plugin child or a bridge peer. The Core kinds (`nativeObservationOwner`, `nativeObservationEvents`, `nativeObservationRead`, `nativeObservationRetired`) recheck enabled, declared, granted and fingerprint on every request; they are refused without the owning door's Core connection and on a `host.sock` relay. A plugin cannot read tasks or events it did not subscribe to, or another plugin's generation. Task reads go through `answerTaskCapability` with the same limits as TypeScript.
2. **Parity with the TypeScript host** (`src/plugins/`): event filtering (subscribed types plus `reset`), `since: null`, cursor handling, `$/event` frame bytes (JS key order and number text), retirement on disable, crash, host close, and a fingerprint change at call admission. Judge each listed deviation: is it acceptable, or a blocking divergence before default-on? In particular:
   - the idle session refuses `secrets.resolve` and `identity.sign`, which the TypeScript registry answers outside a call (does any shipped plugin, the budget example included, depend on this?);
   - `config.get` answers with the config sealed at hello (stale after a config change without restart?);
   - a Core `unavailable` refusal is retried on the next tick, and a Core `capability_denied` stops the child without recording a failure;
   - the idle session answers one request at a time.
3. **D4 routing** (`process.rs` around `:109`, `:205`, `:700`): no request sent between calls is answered by the next call's session; requests queued before the idle session exists cannot leak authority into a later call; there are no deadlocks or unbounded queues.
4. **Performance and resources.** The 100 ms pump per lane: cost with many plugins, bounded memory when the plugin stops reading, backpressure through `notify_bounded`, and pump tasks ending on retirement (no leaked tasks or children).
5. **The conflict with PR A** in `capability.rs` (`ObservationState`, imports): is the rebase mechanical, and does A's call-authority seal still cover observation requests afterwards?
6. Every new or flipped test fails without its fix (spot-check two of the red logs in `.work/fixtures/parity-f/` by rerunning the mutation); the removed test `requests_between_calls_go_to_the_next_call` only encoded the D4 bug; `ROUTED_OBSERVATIONS` set to `null` is honest on both doors; the stdio-only byte comparison is not hiding a serve divergence. The CT-11 evidence (`.work/live/pfon`, `.work/live/pfoff`) names this head and matches the code. ADR 0027 addendum, CHANGELOG and ledger are accurate; no machine paths or personal emails; commits are signed off and Conventional; CRATE-1 numbers are correct.

Regressions: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`, with both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report the counts that ran. The worker's `.work/fixtures/parity-f/run.sh` shows the setup it used. One cargo command at a time, debug; other Rust workers (PR E, PR G) run at the same time, so keep memory modest. Known: `native_run` capability tests fail in sbx-deny (setuid `/bin/ps`), and the matrix "PR 4 endpoint shapes" activity-order race is pre-existing (rerun once and say so).

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

Tests to run: clippy `-D warnings` and tests for `pacer-plugin-host`, `pacer-plugin-runtime`, `pacer-server`; `bun run typecheck`; `test/plugin-conformance-native-owner.test.ts`, `test/plugins-observations-native-owner.test.ts`, `test/plugins-observations-native-kinds.test.ts`, `test/plugins-observations-negative.test.ts`, `test/plugins-policy-budget-example.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugin-conformance.test.ts`.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-f-review.md: the verdict (PASS / FAIL / UNVERIFIED) against head `ef73883c9`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with their results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-parity-f.md exactly. End with orca orchestration worker_done.
