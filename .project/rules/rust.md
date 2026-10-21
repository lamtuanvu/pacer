# Rust language and behavior rules

Applies to: the Cargo workspace (`Cargo.toml`, `crates/**`, `plugins-rs/**`, `xtask/**`) and any change that adds or edits Rust source. Complements [rust-crates.md](rust-crates.md) (CRATE-1 to CRATE-11), which covers crate structure, sizes and dependency direction.
Out of scope: `desktop/src-tauri` while it stays outside the workspace.
Owner: @lamtuanvu
Canonical sources: [Rust host migration spec](../../docs/specs/2026-10-20-rust-host-migration-design.md) §2.2, [security rule](security.md) (SEC-5, SEC-7), `cargo xtask`, `cargo fmt`, `cargo clippy`

Why these rules exist: the Cargo workspace is the host-side port of the TypeScript codebase, checked into the same repository and built and tested in CI. The workspace must stay memory-safe without relying on `unsafe`, stay small and layering-safe, survive restarts and secret handling the same way the TypeScript core does, and keep generated code and behavior identical with the spec so the strangler migration stays honest.

## Rules

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| RUST-1 | `unsafe_code` is forbidden across the workspace. Any exception needs an ADR before it is merged. | Established | Memory safety without the unsafe surface | `[workspace.lints.rust] unsafe_code = "forbid"`; `cargo clippy` in CI |
| RUST-2 | No `unwrap()`/`expect()` outside tests (`#[cfg(test)]`, `tests/`, `tests.rs`). Errors use `thiserror` in libraries and map to `CoreError` codes at operation boundaries. | Established | No panics in release paths; typed, operation-mapped errors | `[workspace.lints.clippy] unwrap_used = "deny"`, `expect_used = "deny"`; `cargo test` in CI |
| RUST-3 | Processes are spawned with `std::process::Command` / `tokio::process::Command` and an argument vector, never through a shell | Established | SEC-5 (avoid shell injection); match the TS spawn model | `cargo test`; review |
| RUST-4 | Files holding secrets are created with mode 0600 via `OpenOptions::mode`, directories 0700 | Established | SEC-7 (mode 0600/0700 parity with the TS core) | `cargo test`; review |
| RUST-5 | Generated code is produced only by `cargo xtask gen` and never edited by hand | Established | Keep protocol types regen-able and fresh | `cargo xtask gen --check` in CI |
| RUST-6 | Crate structure, sizes and dependency direction follow `.project/rules/rust-crates.md` (CRATE-1 to CRATE-11) | Established | Keeps rebuilds local and boundaries reviewable | `cargo xtask loc --check` and `cargo xtask deps` in CI |
| RUST-7 | Behavior parity: a port reproduces the TypeScript behavior; behavior changes land in TypeScript first | Established | Spec §2.2, strangler rule | Review; conformance suite |

## Implementer checklist

- Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` and `cargo test --workspace --locked` before opening a PR.
- Prefer `thiserror` `Error` types and map them to `CoreError` codes at op boundaries; use `unwrap`/`expect` only inside test modules.
- Spawn subprocesses with an argument vector, never through a shell (RUST-3); give secret files mode 0600 and secret directories 0700 (RUST-4).
- Never edit code produced by `cargo xtask gen` (RUST-5); re-run `cargo xtask gen --check` if you change the schema.
- When porting, reproduce the TypeScript behavior exactly; propose behavior changes in TypeScript first (RUST-7).

## Reviewer checklist

- `cargo fmt --check`, `cargo clippy` (`-D warnings`), `cargo test --workspace --locked`, `cargo xtask gen --check`, `cargo xtask loc --check` and `cargo xtask deps` passed in CI.
- No `unsafe` blocks outside an ADR; no `unwrap`/`expect` outside tests (RUST-1, RUST-2).
- Subprocesses use argument vectors, not a shell (RUST-3); secret files are mode 0600, directories 0700 (RUST-4).
- Generated files only come from `cargo xtask gen` (RUST-5); crate structure follows rust-crates.md (RUST-6); behavior matches TypeScript (RUST-7).

Relevant reviewers: [architecture](../reviewers/architecture.md), [security](../reviewers/security.md)
Exceptions and open decisions: none.