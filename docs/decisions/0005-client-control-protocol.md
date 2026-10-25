# 0005: Isolate generated client-control parameter types

Date: 2026-10-24
Status: Proposed for maintainer adoption with the agent-control change.

The discoverable API and connected-page control operations pushed the generated
`pacer-client-protocol` crate to 10,822 generated LOC, beyond CRATE-3's 10,000-line
budget. Keep the protocol unchanged and split the `ClientControl*`, `ApiList*` and `ApiDescribe*` definitions
(the agent-control/discovery area) into a layer-0 `pacer-client-control-protocol` generated crate, following the
existing `pacer-session-protocol` pattern. The core generator excludes both areas;
all three consume the same checked-in client schema and `cargo xtask gen` remains
the only source of generated Rust.

The new crate contains only re-exports and generated types, adds no heavy
dependency and grants no authority. Its dependencies are serde, serde_json and
regress, matching the client schema's existing regex representation. No public
operation is removed or renamed. Transport clients can continue forwarding JSON;
Rust consumers can import this area's types when needed.

Verification includes schema split/freshness tests, crate LOC/dependency checks,
workspace tests and build timings recorded under the untracked review evidence.
This keeps generation ownership explicit without increasing a size limit or
hand-editing generated code.
