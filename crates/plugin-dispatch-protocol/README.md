# pacer-plugin-dispatch-protocol

Generated observation and decision extension types for pacer plugin protocol 1.x. This publishable 0.2 area is independent of the root, agent-session and unpublished policy areas; no layer-0 peer dependency exists.

SDK consumers retain `pacer_plugin::types::Observation*` and `Decision*` paths. Direct 0.2protocol consumers import these types from this crate. Regenerate the complete observation/decision schema closure with `cargo xtask gen`; no wire field, validation or immutable 0.1 source change is implied.
