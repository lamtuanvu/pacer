# Rust crate structure and size rules

Applies to: the Cargo workspace (`Cargo.toml`, `crates/**`, `plugins-rs/**`, `xtask/**`). Covers any change that adds a crate, adds a dependency to a crate, moves code between crates or grows a crate.
Out of scope: `desktop/src-tauri` while it stays outside the workspace. Test code (`tests/` directories, `tests.rs` files) is excluded from the size budgets but not from the dependency rules.
Owner: @lamtuanvu
Canonical sources: [Rust host migration spec](../../docs/specs/2026-10-20-rust-host-migration-design.md) §1.1 and §2.3, `cargo xtask loc`, `cargo xtask deps`, `xtask/crates.toml`

Why these rules exist: rustc compiles each crate as one unit. Type and borrow checking of a crate run mostly on one thread, and editing any file rebuilds the whole crate and every crate that depends on it. One large crate that everyone edits turns every change into a long rebuild. Small crates arranged in layers rebuild only what changed, and independent crates build in parallel.

## Terms

- **LOC**: hand-written lines in `src/**/*.rs` that are neither blank nor comment-only. Excludes `src/**/tests/**`, files named `tests.rs`, and generated files (header `// @generated`). Measured by `cargo xtask loc`.
- **Layer**: the position of a crate in `xtask/crates.toml`. A crate may depend only on crates in lower layers.
- **Heavy dependency**: an external crate that dominates build time or pulls a large tree. The list lives in `xtask/crates.toml` (`[heavy]`) and starts with: `wasmtime`, `axum`, `hyper`, `rmcp`, `reqwest`, `ratatui`, `crossterm`, `clap`, `portable-pty`, `vt100`, `typify`, `syn`.

## Rules

| ID | Rule or convention | Status | Rationale/source | Verification |
|----|--------------------|--------|------------------|--------------|
| CRATE-1 | Size budget per crate (LOC): target **≤ 5,000**; above **8,000** the PR states why and names the split, or schedules it in the current milestone's plans; above **12,000** the crate is split before the PR merges, unless an exception is recorded in decisions.md with an expiry. | Established | Incremental rebuild time grows with crate size | `cargo xtask loc --check` in CI (fails above 12,000; warns above 8,000) |
| CRATE-2 | Foundation crates stay small and stable: `pacer-foundation` ≤ 2,000 LOC and depends only on `pacer-client-protocol`, `serde`, `serde_json`, `thiserror` (plus `tokio` behind a non-default feature). A PR that changes its public API says so in the description, because it rebuilds the workspace. | Established | Bottom of the graph: every change rebuilds everything | `cargo xtask deps`; review |
| CRATE-3 | Generated code lives only in generated crates (`pacer-client-protocol`, `pacer-plugin-protocol`), one per protocol. They contain no hand-written logic beyond `lib.rs` re-exports and version constants. Each generated crate stays ≤ 10,000 generated lines; past that, split by protocol area. | Established | Derive-heavy code is slow to compile; isolating it means it rebuilds only on schema change | `cargo xtask gen --check`; `cargo xtask loc` reports generated lines separately |
| CRATE-4 | Dependencies point down the layers in `xtask/crates.toml` only. No cycles. Nothing depends on `pacer` (the binary), `pacer-cli`, `pacer-server` or `pacer-tui`. Domain crates never depend on transport, CLI or TUI crates. Plugin crates (`plugins-rs/*`) depend on `pacer-plugin` and small external crates only, never on host crates. | Established | Layering keeps rebuilds local and boundaries reviewable (ARCH-12, RUST-6) | `cargo xtask deps` in CI |
| CRATE-5 | Each heavy dependency is allowed only in the crates listed for it in `xtask/crates.toml`. Adding a heavy dependency to another crate, or adding a crate to `[heavy]`, needs the build-timings evidence in CRATE-9. | Established | One heavy dependency in a low crate slows every build above it | `cargo xtask deps` |
| CRATE-6 | Optional heavy subsystems sit behind cargo features that are off for `cargo build` and `cargo test` at the workspace root and on in release builds. The first is `wasm` (pulls `pacer-wasm-host` and wasmtime). | Established | The inner loop should not compile what it does not test | `cargo xtask deps` checks default features; release script enables them |
| CRATE-7 | The binary crate `pacer` is ≤ 500 LOC: argument dispatch and start-up only. | Established | The binary rebuilds on every change below it; keep it trivial to link | `cargo xtask loc --check` |
| CRATE-8 | One domain per crate, named `pacer-<domain>` in a folder `crates/<domain>/`. No grab-bag crates (`utils`, `common`, `misc`, `shared`). Shared helpers go into the lowest crate whose domain they belong to, or into `pacer-foundation` when every domain needs them and CRATE-2 still holds. Splits follow domain seams, not file count. | Established | Grab-bag crates become the bottom of the graph and the biggest rebuild | Review |
| CRATE-9 | CI records `cargo build --timings` for a clean dev build and an incremental rebuild after touching one leaf domain crate (`pacer-lifecycle` from M2; `pacer-server` before that), and uploads the HTML report. A PR that adds a crate or a heavy dependency, or changes workspace profiles, attaches the before and after numbers. | Established | Build cost is measured, not guessed | CI artifact; review |
| CRATE-10 | Dev profile settings are fixed in the workspace `Cargo.toml` (`debug = "line-tables-only"`, `split-debuginfo = "unpacked"` on macOS, `incremental = true`) and change only with CRATE-9 evidence. | Established | Debug info and linking dominate dev build time | Review |
| CRATE-11 | Inline `#[cfg(test)] mod tests` blocks are kept short (≤ 150 lines); larger unit suites move to a `tests.rs` file beside the module or to the crate's `tests/` directory. | Established | Keeps LOC honest and source files readable | Review |

