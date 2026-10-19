# SQLite task store decision — 2026-10-19

Status: implementation decision recorded 2026-10-19.
Source: task-store performance diagnosis; refines the persistence mechanism under
[clients over one local service](2026-10-16-clients-over-local-service.md).

## Context

The diagnosed installation held 645 task JSON records and 638 task logs totaling
109 MB. `/v3/snapshot` synchronously opened every task record with
`listTasks(ctx, Infinity)`, filtered to active tasks and the last 24 hours, then
read each selected task again through `taskStatus`. That work blocked the
service event loop, stalled snapshots and contributed to the observed service
restart loop. No precise stall duration was captured; these are the measured
file counts and size, not a timing benchmark.

The service owns the lifecycle and public API, but CLI fallback paths and
independent runners also persist task updates. Several processes can therefore
write at once. A process-local cache alone cannot prevent lost updates.

During validation at 19:52 on 2026-10-19, a reduced test environment fell back
to the real user home. Implicit first-open migration renamed all 665 real task
JSON files to `.json.migrated`, and the installed older binary saw zero tasks.
The planner restored the originals from backup. This incident requires
non-destructive import and write-through compatibility; opening a store must
never rename, move or delete task JSON.

## Decisions

- **D1. Store task records in `PACER_HOME/state/tasks.db` using `bun:sqlite`.**
  The directory is mode 0700 and the database mode 0600. Connections use WAL,
  a 5000 ms busy timeout and `synchronous=NORMAL`. Full `TaskRecord` JSON stays
  in `record`; id, revision, state, creation/update/settlement times and repository
  are derived on each write. State, update time and creation time have indexes.
- **D2. Keep the store API and task artifact directory.** `createTask`, `readTask`,
  `updateTask`, `withTaskLock`, `listTasks` and `tasksDir` retain their roles.
  Logs, briefs and bundles remain under `tasks/`. `listTasksWhere` applies state,
  update-time and limit filters in SQL, preserving newest-id ordering.
- **D3a. Write through to JSON for one release.** Every create/update also writes
  `tasks/<id>.json` atomically using the existing JSON representation. SQLite is
  the indexed read path; retained JSON keeps older binaries, run wrappers and
  rollback working. JSON writes may be dropped only in a later release after this
  ADR is amended and the compatibility window is explicitly closed.
- **D3. Serialize mutations in SQLite.** `updateTask` reads, mutates and writes
  inside an immediate transaction. The reentrant per-task operation lock remains
  for multi-step revision checks and side effects; failed callbacks roll back.
  SQLite arbitrates writers across CLI, service and runner processes.
- **D4. Query active and recent records and reuse unchanged selections.** Snapshot
  reads combine indexed active-state and update-time queries. A connection token
  combines `PRAGMA data_version`, `total_changes()` and a connection generation
  to detect both external commits and local writes. Snapshot caching still checks
  runner liveness and time-based expiry on every request. Imported update times
  come from persisted creation, attempt and review times; new writes also use the
  operation time. Existing presentation recency rules remain in force.

## Alternatives considered

- **Service as sole writer with an in-memory table.** Consistent with the long-term
  service ownership direction, but requires changing independent runner and CLI
  fallback lifecycles and making service availability mandatory for each write.
- **File watcher plus cache.** Avoids some repeat reads but requires initial scans,
  watcher recovery, cache invalidation across processes and separate locking.
  Recency queries still require an application-maintained index.
- **SQLite (chosen).** Bun already supplies the driver, multiple processes can
  write safely, and active/recent queries use database indexes without opening
  each historical record. No new service or runtime dependency is required.

## Consequences

- The hot task selection reads indexed rows instead of historical task files.
  The JSON payload remains compatible with the existing task model and API.
- SQLite has one writer at a time. Transactions must stay short and synchronous;
  contending writers can wait up to the configured busy timeout. Synchronous
  database work still runs on the event loop, but is bounded by selected records
  rather than directory size outside a changed-directory import scan.
- WAL creates private database sidecars. Backups must use SQLite's backup/export
  facilities or stop all writers before copying the database and its WAL.
