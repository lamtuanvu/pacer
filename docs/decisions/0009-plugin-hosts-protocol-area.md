# Plugin hosts protocol area for the 0.2 SDK

The SP08 host-runner schemas raise `pacer-plugin-protocol` above CRATE-3's
10,000 generated-line limit. Generate the complete `hostRunner.*` and
`capability.hosts.*` definition areas in the independent publishable
`pacer-plugin-hosts-protocol` 0.2 crate. Every definition in this area has a
local schema reference closure. The generic manifest, lifecycle and call
metadata types remain in `pacer-plugin-protocol`; no layer-0 protocol area
depends on another.

The Rust SDK depends on the new area and keeps its existing
`pacer_plugin::types::HostRunner*` and `CapabilityHosts*` paths through explicit
re-exports. Direct 0.2 protocol consumers import these types from the new crate.
The generated Rust layout changes no JSON wire field or TypeScript validator.
The immutable 0.1 release lane is unaffected.

Publish the root, agent, dispatch and hosts protocol crates before the 0.2 SDK.
Generation freshness, generated-line limits, dependency layering, crate archive
checks and clean external-consumer compilation cover the new area. This decision
records the pre-1.0 Rust crate layout; it grants no remote SSH approval and no
milestone completion exception.
