# Task: owner parity PR B — run the door's native plugin calls through the sealed owner call

Executor: cursor-agent (default model, frontier tier). Security-sensitive: the owner bridge and call-scoped capability authority. No subagents. No time limit; finish implementation, tests, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-b, branch `fix/owner-sealed-door-calls`, stacked on wave 3 PR 6 (`test/native-owner-consumer-matrix` at `2951c0aeb`, under review, not yet open as a PR). PR 6's routed `test.failing` tests are in your base; the coordinator rebases you onto `main` after PR 6 merges. Parallel PRs A (owning-call authority: `src/plugins/native-call-authority.ts`, `registry.ts` `nativeIssueCallAuthority`, `crates/plugin-runtime/src/capability.rs`), C (plugin stderr: `process.rs`, a new `plugin_log.rs`, one field in `owner.rs`) and D (`crates/plugin-host` framing) run at the same time: stay out of their files except where the plan's overlap map says otherwise, and keep your `registry.ts` changes to the functions the plan names. Run `bun install --frozen-lockfile` first. Build only the crates you touch (one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`); never release or `--workspace` builds. Other Rust workers run at the same time; keep memory modest.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`, ADR 0027, `docs/testing/m2-ledger.md` rows 22–24, `docs/testing/live-validation.md`, and:
- The plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md — "PR B" in §2, and the §1 triage of items 4 (part 1), 5, 7, R1, R2, R3, R4 and D2, D3 (root causes, TypeScript references, tests).
- PR 5 re-review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-rereview.md (R1–R4).
- PR 6 handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-handoff.md.
Recheck every cited file:line against your base. If the code contradicts the plan, follow the code and record the deviation; stop and ask through `orca orchestration` only if a deviation changes the security model.

## Scope

As "PR B" in the plan: `call_native` in `crates/server/src/native/plugins.rs` becomes spawn spec + call authority + one `call_sealed` through a door-local public entry in `crates/plugin-runtime/src/bridge_call.rs` (no `core_forward`); delete `flush_capability_logs` and route call-scoped `capability.log` lines to the plugin log with their level; send `ready` on Core's state; the sealed observation bootstrap token as `_meta.capabilityCall` (per-call token for reentrant plugins); `is_stopping` checks after acquiring a turn and a closing check in `lane_for_call` (R3); mark ready inside the hello turn (R2); the `Failing` refusal hint (R4 code part); `nativeSpawnSpec` returns `state`, the `log` kind carries an optional level. Keep PR 6's `plugin_reply_error` mapping and the `ui.*` hints. Drop the hosts/orca/worktree/executor binding in `call_native` only after confirming no method that reaches it gets those resources.

Out of scope: the owning-call authority (PR A), stderr (PR C), framing key order (PR D), runner sockets (PR E), observation generations (PR F, so the observation doctor still fails after bootstrap), bridge caller authentication (PR G / #918).

## Tests

Flip `ROUTED_REENTRANT` (conformance) and `native-plugin-ops-stdio.test.ts`'s routed idle-state test to plain passing tests; the observation doctor gets past bootstrap (keep its event assertion expected-fail with the reason updated). Rust tests for R1 (an unsealed call never sees a concurrent native call's call-scoped session), R2 (one hello and one `ready` under two concurrent first calls), R3 (a call admitted on a stopping lane or closing roster fails `plugin_unavailable` without writing to the child), the R4 hint, and a call-scoped `capability.log` line reaching the plugin log with its level tag. Every new test must fail without its fix; save red logs. Keep PR 5's shutdown-with-a-call-in-flight tests green.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer` (real CARGO_HOME, RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`. Both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-plugin-runtime`, `pacer-server` and any crate you touch; `cargo xtask loc --check` (state CRATE-1 for both), `cargo xtask deps`; `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/native-plugin-crash.test.ts`, `test/serve-plugin-native.test.ts`, `test/native-dispatch.test.ts`, `test/live-harness.test.ts`; `git diff --check`. Save logs under `.work/fixtures/parity-b/` in this worktree.

## Live validation (CT-11)

Per the plan's PR B: `bun run live up --front-door rust --native-plugin-host`, `bun run live native-plugin-owner` (crash, backoff, failing hint) and `native-plugin-stdio` (attached start, then serve's `plugin.list` shows `ready`); two overlapping `plugin.doctor` calls on a reentrant fixture; a flag-off sandbox for comparison; `bun run live report`. Temporary sandboxes only; never ports 4317, 11434, 1234, 41343; tear down and confirm no processes, sockets or sidecars remain. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app` or `com.pacer.serve`.

## Commits and output

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>), small logical commits. Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-b-handoff.md`: commits, per-file changes, design as built with code references, deviations from the plan, test results with counts and red evidence, LOC and CRATE-1 text, live report summary with UNVERIFIED items, follow-ups, and a draft PR body following `.github/pull_request_template.md` (include the executor and model tier line). Report with `orca orchestration worker_done`. Always end with worker_done.
