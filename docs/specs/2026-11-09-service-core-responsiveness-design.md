# Service core responsiveness: work proportional to change, not history

Status: approved by the maintainer on 2026-11-09. Part 1 (steps 1–3) is implemented; steps 4–6 follow in a separate plan.

## Why

The maintainer reports that every pacer operation is slow when it should feel instant.
The cause is architectural. Patching individual hot spots has moved the stall around
without removing it (see "Evidence").

The service does work proportional to the whole task history on a timer, on the same
thread that answers requests:

1. **Every background pass touches every task.** The link pump (`src/link/pump.ts`,
   `pumpOnce`, every 15 s) loads every non-archived task, resolves it, probes terminals,
   builds session data and JSON-diffs it against `link/task-data-seen.json`. Settled tasks
   that never change are reprocessed forever.
2. **One thread does everything.** In the TypeScript core (`pacer-core serve --internal`),
   the pump, queue drain, messaging broker, cleanup, usage, observations, certification and
   status timers all share the main thread with every forwarded request. Native Rust reads
   also call back into that thread through `/_internal/*` bridges for live inputs. When the
   main thread stalls, every surface stalls.
3. **Writes are expensive and make reads expensive.** Each `updateTask` takes a file lock
   that spins the thread (`withLockSync`), runs an immediate SQLite transaction, and writes
   and renames a compatibility JSON file. The rename changes the `tasks/` directory mtime,
   so every TypeScript connection's next access re-enumerates and stats every task file
   (`connection()` → `importJson`; commit `f79a93a1` already skips the per-file database
   lookup, but the `readdir` plus one `stat` per file remains). On the Rust side, every
   native `task.list` opens a new `TaskStore` (`crates/server/src/native/session_ops.rs:354`),
   and `TaskStore::open` takes an immediate schema transaction and runs a full
   `import_json` (`crates/store/src/task.rs:320-342`).
4. **Change is detected by re-diffing, not recorded.** There is no change log for the
   `tasks` table, so the only way to learn what changed is to look at everything.
5. **Writes happen when nothing changed.** For example, the queue drain rewrote every
   queued task's unchanged position on every tick, bumping `rev` each time.

## Evidence

Measurements from 2026-11-07 on a synthetic home with 5,000 settled and 10 queued tasks,
using `bun run perf` (branch `perf/core-benchmark`) and direct pump-phase timing. The
machine was heavily loaded (load average 50 to 200), so absolute numbers are inflated;
ratios are what matter.

| Phase | Per tick |
|---|---|
| Whole `pumpOnce` | 0.4 to 0.7 s (lighter load); 2 to 5 s (heavy load) |
| `drainQueue` (10 queued tasks) | 1.5 to 2 s, nearly all from rewriting unchanged queue positions (`src/tasks/drain.ts:219`) |
| `drainQueue` after skipping unchanged positions | 0.05 to 0.3 s |
| `snapshotTasks` | 0.5 to 1 s, dominated by a per-task repository lookup (`repoOf` → `registeredRepo` → `stampedRead`) |
| Whole tick after the drain fix | 0.8 to 1.6 s; the remaining profile is still led by task writes (lock, JSON write, rename) and per-task session and repo lookups |

Caveat: synthetic tasks have no `repo` field, which real tasks usually gain at launch,
so the repository-lookup cost may be overstated for real homes.

## Goals

- Requests answer quickly regardless of history size. The target is the same latency at
  50,000 settled tasks as at 500.
- Background work never delays a request.
- Task changes reach clients within about 1 s (today up to 15 s).
- Every writer (TypeScript core, Rust host, the maintenance child, offline CLI) stays
  correct, because the mechanism lives in the shared database rather than in one runtime.

## Acceptance targets (my call; adjust on review)

Most of the operations below are served natively by the Rust host
(`crates/server/src/native.rs`), so this design changes both runtimes where they read
tasks. TypeScript changes first, and the Rust change ships in the same step with parity
tests (RUST-7).


Measured with `bun run perf` on an otherwise idle machine, with 10 to 50 active tasks,
at 5,000 and 50,000 settled tasks:

- p99 latency under 100 ms for `snapshot.get`, `task.get`, `task.list` (first page) and
  `route`.
- The main thread of the TypeScript core is blocked less than 5% of the time.
- Background tick cost grows with changed plus active tasks, not with history: under
  50 ms per tick at 50,000 settled tasks with no changes.
