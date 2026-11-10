# Private scalar projection for native task cost

Status: accepted for implementation; final runtime and performance review required.

Native `task.get` previously decoded every task record, including archived history,
before computing cost. A missing usage reading needs no peers; other readings
need only an existential interval check. Keep existing native cost behavior and
replace the history materialization with a private projection in `tasks.db`.

## Ownership and maintenance

`pacer-store` owns the private `task_cost_*_v1` tables, indexes and triggers in
`tasks.db`. Metadata format 2 records `clearing`, `building` or `ready`, plus a
nullable owner-ID cursor. Null-cost reads do not initialize it. Readiness remains
independent of the existing task schema/import readiness check.

The first cost-bearing read drives resumable short IMMEDIATE transactions:

1. Validate every object's name, SQLite type and owning table, and the metadata's
   shape, version, cardinality, phase and cursor. Wrong-kind/owner collisions,
   unknown future versions or inconsistent state fail closed. The earlier
   version-only format 1 is recognized separately and rebuilt.
2. Install all maintenance triggers and enter `clearing`. Clear at most 256
   derived interval rows and 256 invalid-owner rows per transaction, not entire
   owners: one task can have arbitrarily many attempts. During clearing, triggers
   delete stale owner rows but skip projecting replacements. The later complete
   scan covers these writes, and partial data is never queried.
3. Once both derived tables are empty, create missing indexes on the empty tables
   and enter `building` in the same transaction. Triggers now project all writes.
4. Seek at most 16 task IDs after the cursor, read their current records, replace
   each owner's projection and advance the cursor in one transaction. Check a
   10ms work budget after each record and commit early when reached. Release the
   transaction and yield for 1ms before another batch.
5. Once the cursor's remaining range is empty, mark `ready` and clear the cursor.
   The cost query checks complete readiness again in its own read snapshot.

Every batch revalidates object identity and metadata inside its transaction.
Missing maintenance/table/index/readiness while building or ready restarts clearing
and a complete rebuild; it never advances an old cursor. Indexes are intentionally
optional only during clearing. Concurrent builders re-read the committed phase
and cursor under the write reservation, so they need no leader lease. A crash
rolls back the current batch; prior committed progress resumes. An error is
explicit, never an incomplete no-match or fallback to historical JSON scanning.

INSERT, changed record/id UPDATE and DELETE maintain the projection in each task
writer's transaction. Triggers use built-in SQLite functions, so old Rust and Bun
connections need no application changes, UDFs, foreign-key setting or recursive
triggers. INSERT cleans NEW owner for REPLACE; UPDATE cleans OLD and NEW owners,
including same-revision changes. JSON-mtime-only writes skip projection. A write
behind the build cursor is already handled by its trigger; a write ahead is
idempotently reprojected later. Import/recovery UPSERTs use the same extraction
fragment. Authoritative records and JSON copies are not rewritten by bootstrap.

Inode refresh precedes readiness. Future migrations rebuilding `tasks` must
rebuild the projection, not copy a stale marker. Bootstrap and the store portion
of native `task.get` run via the existing Tokio `spawn_blocking` pattern, keeping
SQLite waits and between-batch sleeps off async runtime workers.

## Semantics and unsupported records

Completed attempts contribute a window if either start or end account is a
nonempty string. Pending windows require record state `running` and a nonempty
pending start account. Non-array attempts contribute none; nonnumeric completed
endpoints default to zero. Pending starts follow run start, attempt start,
creation time, then request-time `now`; pending ends are always request-time
`now`. Archived peers remain eligible; self exclusion uses the record ID.
Strict inequalities are retained without positive-width assumptions: zero and
reversed target/peer intervals are not discarded. Native account matching remains
unchanged, including its inherited difference from TypeScript account equality.

Supported writers/importers serialize parsed objects with unique keys. Duplicate
keys at any depth, malformed JSON, non-finite numbers or non-string record IDs are
flagged by owner in a private invalid table. Cost-bearing reads fail explicitly
while such a row exists; they never silently use SQLite's first-key semantics
where Rust would use the last key. A normal canonical rewrite or deletion clears
the flag transactionally. No automatic normalization alters authoritative data.

## Numeric correctness and performance limits

Projection rows store original numeric scalar tokens. Only integer tokens within
inclusive ±2^53 and default-zero endpoints receive exact numeric index bounds.
Other values retain their original tokens for Rust's `serde_json` conversion.
This preserves strict floating-point boundaries without assuming SQLite and Rust
round arbitrary decimal tokens identically. Account emptiness uses byte length,
including strings containing NUL.

An end-first partial B-tree seeks completed exact windows, with start as a
residual inequality. Fractional/exponent/out-of-range integer windows use a
separate scalar residual scan; pending windows have their own index and dynamic
fallback. Candidates stream and stop at the first match. Ready queries never join
historical task records or decode their JSON. Memory is bounded by one candidate's
scalar tokens, not total history; token size itself is not capped.

This is not a constant-time or universally selective interval index. End-first
no-match queries can examine O(A) exact entries; realistic fractional histories
can parse all A scalar rows. Bootstrap parses O(B) historical record bytes and
maintains O(A) derived rows/indexes. Total cold request delay can still be tens of
seconds, and callers wait until the complete projection is ready.

The batch limits bound scheduled work, not absolute wall-clock time: a single
large record/attempt array, disk stall or commit can exceed the 10ms check. The
1ms yield offers writers an opportunity; it is not a fairness proof. Validate
retained-history competing writers against the existing five-second timeout,
including multiple builders, and verify unrelated HTTP/health progress. Report
cold duration, writer waits, storage/WAL growth and integer/fractional warm paths
separately. No cold 100ms or overall responsiveness claim follows from this design.
