# pacer-plugin-protocol

Generated Rust wire types for the [pacer plugin protocol](https://github.com/lamtuanvu/pacer/blob/main/docs/plugin-protocol.md).

Version 0.2 supports plugin protocol 1.x. Its version is independent of the pacer application version. Use `pacer-plugin` for plugin runtime and handler APIs.

The schemas in the pacer repository are authoritative. Regenerate with `cargo xtask gen`; do not edit generated source. Workspace freshness tests require the repository's unpublished generator and are excluded from the published crate.

Policy and read-only observation definitions are generated separately in `crates/plugin-policy-protocol`. Existing lifecycle/call-correlation types remain here; neither layer-0 crate depends on the other.

Host-runner and host capability types move to the independent publishable `pacer-plugin-hosts-protocol` 0.2. The SDK facade preserves their names; direct protocol consumers import them from the new crate. See [ADR 0016](../../docs/decisions/0016-plugin-hosts-protocol-area.md).

Executor and process capability types move to the independent publishable `pacer-plugin-exec-protocol` 0.2. The SDK facade preserves `Executor*` and `CapabilityProcess*` names; direct root-protocol imports change to `pacer_plugin_exec_protocol`. See [ADR 0017](../../docs/decisions/0017-plugin-exec-protocol-area.md).
