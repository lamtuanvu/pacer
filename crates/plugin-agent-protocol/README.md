# pacer-plugin-agent-protocol

Generated agent-session and native identity wire types for pacer plugin protocol 1.x. This publishable 0.2 area has no layer-0 peer dependencies.

SDK consumers retain `pacer_plugin::types::AgentSession*` paths; direct 0.2protocol consumers import agent types from this crate. Generic lifecycle/CallMetadata remain in the root, observation/decision use the dispatch area, and policy remains unpublished. Regenerate the complete `agentSession.*` schema closure with `cargo xtask gen`; no wire field, validation or immutable 0.1 source change is implied.
