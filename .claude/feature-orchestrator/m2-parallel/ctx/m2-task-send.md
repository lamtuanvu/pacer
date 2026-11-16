# Context: m2-task-send — Implement task.send native in Rust

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-task-send
Branch: m2/task-send (to be created from main)

## Goal
Implement `task.send` as a native Rust operation.

## Current State (from ledger)
- `task.send` is **Forwarded (P6)**
- "Injects text into an interactive lane's live worker with driving-lease and `expect_rev` rules (`sendMessage` in `src/tasks/send.ts`); does not create attempts."

## Requirements
1. Create native `task.send` op that injects text into live worker
2. Validate driving-lease and `expect_rev` rules
3. Use existing `pacer-sessions` and `pacer-lifecycle` libraries
4. Selective forward for inputs only TypeScript can answer
5. Update ledger: move from Forwarded to Native (selective)

## Files to Modify
- `crates/task-ops/src/task_send_ops.rs` - new module
- `crates/task-ops/src/lib.rs` - export
- `crates/server/src/native.rs` - register native op
- `crates/server/src/native/task_send_sync.rs` - Core bridge for live worker injection
- `docs/testing/m2-ledger.md` - update ledger
- `test/native-task-send-parity.test.ts` - new parity test

## Key Considerations
- `task.send` injects text into live worker, doesn't create attempts
- Needs driving-lease and `expect_rev` validation
- Live worker injection is TypeScript-owned; bridge needed
- Related to `session.agent.create` and session WebSocket

## Acceptance Criteria
- `test/native-task-send-parity.test.ts` passes
- `cargo test -p pacer-task-ops -p pacer-server` passes
- `cargo clippy` and `fmt` pass
- Ledger updated correctly
