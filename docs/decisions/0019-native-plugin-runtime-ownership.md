# Native plugin runtime ownership

Date: 2026-11-02. Status: proposed implementation boundary for P4b shadow libraries.

The Rust plugin host needs concrete capability effects without growing registry
and RPC admission into one crate beyond CRATE-1. TypeScript remains authoritative
under RUST-7; this change registers no native client operation.

## Capability and attempt ownership (2026-11-03)

The original 2026-11-02 host4/runtime3 layout is superseded by the
coordinator's Candidate B implementation decision, pending merge. Keep registry,
subprocess plugin RPC, admission and reqwest in `pacer-plugin-host` (layer 5).
`pacer-plugin-runtime` (layer 4) owns task attempts, Git/worktree/remote receipts,
run directories and the private Orca policy/session/journal unit.
`pacer-plugin-capabilities` (layer 3) owns pinned filesystem/executable resources,
byte/process stages, authority/grants and desktop work leases. Its Store2 edge
exists only for the unchanged private `From<StoreError> for BrokerError` mapping;
it introduces no TaskStore access, mutation or alternate state protocol.

The capability crate defines the single BrokerError and CapabilityEffect;
runtime and host re-export the same types and modules, including the existing
native_orca grant paths. The StoreError denial remains exactly
`executor run owner or source changed`. Opaque owner fields stay private.
This updates planned registry/ownership metadata under unchanged CRATE-4, limits
and heavy ownership; it grants no exception or constitution amendment.

Keep bounded byte payloads in `pacer-plugin-wire` (layer 1), JavaScript JSON
semantics in `pacer-js-json` (layer 0), and Bun glob matching in
`pacer-bun-glob` (layer 1). Dependencies point down; no plugin imports host crates.

JavaScript slice counts UTF-16 units and may split a surrogate pair. Rust scalar
strings cannot carry that result. `WireReply` retains those units until JSON
serialization; the scalar convenience API refuses a non-scalar conversion.
Future Orca RPC wiring must use the lossless broker path, rather than silently
serialize replacement characters. No client protocol or operation is changed.

The measured split is capabilities 4,213 LOC, runtime 7,781 LOC and host 4,970 LOC.
Both extracted ownership units are below the 8,000-line warning and 12,000 hard
limit; runtime remains above the 5,000 target while retaining its cohesive private
Orca attempt component. The next seam was Orca attempt/session ownership versus
direct/remote run and transfer ownership; the 2026-11-03 split below completes it. No code density,
new heavy dependency or limit change supplies these measurements. Four actual
before/after dev timing runs, including lifecycle leaf rebuilds, accompany the
split; compiler incremental caching is disabled equally and timings imply no
unsupported performance claim. The libraries remain unserved until cutover.

The subsequent Orca text-parity checkpoint measured runtime at **8,043 LOC**
(capabilities 4,218; host 4,970). Integrating direct-task exact edits and lease
validation measured runtime at 8,136 LOC (capabilities 4,237; host 4,970).
The Orca task-write migration on that base measured runtime at 8,231 LOC.
After the journal transaction correction and filesystem read-path validation,
the integrated measurement is **8,290 runtime LOC**, 4,298 capabilities,
4,972 host and 598 JavaScript JSON carrier. The 7,781-line
figure above remains the historical split measurement. The additional domain-local resolver and exact folder-record
reader stay with the cohesive private Orca owner while parity is corrected.
Under CRATE-1, the M2 follow-up was scheduled: **split Orca
attempt/session ownership from direct/remote run and transfer ownership** before
M2 closes; the section below records it as done. These measurements record the
warning and the next split, not an exception to the unchanged 12,000-line ceiling.
No crate, dependency edge, heavy dependency or workspace profile changes here;
the historical CRATE-9 timings are not relabeled for this source revision.

Task storage retains non-scalar JSON strings during import and ordinary metadata
updates. `read_wire` delivers the exact JSON; `read` is a scalar metadata preview.
Native Orca question clipping publishes a UTF-16 text overlay through the existing
shared task lock, SQLite transaction, revision CAS and atomic JSON write-through.
The overlay API permits only question text, so it cannot rewrite task identity,
state or revision. Explicit text replacement uses the lossless API even when the
intended replacement is U+FFFD. No second store or alternate state format exists.

## Orca/execution ownership split (2026-11-03)

`pacer-plugin-execution` (layer 4) now owns direct/remote run, Git and verified
transfer, worktree and SSH transfer owners over capability resources. It has no
Orca, registry or client operation. `pacer-plugin-runtime` moves to layer 5 and
keeps the cohesive private Orca attempt/policy/prompt/session unit.
`pacer-plugin-host` moves to layer 6. No other crate is renumbered;
`pacer-lifecycle` (layer 6) has no host edge, and any future lifecycle→host edge
would be same-layer and needs its own decision.

The eight moved files (including the run wrapper script) keep their bytes and
`src/`-relative paths. Runtime re-exports the five execution modules explicitly,
keeps its existing root re-exports and the capabilities glob; host is unchanged.
Every existing `pacer_plugin_runtime::…` and `pacer_plugin_host::…` path names the
same item, so type identity is preserved; only defining-crate paths change.
Tests stay at the runtime/host facades; execution has no tests or dev-dependencies.
A runtime identity test checks the re-exported types, trait bound, functions and
the shared BrokerError denial text.

Measured source size: execution 3,765 LOC, runtime 4,534, host 4,972,
capabilities 4,298, each below the 5,000 target. The historical figures above
stay as recorded. Limits, workspace profiles and the heavy dependency list are
unchanged; no exception or constitution amendment is granted. CRATE-9 timings
for this graph change are recorded with the split's review evidence.
