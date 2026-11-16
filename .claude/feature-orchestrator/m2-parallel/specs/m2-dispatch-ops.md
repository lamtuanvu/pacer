# Implementation Task: m2-dispatch-ops — dispatch lifecycle ops native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-dispatch-ops

## Task
Implement `dispatch.submit`, `dispatch.child`, `dispatch.wait`, `dispatch.review`, `dispatch.retry`, `dispatch.answer`, `dispatch.stop` as native Rust operations.

### Step 1: Create dispatch lifecycle ops module
Create file: `crates/dispatch-ops/src/lifecycle_ops.rs`
- Add `dispatch_submit` function: validate params, check work grants, queue mutation, call Core bridge for worker spawn
- Add `dispatch_child` function: scoped child admission
- Add `dispatch_wait` function: poll until work item settles
- Add `dispatch_review` function: review acceptance/rejection
- Add `dispatch_retry` function: retry with same revision
- Add `dispatch_answer` function: handle executor Q&A
- Add `dispatch_stop` function: stop work item and subtree
- All functions forward for worker/supervision bridging

### Step 2: Export the module
In `crates/dispatch-ops/src/lib.rs`: add `pub mod lifecycle_ops;`

### Step 3: Register native ops
In `crates/server/src/native.rs`:
- Add `use pacer_dispatch_ops::lifecycle_ops;`
- Add `NativeOp` entries for all 7 operations with `_stub` calls

### Step 4: Create Core bridge
Create `crates/server/src/native/dispatch_lifecycle_sync.rs` with bridge for worker/supervision

### Step 4: Update ledger
In `docs/testing/m2-ledger.md`: change all 7 dispatch ops from Forwarded to Native (selective)

### Step 5: Add parity test
Create `test/native-dispatch-lifecycle-parity.test.ts`

### Step 6: Run tests
Run: `cargo test -p pacer-dispatch-ops -p pacer-server && cargo clippy --locked -p pacer-dispatch-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/dispatch-ops/src/lifecycle_ops.rs`


Complete the implementation task described above in this worktree. It may contain uncommitted changes from an earlier attempt; review them and keep or replace them. Follow AGENTS.md, and never touch the real pacer install (/Applications/pacer.app, ~/.local/bin/pacer*, ~/.pacer, com.pacer.serve). The task succeeds only when the listed tests, clippy and fmt pass; then commit with `git commit -s` using a Conventional Commits message, and do not push. Report the changed files, the commit hash and the test results.
