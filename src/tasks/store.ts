import { CoreError } from "../core/errors";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { withLock, withLockSync } from "../core/lock";
import { assertPacerHomeAllowed } from "../ctx";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "../types";
import { cachedMachineId } from "../identity/store";
import { TERMINAL_STATES, type Brief, type TaskRecord, type TaskState } from "./types";

const ID_RE = /^t-\d{8}-\d{6}-[0-9a-f]{4}$/;
export const tasksDir = (ctx: Ctx) => join(ctx.pacerHome, "tasks");
export function taskArchiveDir(ctx: Ctx, task: TaskRecord): string {
  if (!isTaskId(task.id)) throw new Error("invalid task id");
  return join(ctx.pacerHome, "archive", new Date(task.createdAt * 1000).toISOString().slice(0, 7), task.id);
}
export function taskSettledAt(task: TaskRecord): number {
  const times = [task.settledAt, task.review?.at, ...task.attempts.map(a => a.endedAt)].filter((n): n is number => n !== undefined && Number.isFinite(n));
  return times.length ? Math.max(task.createdAt, ...times) : Infinity;
}

// Keep connections for the service's cheap change checks; bound handles for callers
// that inspect many homes (including the test suite). Never evict a transaction.
// `imported` maps a JSON file name to the inode and mtime already reconciled with SQLite,
// so a scan only looks up the files that changed since. The inode catches an atomic
// rewrite that keeps the same coarse mtime (a few ms on Linux).
interface Connection { db: Database; generation: number; inode: number; directoryStamp?: string; imported: Map<string, string> }
const connections = new Map<string, Connection>();
let generation = 0;
// Test-only: counts directory enumerations (readdirSync calls) in importJson, so
// tests can assert a cached connection never triggers a folder rescan.
let jsonScanCount = 0;
export function taskJsonScanCount(): number { return jsonScanCount; }
const columns = "id, rev, state, created_at, updated_at, settled_at, repo, record, archived";
const placeholders = "?, ?, ?, ?, ?, ?, ?, ?, ?";

const snapshotUpdatedAt = `MAX(created_at,
    COALESCE(json_extract(record,'$.attempts[#-1].startedAt'),0),
    COALESCE(json_extract(record,'$.attempts[#-1].endedAt'),0),
    COALESCE(json_extract(record,'$.attemptStartedAt'),0),
    COALESCE(json_extract(record,'$.reviewRequest.at'),0),
    COALESCE(json_extract(record,'$.stopPending.requestedAt'),0),
    COALESCE(json_extract(record,'$.question.at'),0),
    COALESCE(json_extract(record,'$.question.answeredAt'),0))`;

// Expressions are shared by the indexes and predicates: SQLite requires an exact
// expression match. JSON null is an answered question; only a missing answer waits.
const visibleStateSql = `CASE WHEN state = 'running'
  AND json_extract(record, '$.question') IS NOT NULL
  AND json_type(record, '$.question.answer') IS NULL
  THEN 'needs_input' ELSE state END`;
// A stored needs_input still needs the user only while its question is unanswered
// (answer null), it was not superseded by a retry, and it is not dismissed.
// Matches `awaitsAnswer` (types.ts) and the Rust `awaits_answer`. The leading
// `state = 'needs_input'` lets a caller keep this indexed via tasks_state.
const awaitsAnswerSql = `state = 'needs_input'
  AND json_type(record, '$.question.answer') IS NULL
  AND json_extract(record, '$.retriedBy') IS NULL
  AND NOT COALESCE(json_extract(record, '$.dismissed'), 0)`;
const executorSql = `COALESCE(json_extract(record, '$.result.executor'),
  json_extract(record, '$.executor'), json_extract(record, '$.attempts[#-1].executor'),
  json_extract(record, '$.requestedExecutor'))`;
const repoKeySql = "json_extract(record, '$.repo.key')";
const legacyRepoSql = "json_extract(record, '$.repo') IS NULL";

// A corrupted or adversarial record can hold a non-number where a timestamp is expected
// (for example `review` set to a string, which has its own `.at` method). `Math.max`
// coerces such a value with `Number()` instead of treating it as absent, which can yield
// NaN; NaN then binds as SQL NULL, and NULL is no longer silently accepted now that the
// `task_changes` trigger requires `updated_at` to be NOT NULL. Treat anything that is not
// a finite number as absent (0), matching the `number()` guard the Rust store already has.
function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function activityAt(task: TaskRecord): number {
  return Math.max(task.createdAt, finite(task.attemptStartedAt), finite(task.review?.at), finite(task.reviewRequest?.at),
    ...task.attempts.map(a => finite(a.startedAt)),
    ...task.attempts.map(a => finite(a.endedAt)));
}
function values(task: TaskRecord, now: number): SQLQueryBindings[] {
  const updated = Math.max(now, activityAt(task));
  return [task.id, task.rev, task.state, task.createdAt, updated,
    TERMINAL_STATES.includes(task.state) && Number.isFinite(taskSettledAt(task)) ? taskSettledAt(task) : null,
    task.brief.repo ?? null, JSON.stringify(task), task.archived ? 1 : 0];
}

type PendingImport = { name: string; task: TaskRecord; mtime: number; signature: string };

const fileSignature = (stat: { ino: number; mtimeMs: number }) => `${stat.ino}:${stat.mtimeMs}`;

/** A JSON copy newer than what SQLite recorded for it, parsed and validated; null when
 *  the file is missing, already reconciled or corrupt. */
