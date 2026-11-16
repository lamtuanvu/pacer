# Implementation Task: m2-service-handover — service.install and update.apply native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover

## Task
Implement `service.install` and `update.apply` as native Rust operations.

### Step 1: Create service install ops module
Create file: `crates/install/src/install_ops.rs`
- Add `service_install` function: validate params, write install manifest, call Core bridge for launchctl/systemctl
- Add `service_uninstall` function (if needed)

### Step 2: Create update apply ops module
Create file: `crates/update/src/apply.rs`
- Add `update_apply` function: validate params, run update job, call Core bridge for download/verify/replace/restart

### Step 3: Export modules
In `crates/install/src/lib.rs`: add `pub mod install_ops;`
In `crates/update/src/lib.rs`: add `pub mod apply;`

### Step 4: Register native ops
In `crates/server/src/native.rs`:
- Add `use pacer_install::install_ops;`
- Add `use pacer_update::apply;`
- Add `NativeOp { name: "service.install", call: install_ops::service_install_stub, }`
- Add `NativeOp { name: "update.apply", call: apply::update_apply_stub, }`

### Step 4: Create Core bridge
Create `crates/server/src/native/install_apply_sync.rs` with bridge for launchctl/systemctl and update job

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `service.install` and `update.apply` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-install-apply-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-install -p pacer-update -p pacer-server && cargo clippy --locked -p pacer-install -p pacer-update -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/install/src/install_ops.rs` and `crates/update/src/apply.rs`


Complete the implementation task described above in this worktree. It may contain uncommitted changes from an earlier attempt; review them and keep or replace them. Follow AGENTS.md, and never touch the real pacer install (/Applications/pacer.app, ~/.local/bin/pacer*, ~/.pacer, com.pacer.serve). The task succeeds only when the listed tests, clippy and fmt pass; then commit with `git commit -s` using a Conventional Commits message, and do not push. Report the changed files, the commit hash and the test results.
