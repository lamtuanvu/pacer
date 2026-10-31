# pacer-plugin-exec-protocol

Generated Rust wire types for the `executor.*` extension methods and `capability.process.*` capability methods of the [pacer plugin protocol](https://github.com/lamtuanvu/pacer/blob/main/docs/plugin-protocol.md).

This crate is a generated-size split of `pacer-plugin-protocol` (CRATE-3). Plugins use these types through the SDK's `pacer_plugin::types`, which re-exports them with `pacer-plugin-protocol`. Direct Rust imports of `Executor*` and `CapabilityProcess*` types use `pacer_plugin_exec_protocol` rather than `pacer_plugin_protocol`; the layer-0 protocol crates have no peer dependencies.

The schemas in the pacer repository are authoritative. Regenerate with `cargo xtask gen`; do not edit generated source.