function jsonCandidate(entry: Connection, dir: string, name: string): PendingImport | null {
  const file = join(dir, name);
  let task: TaskRecord, mtime: number, signature: string;
  try {
    const stat = statSync(file);
    mtime = stat.mtimeMs;
    signature = fileSignature(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const known = entry.imported.get(name);
  if (known === signature) return null;
  // SQLite records only the mtime; trust it only for a file this connection has not seen,
  // since a known file with a new inode was rewritten even if its mtime did not move.
  if (known === undefined) {
    const row = entry.db.query<{ json_mtime: number | null }, [string]>(
      "SELECT json_mtime FROM tasks WHERE id = ?").get(name.slice(0, -5));
    if (row?.json_mtime === mtime) { entry.imported.set(name, signature); return null; }
  }
  try {
    task = JSON.parse(readFileSync(file, "utf8")) as TaskRecord;
    if (!task || !isTaskId(task.id) || name !== `${task.id}.json` ||
      !Number.isFinite(task.createdAt) || !Array.isArray(task.attempts) ||
      !task.attempts.every(a => a && Number.isFinite(a.startedAt) && Number.isFinite(a.endedAt)) ||
      !["queued", "running", ...TERMINAL_STATES].includes(task.state) ||
      typeof task.brief?.repo !== "string") throw Error("invalid task record");
    task.rev ??= 1;
    if (!Number.isSafeInteger(task.rev) || task.rev < 1) throw Error("invalid task revision");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`pacer: skipping corrupt task ${name}: ${String(error)}`);
    return null;
  }
  return { name, task, mtime, signature };
}

// Scanning/parsing may fault on disk or take arbitrarily long. Acquire the
// writer only for bounded commits, and let SQL recheck revisions against
// concurrent writers rather than trusting the scan's earlier snapshot.
function commitImports(entry: Connection, pending: PendingImport[]): void {
  const { db } = entry;
  for (let offset = 0; offset < pending.length; offset += 64) {
    const batch = pending.slice(offset, offset + 64).map(item => ({
      ...item, bindings: values(item.task, activityAt(item.task)),
    }));
    db.transaction(() => {
      for (const { task, mtime, bindings } of batch) {
        db.query(`INSERT INTO tasks (${columns}, json_mtime) VALUES (${placeholders}, ?)
          ON CONFLICT(id) DO UPDATE SET rev=excluded.rev, state=excluded.state,
          created_at=excluded.created_at, updated_at=excluded.updated_at,
          settled_at=excluded.settled_at, repo=excluded.repo, record=excluded.record, archived=excluded.archived,
          json_mtime=excluded.json_mtime
          WHERE excluded.rev > tasks.rev OR (excluded.rev = tasks.rev AND
            (tasks.json_mtime IS NULL OR excluded.json_mtime > tasks.json_mtime))`)
          .run(...bindings, mtime);
        if (task.settledAt !== undefined) db.query("INSERT OR IGNORE INTO task_first_settle(task_id,at) VALUES(?,?)").run(task.id, task.settledAt);
      }
    }).immediate();
    // A row that kept a newer revision rejects the file; rescanning it cannot change that.
    for (const { name, signature } of batch) entry.imported.set(name, signature);
  }
}

// Older binaries use atomic temp-file + rename writes. Only a directory change
// triggers enumeration/stat, and only changed JSON files are read. Never alter
// imported files: JSON remains the compatibility/rollback copy for this release.
function importJson(ctx: Ctx, entry: Connection, force = false): number {
  if (entry.db.inTransaction) return 0;
  const dir = tasksDir(ctx);
  const stat = statSync(dir, { bigint: true });
  const stamp = `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (!force && entry.directoryStamp === stamp) return 0;
  const pending: PendingImport[] = [];
  const present = new Set<string>();
  jsonScanCount++;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || !isTaskId(name.slice(0, -5))) continue;
    present.add(name);
    const candidate = jsonCandidate(entry, dir, name);
    if (candidate) pending.push(candidate);
  }
  for (const name of entry.imported.keys()) if (!present.has(name)) entry.imported.delete(name);
  commitImports(entry, pending);
  // Keep the pre-scan stamp: an atomic write during the scan is seen next time.
  entry.directoryStamp = stamp;
  return pending.length;
}

/** One task's JSON copy, checked with a single stat: a single-task read sees a newer
 *  revision left by an older binary or a write that crashed before its SQLite commit,
 *  as the Rust log reader does, without scanning the folder. */
function importTaskJson(ctx: Ctx, entry: Connection, id: string): void {
  if (entry.db.inTransaction) return;
  const candidate = jsonCandidate(entry, tasksDir(ctx), `${id}.json`);
  if (candidate) commitImports(entry, [candidate]);
}

function writeCompatibilityJson(ctx: Ctx, task: TaskRecord): { mtime: number; signature: string } {
  const file = join(task.archived ? taskArchiveDir(ctx, task) : tasksDir(ctx), `${task.id}.json`);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(task), { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  const stat = statSync(file);
  return { mtime: stat.mtimeMs, signature: fileSignature(stat) };
}

/** Existing WAL stores can be opened by readers while another process writes. */
function schemaReady(db: Database): boolean {
  const fields = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
  if (!["json_mtime", "archived"].every(name => fields.some(field => field.name === name))) return false;
  const objects = new Set(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type IN ('index', 'table', 'trigger')").all().map(row => row.name));
  return ["tasks_state", "tasks_updated_at", "tasks_created_at", "tasks_retention", "tasks_snapshot_window", "tasks_live", "task_first_settle",
    "task_changes", "task_changes_insert", "task_changes_update",
    "pump_seen", "pump_state", "pump_cursor", "pump_session", "pump_reconcile",
    "tasks_list_state", "tasks_list_executor", "tasks_list_repo", "tasks_list_legacy_repo", "tasks_capacity_failures", "tasks_native_unarchived_id"]
    .every(name => objects.has(name));
}

function connection(ctx: Ctx) {
  assertPacerHomeAllowed(ctx.pacerHome);
  const path = resolve(ctx.pacerHome, "state", "tasks.db");
  const cached = connections.get(path);
  if (cached) {
    // Reset/restore can replace the home while this process is alive. Do not
    // keep reading an unlinked database or return its old cache token.
    let inode: number | undefined;
    try { inode = statSync(path).ino; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (inode === cached.inode) {
      connections.delete(path);
      connections.set(path, cached);
      return cached;
    }
    cached.db.close();
    connections.delete(path);
  }
  const stateDir = resolve(ctx.pacerHome, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  mkdirSync(tasksDir(ctx), { recursive: true, mode: 0o700 });
  // Create privately before SQLite can create its WAL/SHM companions.
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const db = new Database(path, { strict: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    if (!schemaReady(db)) db.transaction(() => {
      db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, rev INTEGER, state TEXT, created_at REAL,
        updated_at REAL, settled_at REAL NULL, repo TEXT NULL, record TEXT NOT NULL, json_mtime REAL, archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at);
      CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at);`);
      // Accept databases created by the initial SQLite implementation too.
      const fields = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
      if (!fields.some(field => field.name === "json_mtime")) db.run("ALTER TABLE tasks ADD COLUMN json_mtime REAL");
      if (!fields.some(field => field.name === "archived")) db.run("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
      db.run("CREATE INDEX IF NOT EXISTS tasks_retention ON tasks(archived, settled_at)");
      db.run("CREATE INDEX IF NOT EXISTS tasks_native_unarchived_id ON tasks(id DESC) WHERE archived=0");
      // Index the exact snapshot event time once. All writers maintain expression
      // indexes, including older binaries and the Rust store; steady passes seek
      // the recent window instead of parsing historical records to sort them.
      db.run(`CREATE INDEX IF NOT EXISTS tasks_snapshot_window
        ON tasks(${snapshotUpdatedAt} DESC, id DESC)
        WHERE archived=0 AND COALESCE(json_extract(record,'$.dismissed'),0)=0`);
      // Failed retry candidates use the API event timestamp, not the write timestamp.
      // Include dismissed failures: dismissal does not clear executor failure evidence.
      db.run(`CREATE INDEX IF NOT EXISTS tasks_capacity_failures
        ON tasks(${snapshotUpdatedAt}) WHERE archived=0 AND state='failed'`);
      // The pump checks live membership every 500ms. Keep this selection bounded
      // by live records; an id-order scan would parse all settled JSON each time.
      db.run("CREATE INDEX IF NOT EXISTS tasks_live ON tasks(id DESC) WHERE json_extract(record, '$.live') IS NOT NULL");

      db.run(`CREATE INDEX IF NOT EXISTS tasks_list_state ON tasks((${visibleStateSql}), id DESC);
        CREATE INDEX IF NOT EXISTS tasks_list_executor ON tasks((${executorSql}), id DESC);
        CREATE INDEX IF NOT EXISTS tasks_list_repo ON tasks((${repoKeySql}), id DESC);
        CREATE INDEX IF NOT EXISTS tasks_list_legacy_repo ON tasks(repo, id DESC) WHERE ${legacyRepoSql};`);
      // settledAt is overwritten when a task settles again; Insights counts a task once, at its first settle.
      db.run("CREATE TABLE IF NOT EXISTS task_first_settle(task_id TEXT PRIMARY KEY, at REAL NOT NULL)");
      // Shared change log, filled by triggers so every writer (any runtime, any
      // binary version) is recorded once. Readers keep a `seq` cursor (changes.ts).
      db.run(`CREATE TABLE IF NOT EXISTS task_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, rev INTEGER NOT NULL, state TEXT NOT NULL, at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS task_changes_at ON task_changes(at);
        CREATE TRIGGER IF NOT EXISTS task_changes_insert AFTER INSERT ON tasks BEGIN
          INSERT INTO task_changes(task_id,rev,state,at) VALUES(NEW.id,COALESCE(NEW.rev,0),COALESCE(NEW.state,''),COALESCE(NEW.updated_at,NEW.created_at,0)); END;
        CREATE TRIGGER IF NOT EXISTS task_changes_update AFTER UPDATE ON tasks
          WHEN NEW.rev IS NOT OLD.rev OR NEW.state IS NOT OLD.state OR NEW.archived IS NOT OLD.archived BEGIN
          INSERT INTO task_changes(task_id,rev,state,at) VALUES(NEW.id,COALESCE(NEW.rev,0),COALESCE(NEW.state,''),COALESCE(NEW.updated_at,NEW.created_at,0)); END;`);
      // Pump ledgers (src/link/ledger.ts): per-task published state and the change-log
      // cursor, read and written only for the tasks a tick touches instead of rewriting
      // whole JSON files (link/task-data-seen.json, task-states.json, task-events-at.json).
      db.run(`CREATE TABLE IF NOT EXISTS pump_seen(task_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pump_state(task_id TEXT PRIMARY KEY, state TEXT NOT NULL, event_at REAL);
        CREATE TABLE IF NOT EXISTS pump_cursor(id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pump_session(task_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS pump_reconcile(id INTEGER PRIMARY KEY CHECK(id=1), at REAL NOT NULL);`);
    }).immediate();
  } catch (error) { db.close(); throw error; }
  for (const [key, entry] of connections) {
    if (connections.size < 32) break;
    if (!entry.db.inTransaction) { entry.db.close(); connections.delete(key); }
  }
  const entry: Connection = { db, generation: ++generation, inode: statSync(path).ino, imported: new Map() };
  try { importJson(ctx, entry); } catch (error) { db.close(); throw error; }
  connections.set(path, entry);
  return entry;
}

