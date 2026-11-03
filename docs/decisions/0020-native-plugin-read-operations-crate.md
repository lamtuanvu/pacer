# ADR 0020 — Native plugin operations crate

Status: proposed with PR #618.

The native plugin HTTP read slice adds settings reads and JSON
compatibility to a process host that has also grown on main.
Keeping the read domain separate avoids further growth in the process host,
which is already above CRATE-1's 8,000-line warning threshold.

`pacer-plugin-ops` owns four read operations (`plugin.list`, `plugin.doctor`,
`plugin.ui.list`, `plugin.settings.get`), settings reads
and the JSON compatibility codec. UI rendering and all mutation operations remain forwarded to
TypeScript. Archive/publisher implementation and strategy mutation work are
deferred; see the M2 ledger. It is
an unpublished layer-5 domain crate with a target budget of 5,000 hand-written
lines. It depends on generated protocol types and foundation below it. The authoritative TypeScript snapshot supplies grants,
avoiding a second strategy parser on the native list path. The server depends on the operations crate. The host
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
as it already does on main. The native codec bounds serde values at 512 levels
before they reach recursive clone/serialize/drop. Deeper HTTP bodies, owner
responses or settings stores select the TS read fallback; valid settings are
never quarantined merely for exceeding native depth. UI documents are rendered and validated only in TypeScript. Finite numbers retain JavaScript
rounding. Signed overflow uses collision-free internal sentinels, is validated
as Infinity over private IPC, and serializes as null at JSON.stringify output
boundaries. User strings containing the sentinel prefix remain distinct.
