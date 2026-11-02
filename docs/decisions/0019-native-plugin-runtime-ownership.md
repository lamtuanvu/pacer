# Native plugin runtime ownership

Date: 2026-11-02. Status: proposed implementation boundary for P4b shadow libraries.

The Rust plugin host needs concrete capability effects without growing registry
and RPC admission into one crate beyond CRATE-1. TypeScript remains authoritative
under RUST-7; this change registers no native client operation.

Keep registry, subprocess plugin RPC and capability admission in
`pacer-plugin-host` (layer 4). Keep filesystem/executable pins, SSH and Git effects,
Orca attempt policy and desktop work leases in `pacer-plugin-runtime` (layer 3).
Keep bounded byte payloads in `pacer-plugin-wire` (layer 1), and JavaScript
JSON value semantics in `pacer-js-json` (layer 0), below the task store and plugin
runtime. Keep Bun glob scan/scope matching in `pacer-bun-glob` (layer 1),
independent of descriptor ownership. Re-export the existing host-facing type paths.
Dependencies point downward; no plugin imports these host libraries.

JavaScript slice counts UTF-16 units and may split a surrogate pair. Rust scalar
strings cannot carry that result. `WireReply` retains those units until JSON
serialization; the scalar convenience API refuses a non-scalar conversion.
Future Orca RPC wiring must use the lossless broker path, rather than silently
serialize replacement characters. No client protocol or operation is changed.

The runtime remains above the 8,000-line warning, below the 12,000-line hard
limit. Its next split follows task-attempt orchestration versus pinned
filesystem/process effects before further growth reaches the hard limit. Clean
and incremental workspace timing evidence is kept with the P4b review report.

Task storage retains non-scalar JSON strings during import and ordinary metadata
updates. `read_wire` delivers the exact JSON; `read` is a scalar metadata preview.
Native Orca question clipping publishes a UTF-16 text overlay through the existing
shared task lock, SQLite transaction, revision CAS and atomic JSON write-through.
The overlay API permits only question text, so it cannot rewrite task identity,
state or revision. Explicit text replacement uses the lossless API even when the
intended replacement is U+FFFD. No second store or alternate state format exists.
