# pacer-plugin-protocol

Generated Rust wire types for the [pacer plugin protocol](https://github.com/lamtuanvu/pacer/blob/main/docs/plugin-protocol.md).

Version 0.1 supports plugin protocol 1.x. Its version is independent of the pacer application version. Use `pacer-plugin` for plugin runtime and handler APIs.

The schemas in the pacer repository are authoritative. Regenerate with `cargo xtask gen`; do not edit generated source. Workspace freshness tests require the repository's unpublished generator and are excluded from the published crate.
