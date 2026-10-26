# pacer-plugin-protocol

Generated Rust wire types for the [pacer plugin protocol](https://github.com/lamtuanvu/pacer/blob/main/docs/plugin-protocol.md).

Version 0.1 supports plugin protocol 1.x. Its version is independent of the pacer application version. Use `pacer-plugin` for plugin runtime and handler APIs.

The schemas in the pacer repository are authoritative. Regenerate with `cargo xtask gen`; do not edit generated source. Workspace freshness tests require the repository's unpublished generator and are excluded from the published crate.

Policy and read-only observation definitions are generated separately in `crates/plugin-policy-protocol`. Existing lifecycle/call-correlation types remain here; neither layer-0 crate depends on the other.

For 0.2, agent-session/native identity types live in the independent publishable `pacer-plugin-agent-protocol` area. SDK consumers retain `pacer_plugin::types::AgentSession*` paths through its facade; direct 0.2protocol consumers import those types from the new crate. Generic lifecycle and CallMetadata remain in the root protocol crate. No wire fields/validation change and the immutable 0.1 release lane is unaffected. See [area decision](../../docs/decisions/0007-plugin-protocol-area-splits.md).

Observation/decision extension types likewise move to independent publishable `pacer-plugin-dispatch-protocol` 0.2; the SDK type facade preserves their names. No protocol area has a layer-0 peer dependency.

Host-runner and host capability types move to independent publishable `pacer-plugin-hosts-protocol` 0.2. The SDK facade preserves their names; direct 0.2 protocol consumers import them from the new crate. See [ADR 0009](../../docs/decisions/0009-plugin-hosts-protocol-area.md).