- `synchronous=NORMAL` trades durability of the newest commits during power loss
  for less commit I/O. SQLite retains transactional consistency.
- Older binaries can read every successful write and their atomic JSON writes
  are imported on the next store access. Per-task operation locks remain shared.
- JSON and SQLite are not one atomic filesystem transaction. Write JSON inside
  the SQLite transaction before commit; if the process crashes after the rename,
  the next import recovers that JSON revision. Failed mutation callbacks change
  neither copy. Avoid running administrative restore operations with active writers.

## Migration and rollback

Import `tasks/*.json` with idempotent upserts when opening a database, including
when it is missing. Never rename, move, delete or rewrite imported JSON. Corrupt
records produce warnings and stay untouched. A directory mtime/ctime stamp is
checked on cached accesses; only a changed stamp triggers enumeration and per-file
mtime checks, and only changed files are read. This relies on the existing atomic
temp-file + rename protocol used by older binaries: arbitrary in-place edits do
not change directory mtime and are outside that protocol.

Persist each imported/written JSON mtime with its row. Import higher revisions,
or equal revisions with newer mtimes (also rows without a recorded mtime).
Lower revisions restored from stale backups do not replace newer rows. Import
commits invalidate snapshot tokens through the existing SQLite change checks.
A directory change during a scan is checked again on the next request.

The live UI seed creates and updates records through the store. Local run
wrappers and SSH remote scripts do not write task JSON: supervisors already use
`updateTask`, and remote hosts keep only run artifacts and return results locally.

For rollback, stop all writers and start the older binary against the retained
JSON files. No export or archive restoration is needed. To rebuild SQLite from
JSON, stop all writers and move the database and WAL/SHM aside together before
reopening. Never remove a live WAL file.

## Revisit when

- The service becomes the only process that needs to persist lifecycle changes.
- Database contention or task volume requires asynchronous database work or
  additional query indexes.

## Addendum — task retention (2026-10-19)

- `task_retention_days` defaults to 14; zero disables archiving. Only terminal,
  reviewed or dismissed tasks with a known settlement before the window qualify.
  Reviews extend that window. Live local worktrees and recorded remote worktrees
  veto archiving; retention never removes worktrees. New terminal transitions
  persist `settledAt`; legacy attempt/review timestamps supply known settlement.
- SQLite retains the complete record, additive `archived`/`archivePath` metadata,
  and an indexed archive flag/settlement query. Default lists and snapshots omit
  archived rows; `task.list { all: true }` includes them and ID lookups retain them.
- A daily single-flight service sweep uses bounded SQL pages and asynchronous,
  streaming gzip to avoid holding bulky logs in memory or blocking health checks.
  `task.prune` / `pacer tasks prune [--dry-run]` expose the same policy manually.
  Dry runs estimate actual compressed sizes without writing archive files.
- Archive artifacts live in `archive/YYYY-MM/<id>/`, using the creation month in
  UTC, mode 0700 directories and 0600 files. Task-prefixed log, Markdown, bundle
  and JSON files move there; only logs are gzip compressed. Compression completes
  before taking the per-task operation lock; revision and file checks reject
  concurrent changes. The SQLite update commits before originals are removed.
  The sweep/restore lock also serializes administrative operations across processes.
- **Compatibility exception to D3a:** archived JSON write-through files move with
  the artifacts. Older binaries simply stop listing archived tasks, which is
  acceptable for this release. Updates to archived records write JSON in the
  archive. Opening/importing the store remains non-destructive. Rollback users
  who need archived history visible must restore it before starting older binaries.
- `task.restore` / `pacer tasks restore <id>` stream logs back to their original
  names and regenerate compatibility JSON from SQLite. Existing destinations
  produce a conflict. Administrative operations should run without older writers:
  older binaries do not understand archive metadata. Filesystem and SQLite changes
  are not one transaction; an interruption can leave duplicate originals or an
  orphan archive directory, but original contents remain recoverable. Inspect those
  copies before retrying; never delete a conflicting copy blindly.
