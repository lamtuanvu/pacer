# Implementation Task: m2-setup-doctor — setup.health and doctor.run native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor

## Task
Implement `setup.health` and `doctor.run` as native Rust operations in `pacer-install` crate.

### Step 1: Create doctor ops module
Create file: `crates/install/src/doctor_ops.rs`
- Add `setup_health` function: run setup.check + bounded doctor checks natively
- Add `doctor_run` function: run diagnostics natively, forward plugin checks
- Both return results matching TypeScript format

### Step 2: Export the module
In `crates/install/src/lib.rs`: add `pub mod doctor_ops;`

### Step 3: Register native ops
In `crates/server/src/native.rs`:
- Add `use pacer_install::doctor_ops;`
- Add `NativeOp { name: "setup.health", call: doctor_ops::setup_health_stub, }`
- Add `NativeOp { name: "doctor.run", call: doctor_ops::doctor_run_stub, }`

### Step 4: Create Core bridge
Create `crates/server/src/native/setup_doctor_sync.rs` with bridge for plugin checks

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `setup.health` and `doctor.run` from Forwarded to Native (selective)

### Step 5: Add parity test
Create `test/native-setup-doctor-parity.test.ts`

### Step 6: Run tests
Run: `cargo test -p pacer-install -p pacer-server && cargo clippy --locked -p pacer-install -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/install/src/doctor_ops.rs`


Complete the implementation task described above in this worktree. It may contain uncommitted changes from an earlier attempt; review them and keep or replace them. Follow AGENTS.md, and never touch the real pacer install (/Applications/pacer.app, ~/.local/bin/pacer*, ~/.pacer, com.pacer.serve). The task succeeds only when the listed tests, clippy and fmt pass; then commit with `git commit -s` using a Conventional Commits message, and do not push. Report the changed files, the commit hash and the test results.
