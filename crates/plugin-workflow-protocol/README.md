# pacer-plugin-workflow-protocol

Generated Rust wire types for the `workflow.definitions` extension method of the [pacer plugin protocol](https://github.com/lamtuanvu/pacer/blob/main/docs/plugin-protocol.md).

This crate is a generated-size split of `pacer-plugin-protocol` (CRATE-3). Plugins use these types through the SDK's `pacer_plugin::types`, which re-exports them with `pacer-plugin-protocol`, rather than depending on this crate directly. It has no dependency on another pacer crate.

The schemas in the pacer repository are authoritative. Regenerate with `cargo xtask gen`; do not edit generated source.
