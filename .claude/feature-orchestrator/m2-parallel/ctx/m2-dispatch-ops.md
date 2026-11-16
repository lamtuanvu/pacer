# Context: m2-dispatch-ops — Implement dispatch.* lifecycle ops native in Rust

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops
Branch: m2/dispatch-ops (to be created from main)

## Goal
Implement `dispatch.submit`, `dispatch.child`, `dispatch.wait`, `dispatch.review`, `dispatch.retry`, `dispatch.answer`, `dispatch.stop` as native Rust operations.

## Current State (from ledger)
All are **Forwarded (P6)**:
- `dispatch.submit`, `dispatch.child` - "Root and scoped child admission: work grants, queue mutation, delegation policy, prepared admission and `launchTaskRunner` spawn"
- `dispatch.wait` - "Polls until a work item settles via `waitWork`; needs queue drain, runner supervision"
- `dispatch.review`, `dispatch.retry`, `dispatch.answer`, `dispatch.stop` - "Managed-work lifecycle at `expect_rev`: review acceptance, lineage retry, executor Q&A resume and subtree stop"

## Requirements
1. Implement all dispatch lifecycle ops as native Rust
2. Use `pacer-lifecycle::work_reads` and `pacer-dispatch-ops` libraries
3. Selective forward for inputs needing live worker/supervision
4. Update ledger: move from Forwarded to Native (selective)

## Files to Modify
- `crates/dispatch-ops/src/lifecycle_ops.rs` - new module
- `crates/dispatch-ops/src/lib.rs` - export
- `crates/server/src/native.rs` - register native ops
- `crates/server/src/native/dispatch_lifecycle_sync.rs` - Core bridge for worker/supervision
- `docs/testing/m2-ledger.md` - update ledger
- `test/native-dispatch-lifecycle-parity.test.ts` - new parity test

## Key Considerations
- Need queue drain, runner supervision, live worker bridging
- `dispatch.wait` needs same orchestration as `task.wait`
- `dispatch.stop` needs subtree stop logic
- Related to `pacer-lifecycle` and `pacer-dispatch-ops` crates

## Acceptance Criteria
- `test/native-dispatch-lifecycle-parity.test.ts` passes
- `cargo test -p pacer-dispatch-ops -p pacer-server` passes
- `cargo clippy` and `fmt` pass
- Ledger updated correctly