/** Explicit, off-request-path rescan of the tasks directory on the cached connection.
 *  Call periodically (the supervision Worker, the in-process fallback, the maintenance
 *  child) so a JSON-only write from another binary is seen without any request doing it.
 *  Returns the number of records imported. */
export function reconcileTaskJson(ctx: Ctx): number {
  const entry = connection(ctx);
  // Always enumerate: a directory mtime can stay the same across a same-tick rewrite.
  return importJson(ctx, entry, true);
}

/** Detect both other-process commits and writes on our own cached connection. */
export function taskStoreVersion(ctx: Ctx): string {
  const { db, generation } = connection(ctx);
  const external = db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  const local = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes;
  return `${generation}:${external}:${local}`;
}

/** JS review truthiness for canonical JSON emitted by supported task writers.
 * Only the scalar crosses into JS. The existing unarchived index permits early
 * exit, but negative/late matches still scan unarchived record JSON in SQLite.
 * Raw duplicate keys/JSON5 are not part of the canonical writer contract. */
export function hasReviewedTask(ctx: Ctx): boolean {
  const { db } = connection(ctx);
  return db.query<{ reviewed: number }, []>(`SELECT EXISTS(
    SELECT 1 FROM tasks INDEXED BY tasks_native_unarchived_id
    WHERE archived=0 AND CASE json_type(record,'$.review')
      WHEN 'true' THEN 1
      WHEN 'object' THEN 1
      WHEN 'array' THEN 1
      WHEN 'text' THEN length(CAST(json_extract(record,'$.review') AS BLOB))>0
      WHEN 'integer' THEN json_extract(record,'$.review')<>0
      WHEN 'real' THEN json_extract(record,'$.review')<>0
      ELSE 0
    END
  ) AS reviewed`).get()!.reviewed !== 0;
}

