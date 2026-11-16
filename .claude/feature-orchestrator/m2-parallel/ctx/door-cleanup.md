# Task: remove the door-call path from `pacer-plugin-runtime` that owner parity H and R1 left unused

Executor: cursor-agent (default model, small tier: deleting dead code with no behavior change). No subagents. Never use `git stash`. Follow the environment, safety, sandbox and commit sections of /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md; ignore its wave 4 plan references. Never start the shared sccache server from a disposable HOME: keep your real `HOME` and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache` for any command that compiles Rust, or build with `RUSTC_WRAPPER=`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/door-cleanup, branch `chore/remove-door-call`, on `origin/main` `f25c257cd` (#963 merged).

Background: since owner parity H (#970), the serve and stdio doors relay plugin calls through Core, and since R1 (#963) every owner path sends `plugin.hello` from the owner's sealed call. On `f25c257cd`, nothing outside `crates/plugin-runtime/src/bridge_call.rs` and `owner.rs` uses `call_door`, `DoorCall`, `DoorReady`, `ready_info`, or the lane's `door_hello` flag (`note_door_hello`, `forget_door_hello`, `door_helloed`); `lib.rs:48` only re-exports them. Recheck this with `rg` across `crates/`, `src/`, `test/` and `docs/` before you delete anything.

Do:
1. Remove the unused items and every helper, field, branch and test that exists only for them (for example the `note_door_hello` call in `bridge_call.rs` and the `door_hello` field in `owner.rs`). Keep `CallFailure` and anything else that still has a caller. If an item turns out to be used, keep it and say why in the handoff.
2. Update rustdoc, `docs/testing/m2-ledger.md`, ADR 0027 or CHANGELOG text that describes the door's own hello or `call_door` as current; leave historical entries as history. Report CRATE-1 LOC before and after for `pacer-plugin-runtime` (`cargo xtask loc`).
3. Checks: `cargo fmt --check`, clippy `-D warnings` for the workspace with and without `pacer-server/test-ops`, `cargo test -p pacer-plugin-runtime` and `-p pacer-server`, `cargo xtask loc --check` and `deps`, `bun run typecheck`, and with front doors built from your head the Bun suites `test/plugins-native-owner-*.test.ts`, `test/native-plugin-ops*.test.ts` and `test/host-bridge-auth.test.ts`.
4. CT-11, proportionate to a dead-code removal: one `bun run live` run with `--front-door rust --native-plugin-host` showing `plugin.doctor` and a fixture plugin call over HTTP and stdio still answer as before (fixture homes, separate port; stop everything you start). Record the evidence summary.
5. Commit with `git commit -s` as Vu Lam <lamtuanvuqs@gmail.com>, title `refactor(plugin-runtime): remove the unused door-call path`. Do not push.

Output: a handoff at /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/door-cleanup-handoff.md with what was removed, what was kept and why, LOC, checks, CT-11 summary and a draft PR body. Report with `orca orchestration worker_done`. Always end with worker_done.