## Planned crates and budgets

Layers from bottom (0) to top. Budgets are the planned size at the end of M3; CRATE-1 applies to all of them.

| Layer | Crate (folder) | Domain | Planned LOC | Heavy deps allowed |
|---|---|---|---|---|
| 0 | `pacer-client-protocol` (`crates/client-protocol`) | Generated client-protocol types | 4,000–7,000 generated | none at runtime (`typify` and `syn` only in `xtask`) |
| 0 | `pacer-dispatch-protocol` (`crates/dispatch-protocol`) | Generated dispatch operation types from the client schema; CRATE-3 area split | ≤ 10,000 generated | none at runtime |
| 0 | `pacer-limits-protocol` (`crates/limits-protocol`) | Generated limits operation types from the client schema; CRATE-3 area split | ≤ 10,000 generated | none at runtime |
| 0 | `pacer-plugin-ops-protocol` (`crates/plugin-ops-protocol`) | Generated plugin operation types (`plugin.*` client ops) from the client schema; CRATE-3 area split | ≤ 10,000 generated | none at runtime |
| 0 | `pacer-session-protocol` (`crates/session-protocol`) | Generated interactive-session operation types from the client schema; CRATE-3 area split | ≤ 10,000 generated | none at runtime |
| 0 | `pacer-terminal-protocol` (`crates/terminal-protocol`) | Generated terminal and host-terminal operation types from the client schema; CRATE-3 area split | ≤ 10,000 generated | none at runtime |
| 0 | `pacer-task-protocol` (`crates/task-protocol`) | Generated task operation types (`task.*` client ops) from the client schema; CRATE-3 area split | ≤ 10,000 generated | none at runtime |
| 0 | `pacer-plugin-decision-protocol` (`crates/plugin-decision-protocol`) | Generated plugin `decision.*` method types from the plugin schema; CRATE-3 area split; re-exported through `pacer_plugin::types` | ≤ 10,000 generated | none |
| 0 | `pacer-plugin-agent-session-protocol` (`crates/plugin-agent-session-protocol`) | Generated plugin `agentSession.*` method types from the plugin schema; CRATE-3 area split; re-exported through `pacer_plugin::types` | ≤ 10,000 generated | none |
| 0 | `pacer-assistant-protocol` (`crates/assistant-protocol`) | Generated assistant operation types from the client schema; CRATE-3 area split | ≤ 10,000 generated | none at runtime |
| 0 | `pacer-plugin-protocol` (`crates/plugin-protocol`) | Generated plugin-protocol types (manifest, handshake, observation, UI, diagnostic, capability); entry crate of the plugin protocol, whose definitions win name clashes in `pacer_plugin::types` | ≤ 10,000 generated | none |
| 1 | `pacer-foundation` (`crates/foundation`) | Ctx, file rules, lock, `CoreError`, op registry types | 1,000–1,500 | none |
| 2 | `pacer-store` (`crates/store`) | Task store, activity log, outbox and events | 2,000–2,500 | none |
| 3 | `pacer-config` (`crates/config`) | Strategy, YAML editor, config areas (publishes config changes through `pacer-store`) | 3,000–3,800 | none |
| 3 | `pacer-sessions` (`crates/sessions`) | PTY sessions, screen, recording, terminal opening | 2,000–2,500 | `portable-pty`, `vt100` |
| 4 | `pacer-plugin-host` (`crates/plugin-host`) | Plugin registry, processes, capabilities, archives | 3,000–4,000 | `reqwest` |
| 5 | `pacer-engine` (`crates/engine`) | Pacing, usage broker, status | 1,500–2,000 | none |
| 5 | `pacer-install` (`crates/install`) | Setup, onboarding, agent integrations, accounts, Orca panel installer, executor guard | 3,500–4,500 | none |
| 5 | `pacer-wasm-host` (`crates/wasm-host`) | Wasm component transport (feature `wasm`) | 800–1,200 | `wasmtime` |
| 6 | `pacer-lifecycle` (`crates/lifecycle`) | Delegation, runner, supervision, attention, jobs, clients, pump | 3,500–4,500 | none |
| 6 | `pacer-update` (`crates/update`) | Update, release manifest, service install | 1,500 | `reqwest` |
| 7 | `pacer-read-model` (`crates/read-model`) | Snapshot and view model | 1,300–1,600 | none |
| 8 | `pacer-server` (`crates/server`) | Op registry assembly, HTTP, SSE, WebSocket, stdio, MCP, bridge, embedded app assets | 2,000–2,500 | `axum`, `hyper`, `rmcp` |
| 8 | `pacer-tui` (`crates/tui`) | Dashboard (an API client: ARCH-1) | 1,000–1,200 | `ratatui`, `crossterm` |
| 8 | `pacer-bundled` (`crates/bundled`) | Table of bundled plugins (manifest text and entry function), from M3 plan 1 | ≤ 300 | none (depends on `plugins-rs/*`) |
| 9 | `pacer-cli` (`crates/cli`) | Commands, renderers, status line, core exec and self-repair (M1–M2) | 3,000–3,500 | `clap` |
| 10 | `pacer` (`crates/pacer`) | Binary | ≤ 500 | none |
| SDK | `pacer-plugin` (`crates/plugin-sdk`) | Rust plugin SDK; features `testing`, `install`, `exec`, `wasm`; depends on the plugin protocol crates (`pacer-plugin-protocol`, `pacer-plugin-decision-protocol`, `pacer-plugin-agent-session-protocol`) only; `pacer_plugin::types` re-exports all three | 1,200 core, 3,500–4,000 with features | `wit-bindgen` (feature `wasm`) |
| SDK | `pacer-fixtures` (`crates/fixtures`) | Conformance fixture plugins | 300–400 | none |
| Plugins | `plugins-rs/<id>` | One bundled plugin each | 100–2,500 each | per plugin, listed in `xtask/crates.toml` |
| Tool | `xtask` | Generation, `loc`, `deps`, goldens | 600–900 | `typify`, `syn` |

