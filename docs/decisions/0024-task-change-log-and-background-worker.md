# 0024: Task change log and background worker

Date: 2026-11-10

Status: Proposed. Accepted when the maintainer merges it.

Amends: how the service reports and reacts to task changes and where periodic work runs, as recorded against the [sqlite task store](../decisions/2026-10-19-sqlite-task-store.md) and the [service responsiveness design](../specs/2026-11-09-service-core-responsiveness-design.md).

## Context

pacer's service does work proportional to the whole task history on a timer, on the same thread that answers requests. The [service core responsiveness design](../specs/2026-11-09-service-core-responsiveness-design.md) was approved to make per-request and per-tick cost stop growing with history. Part 1 landed the pieces this ADR depends on:

- #824 added the core-responsiveness benchmark and pump-phase timing (the measurement gate).
- #825 stopped task writes and reads from scaling with task history (no-op updates and bounded folder rescan).
- #827 added the trigger-filled `task_changes` change log in the shared database.
- #828 accepted an unchanged revision at the route checkpoint.

Part 2 builds on them: SQL paging for `task.list` in both runtimes (#844, #847), outbox replay from each client's position in both runtimes (#843, #845), the incremental pump and the background worker.

The change log and the move of periodic loops to a background worker change how the service (the TypeScript core) and the Rust host coordinate. The design's open decision 2 asked for them to be recorded as an ADR alongside step 3; this is that record.

Today the pump (`src/link/pump.ts`, `pumpOnce`) loads every non-archived task every 15 s, resolves it, probes terminals, builds session data and JSON-diffs it against `link/task-data-seen.json`. Settled tasks that never change are reprocessed forever. The change log makes it possible to answer "what changed since my cursor" in one bounded query instead of a full pass. Periodic loops (pump, queue drain, messaging broker, cleanup, usage, observations, certification, status) all share the main thread with every forwarded request, so when that thread stalls, every surface stalls. Moving them to a worker leaves the request thread free.

## Decision

1. **The trigger-filled `task_changes` log is the change source for both runtimes.** `task_changes` is created by SQLite triggers on `tasks` (after insert and after update), so every writer of the database — the TypeScript core, the Rust host, the maintenance child, the offline CLI — records a change automatically, whichever runtime or version. No writer can forget, and TypeScript and Rust cannot drift. The update trigger fires only for real changes (`rev`, `state` or `archived` differing); a no-op bookkeeping write does not produce a log row. Both schema owners (`src/tasks/store.ts` and `crates/store/src/task.rs`) create the table, and the parity suite covers it. Readers keep a `seq` cursor and process only rows after it. A reader whose cursor is older than the oldest retained `seq` runs one full reconcile, the same contract as the outbox `reset`.

2. **Periodic loops run in one background Worker.** The pump (which runs the queue drain), messaging broker, cleanup sweep, usage refresh, observations and certification run in a single Worker with its own SQLite connection, following the existing supervision Worker pattern. The main thread keeps HTTP, SSE and WebSocket, the snapshot-cache refresh, the status refresh (it feeds the read cache synchronously) and the `/_internal/*` bridges as request work. In-process wakes that today cross loops (`notifyOutbox`/`subscribeOutbox`) become a message from the Worker to the main thread so SSE still wakes on a publish. Coordination between Worker and request-path mutations uses the cross-process lock files that already serialize the Rust host and the offline CLI, so a thread, a process and the Rust host all see the same lock. Silence is counted in monitor ticks, not wall-clock time. If the Worker dies or stops heartbeating, the main thread stops it gracefully (it finishes its current loop and releases its file locks, then is terminated after a bounded grace period), restarts it with backoff and reports it in `pacer doctor`; it does not silently fall back to running the loops on the request thread. Compiled releases resolve both workers from the release bundle root. `pumpOnce` internals are unchanged; only where it is called from changes.

3. **Single-task JSON pickup replaces the folder rescan.** Request paths never scan the whole task folder. A single-task read checks only that task's JSON copy with one `stat` and imports it into SQLite when it is newer, so a JSON-only write from another binary is a one-file read, and a crash before commit stays visible on that task's next read. Full folder import runs when a process opens the store and once a minute on the supervision Worker (TypeScript); Rust imports once per process per database and rebuilds a new or empty database from the JSON copies. List and snapshot reads never import. Existing `link/*.json` per-task ledgers are imported once into the new tables and left in place (non-destructive).

4. **Reconcile cadence.** A full reconcile (paging task ids 200 at a time, reading each page once) runs on the pump's first tick, after a cursor gap, when the change backlog exceeds one page, and every 10 minutes. The 15 s periodic work (entity diffs, quota, strategy and host checks) uses only the changed and active tasks and the bounded snapshot window, never the whole history. Between reconciles the pump processes only changed and active tasks: tasks in `task_changes` since its cursor, non-terminal tasks, tasks with a live worker record, and tasks with a session-registry entry or an Orca terminal. The active set is bounded by concurrency and open sessions, not by history. The pump's per-task ledgers and its cursor live in SQLite and are written after the outbox publish succeeds, so a crash replays changes rather than skipping or duplicating them. The legacy `link/*.json` ledgers are imported once and still written through this release, so a rolled-back binary does not re-alert settled tasks.

## Consequences

- **Write amplification is one row per real change.** Each genuine task change adds one `task_changes` row inside the existing transaction; it does not add a lock or a pass, so the cost is bounded and small.
- **The log is pruned to a bounded window.** The maintenance child prunes to the last 7 days or 100,000 rows (whichever comes first). A reader whose cursor falls behind the retained window does one full reconcile, so the bound can never cause a missed change.
- **Same-revision imports are not logged.** Import upserts that bring in a newer revision log one change (that is a real change from another writer); imports that change nothing do not.
- **Outbox rotation has slack.** Both rotators rotate a quarter past their limits and trim back to the same retention, so a full outbox does not rotate (and rebuild every replay index) on each append.
- **JSON write-through stays on.** The per-task JSON compatibility files remain and are still written on every task write; this ADR does not change that. Ending the write-through window is a separate decision (the design's open decision 1) and needs its own amendment once the rollback evidence is in.
- **Both runtimes must agree on trigger and reader semantics.** TypeScript and Rust both create the schema and both keep cursors; the parity suite covers the log so the two runtimes cannot drift on the same database.
- **A stale client is never shown stale state.** The reconcile contract and the cursor ordering in the outbox guarantee a change is caught, never silently skipped, and never published twice for one change.

## Alternatives considered

- **Keep detecting change by re-diffing every task each tick.** Rejected. Re-diffing is the whole-history cost this ADR exists to remove, and it could not scale to 50,000 settled tasks.
- **Maintain the change source in the worker or an in-memory structure.** Rejected. A change source must be durable and shared; putting it in the database makes every writer (whichever runtime or version) record it and keeps TypeScript and Rust from drifting (ARCH-16).
- **Let the main thread fall back to running the periodic loops when the worker dies.** Rejected. Silent fallback would put the loops back on the request thread exactly when the worker is unhealthy, and hide the failure. The main thread restarts the worker with backoff and reports degraded service instead.
- **Keep importing the whole task folder on request paths.** Rejected. The per-request folder scan is the step-2 cost; a single-task JSON pickup restores the recovery guarantee without scanning history on any request.