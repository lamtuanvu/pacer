# Implementation Task: m2-account-list — account.list and account.signin native

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-account-list

## Task
Implement `account.list` and `account.signin` as native Rust operations in `pacer-account-ops`.

### Step 1: Create account list ops module
Create file: `crates/account-ops/src/account_list_ops.rs`
- Add `account_list` function: return accounts from strategy with basic info
- Add `account_signin` function: return login command for account
- Forward for usage/endpoint/Orca reads
- Return results matching TypeScript format

### Step 2: Export the module
In `crates/account-ops/src/lib.rs`: add `pub mod account_list_ops;`

### Step 3: Register native ops
In `crates/server/src/native.rs`:
- Add `use pacer_account_ops::account_list_ops;`
- Add `NativeOp { name: "account.list", call: account_list_ops::account_list_stub, }`
- Add `NativeOp { name: "account.signin", call: account_list_ops::account_signin_stub, }`

### Step 4: Create Core bridge
Create `crates/server/src/native/account_list_sync.rs` with bridge for usage/endpoint/Orca reads

### Step 5: Update ledger
In `docs/testing/m2-ledger.md`: change `account.list` and `account.signin` from Forwarded to Native (selective)

### Step 6: Add parity test
Create `test/native-account-list-parity.test.ts`

### Step 7: Run tests
Run: `cargo test -p pacer-account-ops -p pacer-server && cargo clippy --locked -p pacer-account-ops -p pacer-server --all-targets -- -D warnings && cargo fmt --all --check`

## Start with Step 1: Create `crates/account-ops/src/account_list_ops.rs`