- A task update appears on `/v3/events` within 1 s.
- `test/perf-core-responsiveness.test.ts` passes. It fails on `main` today by design.

## Non-goals

- Porting more of the core to Rust. This design changes TypeScript behavior first, as
  RUST-7 requires; the M2 P6 lifecycle port then ports the incremental design instead of
  today's full-scan pump.
- Changing the public protocol beyond additive changes (API-1, API-2).
- Redesigning the app, tray or TUI. They keep working unchanged; the desktop and TUI
  full-snapshot refetch becomes cheap because snapshots become cheap.
- Removing the compatibility JSON files. That is a separate decision (see "Open
  decisions").

## Anti-goals (failure even if it is faster)

- Any change that renames, moves or deletes task files or rewrites existing rows
  destructively (the 2026-10-19 incident; REPO-14, ARCH-16).
- A second database, or durable state held only in memory or private IPC (ARCH-16).
- Stale state shown to clients: a missed change must be caught, never silently dropped.
- TypeScript and Rust behaving differently on the same database.
- Older binaries or a rollback losing tasks during the JSON compatibility window.

## Design

### 1. A change log in the shared database

Add a `task_changes` table to `state/tasks.db`, filled by SQLite triggers on `tasks`
(after insert and after update):

```sql
CREATE TABLE IF NOT EXISTS task_changes(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL, rev INTEGER NOT NULL, state TEXT NOT NULL, at REAL NOT NULL);
CREATE TRIGGER IF NOT EXISTS task_changes_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO task_changes(task_id,rev,state,at) VALUES(NEW.id,NEW.rev,NEW.state,NEW.updated_at); END;
CREATE TRIGGER IF NOT EXISTS task_changes_update AFTER UPDATE ON tasks BEGIN
  INSERT INTO task_changes(task_id,rev,state,at) VALUES(NEW.id,NEW.rev,NEW.state,NEW.updated_at); END;
```

The update trigger fires only for real changes: `WHEN NEW.rev IS NOT OLD.rev OR
NEW.state IS NOT OLD.state OR NEW.archived IS NOT OLD.archived`. Bookkeeping writes such
as the follow-up `UPDATE tasks SET json_mtime` after an insert do not log a change. Import
upserts that bring in a newer revision do log one, because that is a real change from
another writer. When the table is first created on an existing home, readers start their
cursor at the current `max(seq)` and run one full reconcile, so a large first import does
not become a backlog of change rows to process.

Triggers run for every writer of the database, whichever runtime or version, so no
writer can forget to record a change, and TypeScript and Rust cannot drift. The schema
already uses this pattern (`work_events` and `work_task_changed` in
`crates/lifecycle/src/work.sql`). The change is additive and non-destructive: new table,
no rewrite of existing rows. Both schema owners (`src/tasks/store.ts` and
`crates/store/src/task.rs`) create it, and the parity suite covers it.

Readers keep a cursor (`seq`). The log is pruned to a bounded window (for example the
last 7 days or 100,000 rows; builder's choice) by the maintenance child. A reader whose
cursor is older than the oldest retained `seq` does one full reconcile (section 3), the
same contract as the outbox `reset`.

### 2. Updates that change nothing write nothing

`updateTask` (TypeScript) and `TaskStore::update` (Rust) compare the record after
`mutate` with the record before it. If nothing changed, they return without writing the
JSON, bumping `rev` or touching SQLite. This removes the queue-position churn and any
similar no-op writes in one place. Callers that depend on an unconditional `rev` bump
must be found and changed; the builder audits them.

### 3. The pump processes changes plus the active set

`pumpOnce` stops loading every task. Each tick it processes:

- tasks named in `task_changes` since its cursor;
- the **active set**, which needs time-based checks (process liveness, terminal probes,
  stall detection, retry timers). It is the union of:
  - non-terminal tasks (queued, running and the like);
  - tasks with a live worker record (`TaskRecord.live`);
  - tasks with an entry in the session registry or an Orca terminal, whatever their
    state. A settled or `needs_input` task can keep an open terminal, and its published
    `session.live`, `controller`, `viewers` and `terminalPresent` fields change without
    any `tasks` row changing.

  The active set is bounded by concurrency and open sessions, not by history. Session and
  terminal state are the second change source; the pump reads them only for this set.

Everything else is left alone. A **full reconcile** (today's behavior, chunked and
yielding) runs only at startup, after a cursor gap, and once a day in the maintenance
child. It is the safety net that guarantees nothing is missed.

The pump's per-task ledgers (`task-data-seen.json`, `task-states.json`,
`task-events-at.json`) are rewritten whole every tick today, so their cost grows with
history. They move into tables in the same database, keyed by task id and read and
written only for the tasks a tick touches. On first start, the existing JSON ledgers are
imported once and left in place (non-destructive).

The pump's cursor is stored durably with its ledgers, in the same transaction as the
publish bookkeeping, so a crash replays changes rather than skipping them. Session
membership and the reconcile timestamp share that transaction. A private pinned-outbox
receipt recovers published task data if the worker stops between append and checkpoint,
including after another runtime rotates the public outbox (ADR 0024).

### 4. Task events within about 1 s

Native and TypeScript event streams use a 250 ms fallback, preserving TypeScript publisher wakes and the 1,000 ms task-log follow default; empty event polls skip task enrichment and native question-body reads. This cadence leaves delivery headroom but does not guarantee subsecond delivery under load.

Since a tick now costs little when nothing changed, the pump checks the change log often:
a cheap `SELECT max(seq)` every 500 ms in the background worker, and a task pass only
when it moved or the active set needs a time-based check. A quiet poll returns before
task decoding, status refresh and queue drain. Task-only passes reuse the most recent
periodic status for transition alerts. Changed-task notifications run on the fast pass,
using the cached periodic setup context; recovered transitions also remain notification
candidates. Quiet polls perform no notification or entity work. The 15 s cadence stays for the
expensive periodic work (quota alerts, strategy fingerprints, host probes, entity diffs).

### 5. Background work leaves the request thread

All periodic loops in the TypeScript core (pump, queue drain, messaging broker, cleanup,
usage refresh, observations, certification, status refresh) move into one background
Worker, following the existing supervision Worker (`src/tasks/supervision-worker.ts`).
The main thread serves HTTP, SSE and session WebSockets only.

- The Worker opens its own SQLite connection and communicates through durable state
  (database, outbox), as the loops already do. It is not a new source of truth.
- In-process wakes that today cross loops (`notifyOutbox`, `subscribeOutbox`) become a
  message from the Worker to the main thread.
- In-process task-lock guards (`heldTaskLocks`, `preparingTaskLocks` and
  `withTaskPreparation` in `src/tasks/store.ts`) do not cross threads. Coordination
  between the Worker and request-path mutations uses the cross-process lock files, which
  already serialize the Rust host and offline CLI. Preparation markers become lock files
  in the same protocol, so a thread, a process and the Rust host all see them. Re-entrancy
  stays per thread. Tests cover drain (Worker) racing request-path admission (main).
- The `/_internal/*` bridges stay on the main thread as request work. Anything they need
  from caches the loops keep warm is either recomputed for the active set only or handed
  over by the Worker; the builder picks per bridge.
- If the Worker dies or stops heartbeating, the main thread restarts it with backoff and
  reports degraded service in diagnostics. It does not silently fall back to running
  the loops on the request thread.
- Sync locks (`withLockSync`) taken on the request thread are audited. Request paths that
  mutate keep the cross-process lock protocol (ADR 0015, Rust `foundation::lock`) but
  must not spin while another process holds it for long; the builder chooses an async
  acquire or a bounded wait with a `conflict` error.

### 6. Reads stop rescanning the task folder

`connection()` runs `importJson` (`readdir` plus a `stat` per task file) whenever the
`tasks/` directory mtime changes, and every task write changes it. Rust runs a full
import on every `TaskStore::open`, which native reads do per request. Import moves to:

- service startup, before the listener reports ready (crash recovery: a JSON revision
  written before its SQLite commit);
- the background Worker, at a low cadence (about once a minute), using the existing
  directory stamp and per-file mtime map. This bounds how long a JSON-only write from
  another binary can go unseen, without putting a folder scan on any request;
- the maintenance child's daily pass;
- an explicit `pacer tasks import` for recovery.

Request paths in both runtimes never scan the folder. A single-task read checks
only that task's JSON copy with one `stat`, as the Rust log reader already does, and
imports it when it is newer: the Rust host forwards such reads to the TypeScript core
for compatibility, and a crash before commit stays visible on the next read of that
task. List and snapshot reads never import. Rust `TaskStore::open` imports once per
process for each database (path and inode), records that only after the import
succeeds, and always imports a new database, or an empty one while JSON copies
exist, since Linux can reuse the inode of a recreated file. It skips the schema
transaction once the schema is ready.
Read-only openers already return `CompatibilityRequired` when an import is pending
(`crates/store/src/task_log_reader.rs`); that stays the behavior when the service has
not finished its startup import.

This keeps the recovery guarantee of the SQLite store ADR: a crash between the JSON
rename and the commit is recovered when the next process opens the store. ADR 0021
(single installation owner) means a second binary does not write JSON-only tasks while
the service runs. Rust `import_json` gains the same 64-record batching TypeScript
already has (`docs/specs/2026-11-02-sqlite-startup-contention-design.md`).

### 7. History reads run in SQL

This applies to both runtimes: TypeScript `core.tasks.list` and `apiTasks`, and Rust
`task_list_page` and `snapshot_tasks` (`crates/read-model/src/tasks.rs`), which serve the
native `task.list` and `snapshot.get`.

- `core.tasks.list` (`src/core/tasks.ts:75-88`) and its Rust counterpart push `limit`, `before`, `repo`,
  `states` and `executor` into SQL with supporting indexes, instead of loading and
  filtering every row in JavaScript. The existing inconsistency of `since` (SQL filters
  on `updated_at`, JavaScript on `createdAt`) is resolved to one meaning and documented.
- Repository labels are computed from the repository registry once per request, not
  looked up per task (`apiTasks` / `repoOf`).

### 8. Event replay reads from the client's position

`legacyEventsSince` (TypeScript) and `events_since` (Rust, `crates/read-model/src/events.rs`)
re-read the whole `link/outbox.jsonl` on every poll for every client. Both keep a
per-process index from `seq` to byte offset, invalidated on rotation, and read only new
lines. The replay also derives aggregates over the whole outbox (TypeScript
`openDiscoveryAtCounts`, Rust's `open` and `at` maps). The index holds these aggregates
too and updates them as it reads new lines; it rebuilds them from the file only after a
rotation or on first use. The file format and rotation rules stay the same.

## Order of work

Each step is independently shippable, measured with `bun run perf` before and after, and
validated live (CT-11).

1. **Measurement gate.** Land the benchmark and regression test (`perf/core-benchmark`),
   with the regression test gated until step 4 lands so `main` stays green.
2. **No-op updates and task-folder rescans** (sections 2 and 6), both runtimes. Smallest
   change; removes write churn and the per-request Rust import.
3. **Change log** (section 1), both runtimes, with parity tests.
4. **Incremental pump, ledger tables, faster task events** (sections 3 and 4).
5. **History reads in SQL; replay from position** (sections 7 and 8), both runtimes.
6. **Background Worker** (section 5).

Steps 2 to 5 remove the work that grows with history. Step 6 then ensures whatever work
remains cannot block requests.

## Constraints and rules

- ARCH-1 to ARCH-3: the service owns state; clients use the API; multi-client safety.
- ARCH-16 and ADR 0004 point 9: one database, WAL, busy timeout, JSON write-through and
  retention compatibility. All schema changes are additive.
- REPO-14: changes under `PACER_HOME` are non-destructive; existing ledger files are
  imported and left in place.
- RUST-7: behavior changes land in TypeScript first; Rust store changes ship with parity
  tests in the same PR.
- API-1, API-2: protocol changes are additive only.
- CT-4, CT-11: tests with each behavior change; live validation on every affected surface.
- Development never touches the maintainer's real install (`AGENTS.md`); benchmarks use a
  temporary `PACER_HOME`.

## Left to the builder

- Change-log retention window and the exact ledger table shapes.
- How often to poll `max(seq)`, within the 1 s event-latency target.
- Async acquire versus bounded wait for request-path locks.
- Whether the background Worker absorbs the existing supervision Worker or runs beside it.
- Index choices for history listing.

## Open decisions for the maintainer

1. **End the JSON write-through window.** The SQLite store ADR (D3a) kept per-task JSON
   for one release; it is still on, and an ADR amendment is needed to end it. Removing it
   would halve write cost and remove the folder-rescan machinery entirely. This design
   does not depend on it. Recommendation: decide after step 4, with rollback evidence.
2. **ADR for the change log and background Worker.** These change how the service and
   both runtimes coordinate. Recommendation: record them as an ADR alongside step 3.
