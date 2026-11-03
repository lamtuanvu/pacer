# ADR 0016: Plugin hosts protocol area for the 0.2 SDK

Status: Proposed, 2026-10-30

The SP08 host-runner schemas (plugin protocol 1.7.0) raise `pacer-plugin-protocol` above CRATE-3's
10,000 generated-line limit. Generate the complete `hostRunner.*` and
`capability.hosts.*` definition areas in the independent publishable
`pacer-plugin-hosts-protocol` 0.2 crate. Every definition in this area has a
local schema reference closure. The generic manifest, lifecycle and call
metadata types remain in `pacer-plugin-protocol`; no layer-0 protocol area
depends on another.

The Rust SDK depends on the new area and keeps the
`pacer_plugin::types::HostRunner*` and `CapabilityHosts*` paths through its
re-export facade, as it does for the decision, agent-session and install areas.
Direct 0.2 protocol consumers import these types from the new crate. Only bundled plugins may serve `hostRunner` or `remoteCaller`; publishing the types does not admit installed providers.
The generated Rust layout changes no JSON wire field or TypeScript validator.
The immutable 0.1 release lane is unaffected.

Publish the hosts protocol crate with the other independent protocol areas,
before the 0.2 SDK. Generation freshness, generated-line limits, dependency
layering, crate archive checks and clean external-consumer compilation cover the
new area. This decision records the pre-1.0 Rust crate layout; it grants no
remote SSH approval and no milestone completion exception.
