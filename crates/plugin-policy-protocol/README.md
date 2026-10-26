# pacer-plugin-policy-protocol

Generated policy and read-only task/event observation contracts for plugin protocol 1.5.
This layer-0 CRATE-3 area split keeps the existing plugin protocol crate within its
10,000 generated-line budget without moving its lifecycle/call-correlation types.
Generate from the canonical plugin schema with `cargo xtask gen`; never edit generated source.

This crate is standalone and unpublished. Host brokers, policy gates, subscription
ownership and Rust SDK adoption are later implementation batches; these types do
not authorize capabilities or implement those behaviors. Canonical host schemas
remain authoritative for request validation.
