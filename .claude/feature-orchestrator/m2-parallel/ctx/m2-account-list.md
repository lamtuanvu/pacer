# Context: m2-account-list — Implement account.list and account.signin native in Rust

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-account-list
Branch: m2/account-list (to be created from main)

## Goal
Implement `account.list` and `account.signin` as native Rust operations.

## Current State (from ledger)
- `account.list` is **Forwarded (P7/P9)**
  - "Account inventory with usage/sign-in commands and no emails. Each row needs `readAccountUsage`, endpoint-plugin rows, Orca account reads and sign-in evidence, so it is not a pure store read."
- `account.signin` is **Forwarded (P7/P9)**
  - "Opens provider login in a terminal/tmux/Orca target or returns the command; interactive account-add/init flows share the handler."

## Requirements
1. `account.list` - partial native: return account inventory from strategy, forward for usage/sign-in
2. `account.signin` - partial native: return login command, forward for interactive flows
3. Selective forward for inputs needing usage/endpoint/Orca reads
3. Update ledger: move from Forwarded to Native (selective)

## Files to Modify
- `crates/account-ops/src/account_list_ops.rs` - new module
- `crates/account-ops/src/lib.rs` - export
- `crates/server/src/native.rs` - register native ops
- `crates/server/src/native/account_list_sync.rs` - Core bridge for usage/endpoint/Orca
- `docs/testing/m2-ledger.md` - update ledger
- `test/native-account-list-parity.test.ts` - new parity test

## Key Considerations
- `account.list` needs usage/endpoint/Orca reads; forward those parts
- `account.signin` opens login in terminal; forward interactive parts
- Native version returns core data, forwards rest
- Related to `pacer-account-ops` crate created in #812

## Acceptance Criteria
- `test/native-account-list-parity.test.ts` passes
- `cargo test -p pacer-account-ops -p pacer-server` passes
- `cargo clippy` and `fmt` pass
- Ledger updated correctly
