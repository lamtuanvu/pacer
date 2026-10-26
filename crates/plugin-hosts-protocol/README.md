# pacer-plugin-hosts-protocol

Generated Rust wire types for the `hostRunner.*` plugin extension and
`capability.hosts.*` methods in the [pacer plugin protocol](../../docs/plugin-protocol.md).

This is an independent layer-0 protocol area. It has no dependency on another
Pacer crate. Plugin SDK users can keep importing these names from
`pacer_plugin::types`; direct Rust protocol consumers import this crate.