`pacer-tui` is a client of the API (ARCH-1, ARCH-8) and depends on `pacer-client-protocol`, not on domain crates. Each domain crate exports its native operations (`pub fn ops() -> &'static [NativeOp]`); `pacer-server` assembles the registry. The plugin host never depends on plugin crates: the binary passes the `pacer-bundled` table to it at start-up, so editing a bundled plugin rebuilds only that plugin, `pacer-bundled`, `pacer-cli` and the binary.

## Implementer checklist

- Run `cargo xtask loc` before opening a PR that adds code; if a crate crosses 8,000, write the split plan or justification in the PR.
- Put new code in the lowest crate whose domain owns it. If none fits, propose a new `pacer-<domain>` crate in the plan, with its layer and budget, and add it to `xtask/crates.toml` in the same PR.
- Never add a heavy dependency outside its allowed crates; never add a dependency that points up a layer.
- Keep `pacer-foundation` and the binary small; move logic up, not down.

## Reviewer checklist

- `cargo xtask loc --check` and `cargo xtask deps` passed in CI; read the warnings.
- New crate: name, folder, layer and budget recorded in `xtask/crates.toml` and in the table above; domain is single and clear (CRATE-8).
- New or moved heavy dependency: CRATE-9 timings attached.
- Foundation API change: called out in the description (CRATE-2).

Relevant reviewers: [architecture](../reviewers/architecture.md), [release](../reviewers/release.md) (profiles and release features)
Exceptions and open decisions: none.