/** Service-owned extensions share the task transaction for claims and creation. */
export function taskDatabase(ctx: Ctx): Database { return connection(ctx).db; }

export function newTaskId(nowS: number): string {
  const d = new Date(nowS * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `t-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function isTaskId(id: string): boolean {
  return ID_RE.test(id);
}

export function createTask(
  ctx: Ctx, input: { title?: string; brief: Brief; kind: string | null; requestedExecutor: string | null; timeoutS: number } & Partial<Pick<TaskRecord, "interactionMode" | "conversation" | "sessionDraftId" | "requestId" | "source" | "repo" | "placement" | "baseBranch" | "baseSha" | "group" | "interactive">>,
  onCreate?: (task: TaskRecord, db: Database) => void,
): TaskRecord {
  const entry = connection(ctx), { db } = entry;
  const machineId = cachedMachineId(ctx);
  for (let i = 0; i < 65; i++) {
    const task: TaskRecord = { rev: 1, id: newTaskId(ctx.now), createdAt: ctx.now, ...input, ...(machineId ? { machineId } : {}), state: "queued", attempts: [] };
    let written: { mtime: number; signature: string } | undefined;
    const created = db.transaction(() => {
      const result = db.query(`INSERT OR IGNORE INTO tasks (${columns}) VALUES (${placeholders})`).run(...values(task, ctx.now));
      if (!result.changes) return false;
      onCreate?.(task, db);
      written = writeCompatibilityJson(ctx, task);
      db.query("UPDATE tasks SET json_mtime = ? WHERE id = ?").run(written.mtime, task.id);
      return true;
    }).immediate();
    if (created) {
      markImported(entry, task, written!.signature);
      return task;
    }
  }
  throw new Error("could not allocate a unique task id");
}

export function readTask(ctx: Ctx, id: string): TaskRecord | null {
  if (!isTaskId(id)) return null;
  const entry = connection(ctx);
  importTaskJson(ctx, entry, id);
  const row = entry.db.query<{ record: string }, [string]>("SELECT record FROM tasks WHERE id = ?").get(id);
  if (!row) return null;
  const task = JSON.parse(row.record) as TaskRecord;
  task.rev ??= 1;
  return task;
}

// Preserve the per-task cross-process operation lock and synchronous reentrancy.
const heldTaskLocks = new Set<string>();
const preparingTaskLocks = new Set<string>();
export function withTaskLock<T>(ctx: Ctx, id: string, action: () => T): T {
  assertPacerHomeAllowed(ctx.pacerHome);
  if (!isTaskId(id)) return action();
  const key = resolve(ctx.pacerHome, "tasks", id);
  if (heldTaskLocks.has(key)) return action();
  // An asynchronous preparer must be able to settle on this event loop.
  if (preparingTaskLocks.has(key)) throw new CoreError("conflict", "Task admission is being prepared; retry the change");
  // Request mutations must return promptly across isolates too. Internal/offline
  // synchronous callers retain the established bounded wait: after an external
  // effect, a busy lock is not permission to discard its completion or rollback.
  // Async completion paths use withTaskLockAsync to keep their event loop free.
  return withLockSync(ctx, `task-${id}`, () => {
    heldTaskLocks.add(key);
    try { return action(); }
    finally { heldTaskLocks.delete(key); }
  }, ctx.operation ? { timeoutMs: 0, conflict: true } : {});
}

/** Wait for the operation lock asynchronously, then perform a short synchronous
 * commit. Only that commit is reentrant; never hold the process-local marker
 * while awaiting artifact I/O. */
export function withTaskLockAsync<T>(ctx: Ctx, id: string, action: () => T): Promise<T> {
  assertPacerHomeAllowed(ctx.pacerHome);
  if (!isTaskId(id)) return Promise.resolve().then(action);
  const key = resolve(ctx.pacerHome, "tasks", id);
  // Synchronous, so the lock is released before yielding; withTaskLock takes the same lock with withLockSync.
  return withLock(ctx, `task-${id}`, () => {
    heldTaskLocks.add(key);
    try { return action(); }
    finally { heldTaskLocks.delete(key); }
  });
}

/** Own the task file lock during bounded final artifact checks, without granting
 * synchronous reentrancy until the final synchronous commit actually begins.
 * Policy calls must finish before entering this boundary. */
export function withTaskPreparation<P,T>(ctx:Ctx,id:string,prepare:()=>Promise<P>,commit:(prepared:P)=>T):Promise<T> {
  assertPacerHomeAllowed(ctx.pacerHome);
  if(!isTaskId(id)) return Promise.reject(new CoreError("invalid_input","Invalid task preparation id"));
  const key=resolve(ctx.pacerHome,"tasks",id);
  if(heldTaskLocks.has(key)) return Promise.reject(new CoreError("conflict","Cannot prepare admission inside a synchronous task commit"));
  if(commit.constructor.name==="AsyncFunction") return Promise.reject(new CoreError("invalid_input","Task admission commit must be synchronous"));
  return withLock(ctx,`task-${id}`,async()=>{
    preparingTaskLocks.add(key);
    try {
      const prepared=await prepare();
      heldTaskLocks.add(key);
      try {
        const result=commit(prepared);
        if(result!==null&&(typeof result==="object"||typeof result==="function")&&typeof (result as {then?:unknown}).then==="function") throw new CoreError("invalid_input","Task admission commit must be synchronous");
        return result;
      } finally {heldTaskLocks.delete(key);}
    } finally {preparingTaskLocks.delete(key);}
  });
}

export function updateTask(ctx: Ctx, id: string, mutate: (t: TaskRecord) => void): TaskRecord {
  return writeTask(ctx, id, mutate, false);
}

/** Bump the revision with an otherwise unchanged record, for state kept outside it (work dependencies)
 *  whose changes must still invalidate callers holding the old revision. */
export function touchTask(ctx: Ctx, id: string): TaskRecord {
  return writeTask(ctx, id, () => {}, true);
}

function writeTask(ctx: Ctx, id: string, mutate: (t: TaskRecord) => void, always: boolean): TaskRecord {
  return withTaskLock(ctx, id, () => {
    const entry = connection(ctx), { db } = entry;
    let written: { mtime: number; signature: string } | undefined;
    const updated = db.transaction(() => {
      const t = readTask(ctx, id);
      if (!t) throw new Error(`unknown task ${id}`);
      const rev = t.rev;
      const priorState = t.state;
      const before = JSON.stringify(t);
      mutate(t);
      if (TERMINAL_STATES.includes(t.state) && !TERMINAL_STATES.includes(priorState)) t.settledAt = ctx.now;
      if (!TERMINAL_STATES.includes(t.state)) delete t.settledAt;
      t.id = id;
      // An update that changes nothing writes nothing: no JSON rewrite, revision bump or row update.
      if (!always && JSON.stringify(t) === before) return t;
      t.rev = rev + 1;
      // JSON first: a crash before SQLite commits is recovered by the next import.
      written = writeCompatibilityJson(ctx, t);
      if (t.settledAt !== undefined) db.query("INSERT OR IGNORE INTO task_first_settle(task_id,at) VALUES(?,?)").run(id, t.settledAt);
      db.query(`UPDATE tasks SET rev=?, state=?, created_at=?, updated_at=?, settled_at=?, repo=?, record=?, archived=?, json_mtime=? WHERE id=?`)
        .run(...values(t, Number.isFinite(ctx.now) ? ctx.now : Date.now() / 1000).slice(1), written.mtime, id);
      return t;
    }).immediate();
    // A no-op update wrote no JSON, so there is nothing new to record.
    if (written) markImported(entry, updated, written.signature);
    return updated;
  });
}

/** Only a committed outermost write may skip the next scan's lookup; a rollback leaves the JSON to import. */
function markImported(entry: Connection, task: TaskRecord, signature: string): void {
  if (!task.archived && !entry.db.inTransaction) entry.imported.set(`${task.id}.json`, signature);
}

/** Only records that can affect executor slots or recent-failure presentation.
 * Keep the exact event-time expression shared with the snapshot index. No limit:
 * every running task and every recent failure contributes to capacity semantics.
 * Callers still apply visible state (an unanswered question is not running).
 */
export function capacityTaskRecords(ctx: Ctx): TaskRecord[] {
  return connection(ctx).db.query<{ record: string }, [number]>(`
    SELECT record FROM tasks INDEXED BY tasks_state WHERE archived=0 AND state='running'
    UNION ALL
    SELECT record FROM tasks INDEXED BY tasks_capacity_failures
      WHERE archived=0 AND state='failed' AND ${snapshotUpdatedAt} >= ?
  `).all(ctx.now - 86400).map(row => JSON.parse(row.record) as TaskRecord);
}

export interface TaskFilter {
  states?: readonly TaskState[]; updatedSince?: number; settledBefore?: number; all?: boolean; before?: string; limit?: number;
  createdSince?: number;
  /** Also select stored needs_input tasks the user still must answer (never aged out),
   *  via `awaitsAnswerSql`. Keeps `tasks_state` as the driver index. */
  awaitingAnswer?: boolean;
  visibleStates?: readonly TaskState[];
  executor?: string;
  repoKey?: string;
  legacyRepoPaths?: readonly string[];
  /** Free-text search: every space-separated word must appear, case-insensitively,
   * in the task id (including its short suffix), title or goal. Folding is ASCII-only
   * in SQL (SQLite's lower()) and per-character Unicode lowercase on decoded records;
   * a word shaped like a task-id prefix (for example the full id or a date prefix
   * `t-2026`) is matched by the id prefix range instead, and is not searched in
   * titles or goals. */
  query?: string;
}

/** Distinct legacy paths from a covering partial index, without decoding task JSON.
 * Resolve these through repoFor at request time: registry aliases can change without
 * a task write, so persisting their resolved keys would change list semantics. */
export function legacyTaskRepoPaths(ctx: Ctx): string[] {
  return connection(ctx).db.query<{ repo: string }, []>(
    `SELECT DISTINCT repo FROM tasks WHERE ${legacyRepoSql}`).all().map(row => row.repo);
}

/** Indexed predicates combined with AND, applied before the newest-first limit. */
/** ASCII-only lowercase: SQLite's lower() folds ASCII letters and leaves every
 *  other character (and every non-letter) alone, so a word folded this way is
 *  matched exactly by `instr(lower(field), …)`. */
const asciiFold = (word: string): string => word.replace(/[A-Z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 32));
/** Task ids are `t-YYYYMMDD-HHMMSS-xxxx`. A word shaped like an id prefix (a date
 *  prefix such as `t-2026`, a fuller `t-YYYYMMDD-HHMMSS-hex` prefix, or the full id,
 *  possibly still ending in `-` while being typed) can never appear inside an id:
 *  no id contains a second `t-`. Such a word is therefore matched with a
 *  primary-key range instead of a full-table `instr` scan. Titles and goals are
 *  not searched with an id-shaped word. Returns the `[start, end)` id bounds. */
function idPrefixRange(word: string): [string, string] | null {
  if (!/^t(?:-\d{1,8}(?:-\d{1,6}(?:-[0-9a-f]{1,4})?)?)?$/.test(word)) return null;
  // Successor of the last character; ids extend the prefix with 0-9, a-f or `-`,
  // all below the successor, so `[prefix, successor)` covers exactly its extensions.
  return [word, word.slice(0, -1) + String.fromCharCode(word.charCodeAt(word.length - 1) + 1)];
}
/** Per-character Unicode lowercase, the same folding both runtimes apply to a
 *  non-ASCII query word and to the decoded fields (see the Rust counterpart in
 *  crates/store/src/task_selection.rs). */
const fold = (text: string): string => [...text].map(ch => ch.toLowerCase()).join("");

export function listTasksWhere(ctx: Ctx, filter: TaskFilter = {}): TaskRecord[] {
  if (filter.states?.length === 0 || filter.visibleStates?.length === 0 || filter.limit === 0) return [];
  const recentOnly = filter.updatedSince !== undefined && !filter.all && filter.states === undefined && filter.visibleStates === undefined
    && filter.executor === undefined && filter.repoKey === undefined && filter.before === undefined
    && filter.settledBefore === undefined && filter.createdSince === undefined && filter.query === undefined;
  const clauses: string[] = [], bindings: SQLQueryBindings[] = [];
  if (!filter.all) clauses.push("archived = 0");
  if (filter.settledBefore !== undefined) { clauses.push("settled_at < ?"); bindings.push(filter.settledBefore); }
  if (filter.before !== undefined) { clauses.push("id < ?"); bindings.push(filter.before); }
  if (filter.states || filter.awaitingAnswer) {
    const stateBranches: string[] = [];
    if (filter.states) {
      stateBranches.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      bindings.push(...filter.states);
    }
    if (filter.awaitingAnswer) stateBranches.push(`(${awaitsAnswerSql})`);
    clauses.push(`(${stateBranches.join(" OR ")})`);
  }
  if (filter.visibleStates) {
    clauses.push(`(${visibleStateSql}) IN (${filter.visibleStates.map(() => "?").join(",")})`);
    bindings.push(...filter.visibleStates);
  }
  if (filter.executor !== undefined) {
    clauses.push(`(${executorSql}) = ?`);
    bindings.push(filter.executor);
  }
  if (filter.repoKey !== undefined) {
    const paths = filter.legacyRepoPaths ?? [];
    // Separate candidate seeks keep SQLite from choosing tasks_retention for an
    // OR predicate and evaluating repository JSON across unrelated history.
    clauses.push(paths.length
      ? `id IN (SELECT id FROM tasks WHERE ${repoKeySql} = ?
          UNION SELECT id FROM tasks WHERE ${legacyRepoSql} AND repo IN (SELECT value FROM json_each(?)))`
      : `${repoKeySql} = ?`);
    bindings.push(filter.repoKey);
    if (paths.length) bindings.push(JSON.stringify(paths));
  }
  if (filter.updatedSince !== undefined) { clauses.push("updated_at >= ?"); bindings.push(filter.updatedSince); }
  if (filter.createdSince !== undefined) { clauses.push("created_at >= ?"); bindings.push(filter.createdSince); }
  const unicodeWords: string[] = [];
  let idRange = false;
  if (filter.query) {
    // Every whitespace-separated word must appear somewhere in the id (which
    // covers the short suffix and any date prefix), title or goal. Kept
    // identical to the native filter in crates/store/src/task_selection.rs:
    // ASCII words are matched exactly by SQLite (lower() folds ASCII), a word
    // shaped like an id prefix by the primary-key range, and words SQLite
    // cannot fold are checked on the decoded records below with the same
    // per-character Unicode lowercase in both runtimes.
    for (const word of filter.query.trim().split(/\s+/).filter(Boolean)) {
      if (/^[\x00-\x7F]+$/.test(word)) {
        const w = asciiFold(word);
        const range = idPrefixRange(w);
        if (range) {
          idRange = true;
          clauses.push("(id >= ? AND id < ?)");
          bindings.push(range[0], range[1]);
        } else {
          clauses.push("(instr(lower(id), ?) > 0 OR instr(lower(json_extract(record, '$.title')), ?) > 0 OR instr(lower(json_extract(record, '$.brief.goal')), ?) > 0)");
          bindings.push(w, w, w);
        }
      } else {
        unicodeWords.push(fold(word));
      }
    }
  }
  /** A decoded record matches the words SQLite cannot fold. Titles and goals
   *  must be strings, like SQLite's json_extract-based check for text. */
  const matchesUnicodeWords = (task: TaskRecord): boolean => unicodeWords.every(w =>
    fold(task.id).includes(w)
    || (typeof task.title === "string" && fold(task.title).includes(w))
    || (typeof task.brief?.goal === "string" && fold(task.brief.goal).includes(w)));
  const limit = filter.limit === undefined || filter.limit === Infinity ? -1 : Math.max(0, Math.floor(filter.limit));
  /** Decode one stored record, defaulting its revision like every list path. */
  const decode = (record: string): TaskRecord => { const task = JSON.parse(record) as TaskRecord; task.rev ??= 1; return task; };
  // Raw state filters seek active states; repository aliases seek candidate IDs.
  // Neither should let archived=0 drive a scan over settled history. An id-range
  // clause is the most selective bound, so it always rides the primary key.
  const index = filter.states || filter.awaitingAnswer ? " INDEXED BY tasks_state"
    : idRange ? " INDEXED BY sqlite_autoindex_tasks_1"
    : recentOnly ? " INDEXED BY tasks_updated_at"
    : filter.repoKey !== undefined && filter.legacyRepoPaths?.length ? " INDEXED BY sqlite_autoindex_tasks_1" : "";
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const db = connection(ctx).db;
  if (!unicodeWords.length) {
    if (filter.states || filter.awaitingAnswer || recentOnly) {
      // These indexes do not deliver ID order. Sorting whole records by ID would spill
      // task JSON into a temp b-tree whose release holds SQLite's process-wide VFS
      // mutex, so order the candidate IDs here and fetch only the selected records.
      return db.transaction(() => {
        const ids = db.query<{ id: string }, SQLQueryBindings[]>(`SELECT id FROM tasks${index} ${where}`).all(...bindings)
          .map(row => row.id).sort(newestFirst);
        return recordsByIds(db, limit < 0 ? ids : ids.slice(0, limit));
      })();
    }
    const sql = `SELECT record FROM tasks${index} ${where} ORDER BY id DESC LIMIT ?`;
    const rows = db.query<{ record: string }, SQLQueryBindings[]>(sql).all(...bindings, limit);
    return rows.map(row => decode(row.record));
  }
  // Words SQLite cannot fold are checked after decoding, so pages are walked
  // newest-first with an id cursor until `limit` records match. A record that
  // fails to decode cannot match a text query and is skipped here (both
  // runtimes skip; the non-paging paths above still fail loudly).
  const walk = (rows: { id: string; record: string }[], out: TaskRecord[]): void => {
    for (const row of rows) {
      let task: TaskRecord;
      try { task = decode(row.record); } catch { continue; }
      if (matchesUnicodeWords(task)) {
        out.push(task);
        if (limit >= 0 && out.length >= limit) return;
      }
    }
  };
  const out: TaskRecord[] = [];
  if (filter.states || filter.awaitingAnswer || recentOnly) {
    // Candidate IDs are already ordered newest-first; fetch and filter in pages.
    return db.transaction(() => {
      const ids = db.query<{ id: string }, SQLQueryBindings[]>(`SELECT id FROM tasks${index} ${where}`).all(...bindings)
        .map(row => row.id).sort(newestFirst);
      for (let i = 0; i < ids.length && (limit < 0 || out.length < limit); i += 500) {
        const part = ids.slice(i, i + 500);
        walk(db.query<{ id: string; record: string }, string[]>(`SELECT id, record FROM tasks WHERE id IN (${part.map(() => "?").join(",")})`).all(...part), out);
      }
      return out;
    })();
  }
  let cursor: string | undefined = filter.before;
  while (limit < 0 || out.length < limit) {
    const condition = cursor !== undefined ? (where ? `${where} AND id < ?` : "WHERE id < ?") : where;
    // The walk always rides the primary key: it delivers id order without a
    // temp b-tree, and each page continues from the previous one's cursor.
    const rows = db.query<{ id: string; record: string }, SQLQueryBindings[]>(
      `SELECT id, record FROM tasks INDEXED BY sqlite_autoindex_tasks_1 ${condition} ORDER BY id DESC LIMIT 500`)
      .all(...bindings, ...(cursor !== undefined ? [cursor] : []));
    if (!rows.length) break;
    cursor = rows.at(-1)!.id;
    walk(rows, out);
  }
  return out;
}

const newestFirst = (a: string, b: string) => a < b ? 1 : a > b ? -1 : 0;

/** Unarchived task IDs in the given raw states, newest first, without decoding records. */
export function taskIdsInStates(ctx: Ctx, states: readonly string[]): string[] {
  if (!states.length) return [];
  return connection(ctx).db.query<{ id: string }, string[]>(
    `SELECT id FROM tasks INDEXED BY tasks_state WHERE archived = 0 AND state IN (${states.map(() => "?").join(",")})`,
  ).all(...states).map(row => row.id).sort(newestFirst);
}

/** Newest first, in batches below SQLite's bound-parameter limit. Callers that need one
 *  snapshot across batches run it inside a transaction. */
function recordsByIds(db: Database, ids: string[]): TaskRecord[] {
  const records: TaskRecord[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = db.query<{ record: string }, string[]>(`SELECT record FROM tasks WHERE id IN (${part.map(() => "?").join(",")})`).all(...part);
    for (const row of rows) { const task = JSON.parse(row.record) as TaskRecord; task.rev ??= 1; records.push(task); }
  }
  return records.sort((a, b) => newestFirst(a.id, b.id));
}

/** Reconcile cursors read IDs only; the caller decodes each selected page once. */
export function taskIdPage(ctx: Ctx, before?: string, limit = 200): string[] {
  const db = connection(ctx).db;
  const rows = before === undefined
    ? db.query<{ id: string }, [number]>("SELECT id FROM tasks INDEXED BY tasks_native_unarchived_id WHERE archived=0 ORDER BY id DESC LIMIT ?").all(limit)
    : db.query<{ id: string }, [string, number]>("SELECT id FROM tasks INDEXED BY tasks_native_unarchived_id WHERE archived=0 AND id<? ORDER BY id DESC LIMIT ?").all(before, limit);
  return rows.map(row => row.id);
}

/** IDs for the bounded recent snapshot window. Match taskData's updatedAt without decoding
 * records in JS; active tasks outside this window arrive through the pump selection. */
export function snapshotTaskIds(ctx: Ctx): string[] {
  return connection(ctx).db.query<{ id: string }, [number]>(`
    SELECT id FROM tasks INDEXED BY tasks_snapshot_window WHERE archived=0
      AND COALESCE(json_extract(record,'$.dismissed'),0)=0 AND ${snapshotUpdatedAt}>=?
    ORDER BY ${snapshotUpdatedAt} DESC, id DESC LIMIT 200
  `).all(ctx.now - 86400).map(row => row.id);
}

/** Tasks whose backend still records a live worker (`TaskRecord.live`), newest first. */
export function listLiveTasks(ctx: Ctx): TaskRecord[] {
  const rows = connection(ctx).db.query<{ record: string }, []>("SELECT record FROM tasks WHERE json_extract(record, '$.live') IS NOT NULL ORDER BY id DESC").all();
  return rows.map(row => { const task = JSON.parse(row.record) as TaskRecord; task.rev ??= 1; return task; });
}

/** Newest first. */
export function listTasks(ctx: Ctx, limit = 20): TaskRecord[] {
  return listTasksWhere(ctx, { limit });
}

/** Selected records for the pump's change/active set: an indexed fetch that decodes
 *  only the named rows instead of every task, newest id first (same order as listTasksWhere). */
export function readTasksByIds(ctx: Ctx, ids: Iterable<string>): TaskRecord[] {
  const list = [...new Set(ids)].filter(isTaskId);
  if (!list.length) return [];
  const db = connection(ctx).db;
  return list.length > 500 ? db.transaction(() => recordsByIds(db, list))() : recordsByIds(db, list);
}

/** Union of indexed active and recent selections for read-model consumers. Tasks
 *  that still require the user must never age out: a stored `needs_input` that
 *  still awaits an answer (and running tasks with an open unanswered question via
 *  the running branch of `visibleStateSql`) stays in the active set at any age.
 *  Answered, retried or dismissed needs_input tasks do not. The selection uses
 *  `tasks_state`, so the extra awaiting-answer branch adds a bounded indexed
 *  seek even at 50k rows. */
export function listActiveAndRecentTasks(ctx: Ctx, updatedSince = ctx.now - 86400): TaskRecord[] {
  const selected = new Map(listTasksWhere(ctx, { updatedSince }).map(t => [t.id, t]));
  for (const task of listTasksWhere(ctx, { states: ["queued", "running"], awaitingAnswer: true })) selected.set(task.id, task);
  return [...selected.values()].sort((a, b) => b.id.localeCompare(a.id));
}
