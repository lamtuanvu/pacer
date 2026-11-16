# Implementation Task: m2-task-send — task.send native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send

## Task
Implement `task.send` as a native Rust operation.

### Step 1: Create the task send ops module
Create file: `crates/task-ops/src/task_send_ops.rs`
- Add module with `task_send` function
- Validate params: task id, text to send, optional `expect_rev`
- Check driving lease
- Forward to Core bridge for live worker injection
- Return result matching TypeScript format

### Step 2: Export the module
In `crates/task-ops/src/lib.rs`: add `pub mod task_send_ops;`

### Step 3: Register native op
In `crates/server/src/native.rs`:
- Add `use pacer_task_ops::task_send_ops;`
- Add `NativeOp { name: "task.send", call: task_send_ops::task_send_stub, }`

### Step 4: Create Core bridge
Create `crates/server/src/native/task_send_sync.rs` with bridge for live worker injection

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `task.send` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-task-send-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-task-ops -p pacer-server && cargo clippy --locked -p pacer-task-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/task-ops/src/task_send_ops.rs`
