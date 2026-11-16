# Implementation Task: m2-runner-ops — runner.check native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-runner-ops

## Task
Implement `runner.check` as a native Rust operation. Do this step by step:

### Step 1: Create the runner check ops module
Create file: `crates/config-ops/src/runner_check_ops.rs`
- Add module with `runner_check` function
- Validate params: runner id, optional `test` flag
- If `test: true` or omitted, return `Forwarded` (needs job orchestration)
- If `test: false`, run checks natively:
  - Detect agent CLI
  - Check sign-in status
  - Read usage
  - Run scratch test task (forward to job bridge)
- Return results matching TypeScript format

### Step 2: Export the module
In `crates/config-ops/src/lib.rs`: add `pub mod runner_check_ops;`

### Step 3: Register native op
In `crates/server/src/native.rs`:
- Add `use pacer_config_ops::runner_check_ops;`
- Add `NativeOp { name: "runner.check", call: runner_check_ops::runner_check_stub, }`
- Add import for `needs_runner_check_bridge` in `pacer_config_ops`

### Step 4: Create Core bridge
Create `crates/server/src/native/runner_check_sync.rs` with bridge for check steps

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `runner.check` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-runner-check-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-config-ops -p pacer-server && cargo clippy --locked -p pacer-config-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/config-ops/src/runner_check_ops.rs`
