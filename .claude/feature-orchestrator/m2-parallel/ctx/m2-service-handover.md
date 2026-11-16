# Context: m2-service-handover — Implement service.install and update.apply native in Rust

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-service-handover
Branch: m2/service-handover (to be created from main)

## Goal
Implement `service.install` and `update.apply` as native Rust operations.

## Current State (from ledger)
- `service.install` is **Forwarded (P9)**
  - "Login-item/service install with explicit consent: the install transaction and manifest, the `pacerArgv` of the running core, `launchctl bootstrap`/`systemctl enable` and the health wait stay in TypeScript (`src/service/index.ts`, `src/install/`)."
- `update.apply` is **Forwarded (P9)**
  - "Release feed check (optional force) and shared `update.apply` job with download/verify/replace/refuse package-manager and source installs (`src/api/ops.ts`, update preflight)."

## Requirements
1. `service.install` - partial native: validate params, write install manifest, forward launchctl/systemctl execution
2. `update.apply` - partial native: validate params, run update job, forward download/verify/replace
3. Update ledger: move from Forwarded to Native (selective)

## Files to Modify
- `crates/install/src/install_ops.rs` - new module (in pacer-install crate)
- `crates/install/src/lib.rs` - export
- `crates/update/src/apply.rs` - new module (in pacer-update crate)
- `crates/update/src/lib.rs` - export
- `crates/server/src/native.rs` - register native ops
- `crates/server/src/native/install_apply_sync.rs` - Core bridge for execution
- `docs/testing/m2-ledger.md` - update ledger
- `test/native-install-apply-parity.test.ts` - new parity test

## Key Considerations
- `service.install` needs launchctl (macOS) or systemctl (Linux) execution
- `update.apply` runs shared update job with download/verify/replace
- Both forward for execution that needs root/sudo
- Use `pacer-install` and `pacer-update` crates

## Acceptance Criteria
- `test/native-install-apply-parity.test.ts` passes
- `cargo test -p pacer-install -p pacer-update -p pacer-server` passes
- `cargo clippy` and `fmt` pass
- Ledger updated correctly
