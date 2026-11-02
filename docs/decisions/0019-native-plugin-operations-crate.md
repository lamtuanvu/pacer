# ADR 0019 — Native plugin operations crate

Status: proposed with PR #618.

The native plugin HTTP slice adds UI validation, settings persistence, archive
inspection and publisher trust to a process host that has also grown on main.
Keeping both in `pacer-plugin-host` would exceed CRATE-1's 12,000-line limit.

`pacer-plugin-ops` owns the new public operations, source-span strategy edits,
settings, UI documents, JSON compatibility codec and distribution content. It is
an unpublished layer-5 domain crate with a target budget of 5,000 hand-written
lines. It depends on the layer-4 plugin host for manifest parsing and on config
and foundation below it. The server depends on the operations crate. The host
continues to own process lifecycle, capabilities, manifest types and grants; it
never depends on the operations crate. No transport, wire schema or process
ownership changes are introduced by this split.

The remaining host is above the 8,000-line warning threshold, below the hard
limit. Its native capability brokers are the next split seam as M2 ports acquire
their callers. The server is also above the warning threshold; its native desktop
ownership and update lifecycle modules are the next seam, separate from its
public listener and forwarding code. Neither needs to be moved into this plugin
slice to remain below 12,000 lines. PR evidence records exact sizes and CRATE-9
clean and incremental build timings; no new heavy dependency or profile change
is needed.

The JSON codec's `float_roundtrip` feature unifies throughout the Cargo graph,
as it already does on main. `unbounded_depth` is confined in behavior by the
plugin codec's explicit envelope bound. Finite numbers retain JavaScript
rounding. Signed overflow uses collision-free internal sentinels, is validated
as Infinity over private IPC, and serializes as null at JSON.stringify output
boundaries. User strings containing the sentinel prefix remain distinct.
