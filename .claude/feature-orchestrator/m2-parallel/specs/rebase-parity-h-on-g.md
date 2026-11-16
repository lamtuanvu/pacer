# Task: rebase PR #970 (owner parity H) onto main after PR #971 (G, caller authentication) merged

Executor: cursor-agent (default model, frontier tier: two overlapping owner designs must be reconciled in code, tests and ADR text). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-h, branch `fix/door-plugin-calls-via-core`, head `e2aa7694d` (backup branch `backup/parity-h-e2aa7694d`). `origin/main` is `3275b5e35` (#971) or later.

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`. In zsh, pass test file lists as separate words.

## Context

- H (#970): the door's own `plugin.doctor` and `plugin.ui.*` calls go through Core's sealed owner call (`relay` kind) instead of the door calling the owner directly (`call_door` and its flat 30 s deadline are removed); plus a `plugin-runtime` fix (`Shared::close` sets closed before failing pending calls). Reviews: `.work/reviews/parity-h-review.md`, `parity-h-rereview.md`, `parity-h-ci-rereview.md`; PR body `.work/reviews/parity-h-pr-body.md`.
- G (#971, merged): callers of the owner bridge prove a per-start key (mutual HMAC handshake; `OwnerKey`; `ProcessRpc::Attached` gained a key field; Core takes the key with `takeOwnerKey`; the supervision and background workers get it by init message). ADR 0027 item 9 and its consequences were rewritten. Reviews: `.work/reviews/parity-g-review.md`, `parity-g-rereview.md`, `parity-g-ci-rereview.md`.

## Do

1. `git fetch origin && git -c merge.conflictStyle=diff3 rebase origin/main`. A trial showed conflicts in the first commit (`e9ebac503`): `crates/server/src/native/plugins.rs` (imports: keep `OwnerKey`, drop what H removed; the call branch: H's `"call"`/`"relay"` selection with G's two-field `Attached(..)` pattern), `crates/server/src/native/plugins/tests.rs` (H removes test blocks G edited: keep G's still-relevant assertions, adapted to H's relay design, and H's new assertions), `docs/decisions/0027-one-native-plugin-owner-per-home.md` and `docs/testing/m2-ledger.md`. Later commits may conflict too (CHANGELOG, ADR, ledger).
2. Reconcile the meaning, not just the text. In particular ADR 0027: G says "the Rust door's own owner calls (`plugin.doctor`, `plugin.ui.*`) forward no Core method, so the owner refuses both with its own text"; after H those calls are relayed through Core's sealed call, so restate what is true now (who holds the key, what Core answers for door-originated relays, what the owner refuses). Keep G's item 9 residual-risk paragraph and follow-ups accurate (the stdin key transport is now in progress as a separate PR; #918 item 3 was closed by maintainer decision with deferred work in #973). Check every place where H's text and G's text describe the same mechanism.
3. Make sure H's relayed calls authenticate under G: the door's relay goes through Core, which holds the key; a stdio door's self-owned connection and an attached connection both work; no path calls the owner without the key.
4. Verify: fmt, clippy `-D warnings` (`pacer-server`, `pacer-plugin-runtime`, with and without `test-ops`), their tests, `xtask loc`/`deps` (see the sccache workaround in `w4-common.md` if xtask reports "No such file or directory"), typecheck; with both front doors built from the rebased head: `test/native-plugin-*.test.ts`, `test/plugins-native-owner-*.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/host-bridge-auth.test.ts`, `test/serve-internal.test.ts`, `test/plugins-observations-native-kinds.test.ts`, and any test either PR changed. Run the crash suite 5 times.
5. CT-11: a short `bun run live` with the Rust front door and the owner flag on: web or CLI plugin doctor and a UI action through the serve door and a stdio door, showing the relayed calls succeed under caller authentication.

Do not push. Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-rebase-g-handoff.md: each conflict and how you resolved it (with the reasoning for every semantic choice), `git range-diff` summary against `e2aa7694d`, checks, CT-11, and an updated PR body (from `.work/reviews/parity-h-pr-body.md`, with a "Rebase onto #971" paragraph). A security re-review of the rebase follows.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rebase-parity-h-on-g.md exactly. End with orca orchestration worker_done.
