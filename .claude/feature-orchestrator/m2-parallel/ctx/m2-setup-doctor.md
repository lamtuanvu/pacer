# Context: m2-setup-doctor — Implement setup.health and doctor.run native in Rust

## Worktree
Path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-setup-doctor
Branch: m2/setup-doctor

## Goal
Implement `setup.health` and `doctor.run` as native Rust operations.

## Current State (from ledger)
- `setup.health` is **Forwarded (P9)**
  - "Startup Checking-setup gate: bounded doctor and setup checks as fixed steps, a persisted last-pass fingerprint and the snapshot probe; v3-only. M2 re-evaluation: every run includes the full `doctor` step and the `setup.check` step, so it stays forwarded until both are native."
- `doctor.run` is **Forwarded (P9)**
  - "Setup/service/account/handler diagnostics and isolated Claude probes remain in TypeScript (`runDoctor`); not registered natively. M2 re-evaluation: the report needs the planner plugin's `planner.check`/`planner.plan` through the in-process plugin registry, in-process probes of the TypeScript build's Claude hook handlers (`probeClaudeHandlers`) and `computeStatus` over live plugin usage readers, so no input has a pure native path."

## Requirements
1. `setup.health` - partial native: run setup.check and bounded doctor checks natively, forward full doctor
2. `doctor.run` - partial native: run checkable diagnostics natively, forward plugin-dependent checks
3. Update ledger: move from Forwarded to Native (selective)

## Files to Modify
- `crates/install/src/doctor_ops.rs` - new module (in pacer-install crate)
- `crates/install/src/lib.rs` - export
- `crates/server/src/native.rs` - register native ops
- `crates/server/src/native/setup_doctor_sync.rs` - Core bridge for plugin checks
- `docs/testing/m2-ledger.md` - update ledger
- `test/native-setup-doctor-parity.test.ts` - new parity test

## Key Considerations
- `setup.health` includes `doctor` step and `setup.check` step
- `doctor.run` needs plugin registry, `computeStatus`, Claude hook probes
- Both forward for plugin-dependent checks
- Use `pacer-install` crate from #826

## Acceptance Criteria
- `test/native-setup-doctor-parity.test.ts` passes
- `cargo test -p pacer-install -p pacer-server` passes
- `cargo clippy` and `fmt` pass
- Ledger updated correctly
