# Context: m2-runner-ops — Implement runner.check native in Rust

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops
Branch: m2/runner-ops

## Goal
Implement `runner.check` as a native Rust operation in `pacer-config-ops` or a new crate.

## Current State (from ledger)
- `runner.check` is **Forwarded (P2/P6)**
- "The check steps (CLI, sign-in, usage and the scratch test task) run in the TypeScript job owner (`src/core/runner-check.ts`, `src/jobs/registry.ts`); native `job.*` only read and cancel its job file."

## Requirements
1. Create native `runner.check` op that runs the check steps
2. Use `pacer-lifecycle::jobs` for job orchestration
3. Run check steps (CLI, sign-in, usage, scratch test task) natively where possible
4. Selective forward for inputs only TypeScript can answer
5. Update ledger: move from Forwarded to Native (selective)

## Files to Modify
- `crates/config-ops/src/runner_ops.rs` - add runner_check_ops module
- `crates/config-ops/src/lib.rs` - export new module
- `crates/server/src/native.rs` - register native op
- `crates/server/src/native/runner_check_sync.rs` - Core bridge for check steps
- `docs/testing/m2-ledger.md` - update ledger
- `test/native-runner-check-parity.test.ts` - new parity test

## Key Considerations
- `runner.check` with `test: false` can be native; `test: true` or omitted forwards
- The check job runs in TypeScript job owner; native version needs job bridge
- Reuse `pacer-lifecycle::runner_check` library if exists

## Acceptance Criteria
- `test/native-runner-check-parity.test.ts` passes
- `cargo test -p pacer-config-ops -p pacer-server` passes
- `cargo clippy --locked -p pacer-config-ops -p pacer-server --all-targets -- -D warnings` passes
- `cargo fmt --all --check` passes
- Ledger updated correctly
