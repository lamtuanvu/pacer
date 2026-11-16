# Task: M2 wave 2 PR 2 — answer host check and clean refusals and dry runs natively (Rust)

Executor: cursor-agent (default model). Security-sensitive Rust routing over the sealed host-effects bridge (auth, enforcement refusal, work-grant forwarding); frontier tier. No time limit; finish implementation, tests, live validation where possible, and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr2, branch `feat/native-host-check-clean`, stacked on wave 2 PR 1 (`feat/host-effects-bridge` at `13a077eea`, open as #893, reviewed PASS, not merged yet). Run `bun install --frozen-lockfile` first. Build only the crates you touch (`cargo test -p ...`, one cargo command at a time, `CARGO_INCREMENTAL=0`); build the debug `pacer` binaries once for the differential and live run; never run release or `--workspace` builds. Disk and memory are shared with other workers.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave2-host-effects.md` in full, especially §1, §2, §3, "PR 2", §5, §6 and §7. The maintainer accepted all eight recommendations (Q1–Q8). PR 1's handoff and review: `.work/reviews/wave2-pr1-handoff.md` and `.work/reviews/wave2-pr1-review.md` in /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr1 (copy what you need; do not edit that worktree). Recheck every cited file:line; the plan was read, not run.

## Scope (PR 2 only)

Exactly the plan's "PR 2" section: rewrite `crates/config-ops/src/host_check_clean_setup_ops.rs` (flat params, unknown-host first, pass-through errors, enforcement refusal, selective `host_stays_forwarded`, native dry-run arm with the `CommandGit` transfer gate); register `host.check` and `host.clean` in `crates/server/src/native.rs` with a `needs_host_effects` predicate and dispatch arms; host-effects futures in `crates/server/src/serve/mod.rs`; stdio refusals and dry-run native with admitted calls forwarded in `crates/server/src/stdio_proxy.rs`; the `host.effects` route in `crates/core-bridge/src/` calling PR 1's whole-operation bridge (`/_internal/host-effects`, `_internal.host.effects`); update `crates/server/src/native/tests/mod.rs` registration lists; ledger rows per §5. Also fix wave 2 PR 1 review finding N2: the module comments at the top of `host_check_clean_setup_ops.rs` (and around lines 50–53) still describe a per-effect protocol and say Core doesn't serve the bridge yet; rewrite them to the whole-operation contract. Do not touch `host.repo.setup` registration (PR 3). Do not touch the live harness (PR 4 is a separate worker).

## Tests

`test/native-host-check-clean-parity.test.ts` per the plan (the `native-host-set-parity` pattern with PR 1's test core, fake ssh `test/fixtures/bin/ssh` + `PACER_FAKE_HOST_HOME`, `PACER_FORWARD_OPS` comparison, stdio and HTTP): byte-identical replies and on-disk effects for admitted `host.check` and non-dry-run `host.clean`, including `{job}` shape and error bodies (unreachable host, clone/identity failures, unknown host); traces showing the bridge call natively vs the op method when forced forward; dry runs native and byte-identical with proof nothing was written; enforcement token refused natively; work-grant caller forwards; job dedupe for the same kind and target. Every new test must fail without its fix (show red evidence for at least the refusal and dry-run arms). Temp homes, no fixed ports.

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`: `cargo fmt --check`, clippy `-D warnings` and tests for `pacer-config-ops`, `pacer-core-bridge`, `pacer-server`; `cargo xtask loc --check` (state the CRATE-1 paragraph for `pacer-config-ops` crossing 5,000 and `pacer-server` above 8,000, per the plan and maintainer decision Q7 of wave 1); `cargo xtask deps`; `bun run typecheck`; the new parity test plus existing host tests (`rg -l "host\.check|host\.clean|host-effects" test`); `git diff --check`.

## Live validation (CT-11)

Wave 2 PR 4 (fake-ssh live fixture) is being built in parallel and lands after this PR. Run what the harness supports today: `bun run live up --front-door rust --native-test-ops` on a disposable sandbox, exercise `host.check` and `host.clean` refusals and dry runs through the CLI front door, HTTP (D8 proxy; record D8 refusals as notes) and stdio, compare with a forced-forward sandbox, and read the report summary. Mark admitted `host.check` against a fake host UNVERIFIED live, pending PR 4, with the e2e differential as the op-level evidence. Stop every session (`live down --keep`) and confirm no processes remain.

Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>` (check `git config user.email`). Do not push. No subagents.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343. Never contact a real SSH host.

## Handoff

Write `.work/reviews/wave2-pr2-handoff.md` in the worktree: commits, what changed per file, routing table (native vs forwarded per caller and params), sealing and enforcement evidence, test results with counts and red evidence, LOC and the CRATE-1 text, live report summaries and UNVERIFIED items, and anything left for PR 3/PR 4. Report with `orca orchestration worker_done`. Always end with worker_done.
