# Native plugin capability resources

This unpublished layer-3 shadow library owns pinned filesystem/executable
resources, authority and host-issued grants, byte/process stages, host leases
and desktop work leases. It registers no operation and changes no TS behavior.
The layer-4 `pacer-plugin-execution` and layer-5 `pacer-plugin-runtime` re-export
these modules; layer-6 `pacer-plugin-host` retains its existing runtime facade and RPC admission.

BrokerError and CapabilityEffect have one identity across all three paths.
The direct Store2 dependency exists only for the private, unchanged
From<StoreError> conversion, whose denial is `executor run owner or source changed`.
There is no TaskStore access, callback migration or task-state mutation in this crate.
WorkLease retains its existing direct rusqlite transaction protocol.

Descriptors, byte stages and child ownership remain opaque. Pinning/no-follow
checks, arguments, cancellation/Drop cleanup, leases, receipts, deadlines and
UTF-16 delivery are unchanged. Fixed SSH script JSON and included read/write tests
move with their owners byte-for-byte. Heavy HTTP/registry behavior stays above.

Measured source size is 4,213 LOC, below the 5,000 target. Existing adversarial
fixtures still run through runtime/host imports; facade contract tests verify
error, trait and grant type identity and serialization. Native live surfaces are
UNVERIFIED under the recorded M2 unserved-library exception until first cutover.
