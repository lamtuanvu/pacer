# pacer-plugin-exec-protocol

Generated Rust types for the `executor.*`, `capability.process.*`, `capability.worktree.*` and `capability.orca.*` (protocol 1.10.0) areas of the [pacer plugin protocol](../../docs/plugin-protocol.md).

This independent 0.2 area keeps `pacer-plugin-protocol` within the generated crate size limit. The TypeScript SDK and JSON wire contract are unchanged. `pacer_plugin::types` preserves the existing type names through explicit re-exports. Direct Rust imports of `Executor*`, `CapabilityProcess*` and `CapabilityOrca*` types use `pacer_plugin_exec_protocol` rather than `pacer_plugin_protocol`; the independent layer-0 crates have no peer dependencies.

Regenerate from the repository schema with `cargo xtask gen`. This crate has no hand-written runtime logic.
