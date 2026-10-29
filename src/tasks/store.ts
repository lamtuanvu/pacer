import { Database, type SQLQueryBindings } from "bun:sqlite";
import { withLock, withLockSync } from "../core/lock";
import { assertPacerHomeAllowed } from "../ctx";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "../types";
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
interface Connection { db: Database; generation: number; inode: number; directoryStamp?: string }
const connections = new Map<string, Connection>();
let generation = 0;
const columns = "id, rev, state, created_at, updated_at, settled_at, repo, record, archived";
const placeholders = "?, ?, ?, ?, ?, ?, ?, ?, ?";

function activityAt(task: TaskRecord): number {
  return Math.max(task.createdAt, task.attemptStartedAt ?? 0, task.review?.at ?? 0, task.reviewRequest?.at ?? 0,
    ...task.attempts.map(a => a.startedAt ?? 0),
    ...task.attempts.map(a => a.endedAt ?? 0));
}
function values(task: TaskRecord, now: number): SQLQueryBindings[] {
  const updated = Math.max(now, activityAt(task));
  return [task.id, task.rev, task.state, task.createdAt, updated,
    TERMINAL_STATES.includes(task.state) && Number.isFinite(taskSettledAt(task)) ? taskSettledAt(task) : null,
    task.brief.repo ?? null, JSON.stringify(task), task.archived ? 1 : 0];
}

// Older binaries use atomic temp-file + rename writes. Only a directory change
// triggers enumeration/stat, and only changed JSON files are read. Never alter
// imported files: JSON remains the compatibility/rollback copy for this release.
function importJson(ctx: Ctx, entry: Connection): void {
  const { db } = entry;
  if (db.inTransaction) return;
  const dir = tasksDir(ctx);
  const stat = statSync(dir, { bigint: true });
  const stamp = `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (entry.directoryStamp === stamp) return;
  db.transaction(() => {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || !isTaskId(name.slice(0, -5))) continue;
      const file = join(dir, name);
      let task: TaskRecord, mtime: number;
      try {
        mtime = statSync(file).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const row = db.query<{ rev: number; json_mtime: number | null }, [string]>(
        "SELECT rev, json_mtime FROM tasks WHERE id = ?").get(name.slice(0, -5));
      if (row?.json_mtime === mtime) continue;
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
        continue;
      }
      // A restored older revision must not overwrite a newer DB revision.
      // Database failures propagate: they must not masquerade as corrupt JSON.
      db.query(`INSERT INTO tasks (${columns}, json_mtime) VALUES (${placeholders}, ?)
        ON CONFLICT(id) DO UPDATE SET rev=excluded.rev, state=excluded.state,
        created_at=excluded.created_at, updated_at=excluded.updated_at,
        settled_at=excluded.settled_at, repo=excluded.repo, record=excluded.record, archived=excluded.archived,
        json_mtime=excluded.json_mtime
        WHERE excluded.rev > tasks.rev OR (excluded.rev = tasks.rev AND
          (tasks.json_mtime IS NULL OR excluded.json_mtime > tasks.json_mtime))`)
        .run(...values(task, activityAt(task)), mtime);
      if (task.settledAt !== undefined) db.query("INSERT OR IGNORE INTO task_first_settle(task_id,at) VALUES(?,?)").run(task.id, task.settledAt);
    }
  }).immediate();
  // Keep the pre-scan stamp: an atomic write during the scan is seen next time.
  entry.directoryStamp = stamp;
}

function writeCompatibilityJson(ctx: Ctx, task: TaskRecord): number {
  const file = join(task.archived ? taskArchiveDir(ctx, task) : tasksDir(ctx), `${task.id}.json`);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(task), { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return statSync(file).mtimeMs;
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
      importJson(ctx, cached);
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
    db.transaction(() => {
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
      // settledAt is overwritten when a task settles again; Insights counts a task once, at its first settle.
      db.run("CREATE TABLE IF NOT EXISTS task_first_settle(task_id TEXT PRIMARY KEY, at REAL NOT NULL)");
    }).immediate();
  } catch (error) { db.close(); throw error; }
  for (const [key, entry] of connections) {
    if (connections.size < 32) break;
    if (!entry.db.inTransaction) { entry.db.close(); connections.delete(key); }
  }
  const entry: Connection = { db, generation: ++generation, inode: statSync(path).ino };
  try { importJson(ctx, entry); } catch (error) { db.close(); throw error; }
  connections.set(path, entry);
  return entry;
}

/** Detect both other-process commits and writes on our own cached connection. */
export function taskStoreVersion(ctx: Ctx): string {
  const { db, generation } = connection(ctx);
  const external = db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
  const local = db.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes;
  return `${generation}:${external}:${local}`;
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
  ctx: Ctx, input: { title?: string; brief: Brief; kind: string | null; requestedExecutor: string | null; timeoutS: number } & Partial<Pick<TaskRecord, "interactionMode" | "conversation" | "sessionDraftId" | "requestId" | "source" | "repo" | "placement" | "baseBranch" | "baseSha" | "group">>,
  onCreate?: (task: TaskRecord, db: Database) => void,
): TaskRecord {
  const { db } = connection(ctx);
  for (let i = 0; i < 65; i++) {
    const task: TaskRecord = { rev: 1, id: newTaskId(ctx.now), createdAt: ctx.now, ...input, state: "queued", attempts: [] };
    const created = db.transaction(() => {
      const result = db.query(`INSERT OR IGNORE INTO tasks (${columns}) VALUES (${placeholders})`).run(...values(task, ctx.now));
      if (!result.changes) return false;
      onCreate?.(task, db);
      const mtime = writeCompatibilityJson(ctx, task);
      db.query("UPDATE tasks SET json_mtime = ? WHERE id = ?").run(mtime, task.id);
      return true;
    }).immediate();
    if (created) return task;
  }
  throw new Error("could not allocate a unique task id");
}

export function readTask(ctx: Ctx, id: string): TaskRecord | null {
  if (!isTaskId(id)) return null;
  const row = connection(ctx).db.query<{ record: string }, [string]>("SELECT record FROM tasks WHERE id = ?").get(id);
  if (!row) return null;
  const task = JSON.parse(row.record) as TaskRecord;
  task.rev ??= 1;
  return task;
}

// Preserve the per-task cross-process operation lock and synchronous reentrancy.
const heldTaskLocks = new Set<string>();
export function withTaskLock<T>(ctx: Ctx, id: string, action: () => T): T {
  assertPacerHomeAllowed(ctx.pacerHome);
  if (!isTaskId(id)) return action();
  const key = resolve(ctx.pacerHome, "tasks", id);
  if (heldTaskLocks.has(key)) return action();
  return withLockSync(ctx, `task-${id}`, () => {
    heldTaskLocks.add(key);
    try { return action(); }
    finally { heldTaskLocks.delete(key); }
  });
}

/** Wait for the operation lock asynchronously, then perform a short synchronous
 * commit. Only that commit is reentrant; never hold the process-local marker
 * while awaiting artifact I/O. */
export function withTaskLockAsync<T>(ctx: Ctx, id: string, action: () => T): Promise<T> {
  assertPacerHomeAllowed(ctx.pacerHome);
  if (!isTaskId(id)) return Promise.resolve().then(action);
  const key = resolve(ctx.pacerHome, "tasks", id);
  return withLock(ctx, `task-${id}`, async () => {
    heldTaskLocks.add(key);
    try { return action(); }
    finally { heldTaskLocks.delete(key); }
  });
}

export function updateTask(ctx: Ctx, id: string, mutate: (t: TaskRecord) => void): TaskRecord {
  return withTaskLock(ctx, id, () => {
    const { db } = connection(ctx);
    return db.transaction(() => {
      const t = readTask(ctx, id);
      if (!t) throw new Error(`unknown task ${id}`);
      const rev = t.rev;
      const priorState = t.state;
      mutate(t);
      if (TERMINAL_STATES.includes(t.state) && !TERMINAL_STATES.includes(priorState)) t.settledAt = ctx.now;
      if (!TERMINAL_STATES.includes(t.state)) delete t.settledAt;
      t.id = id;
      t.rev = rev + 1;
      // JSON first: a crash before SQLite commits is recovered by the next import.
      const mtime = writeCompatibilityJson(ctx, t);
      if (t.settledAt !== undefined) db.query("INSERT OR IGNORE INTO task_first_settle(task_id,at) VALUES(?,?)").run(id, t.settledAt);
      db.query(`UPDATE tasks SET rev=?, state=?, created_at=?, updated_at=?, settled_at=?, repo=?, record=?, archived=?, json_mtime=? WHERE id=?`)
        .run(...values(t, Number.isFinite(ctx.now) ? ctx.now : Date.now() / 1000).slice(1), mtime, id);
      return t;
    }).immediate();
  });
}

export interface TaskFilter { states?: readonly TaskState[]; updatedSince?: number; settledBefore?: number; all?: boolean; before?: string; limit?: number }

/** Indexed filters, combined with AND. Newest id first, matching the file store. */
export function listTasksWhere(ctx: Ctx, filter: TaskFilter = {}): TaskRecord[] {
  if (filter.states?.length === 0 || filter.limit === 0) return [];
  const clauses: string[] = [], bindings: SQLQueryBindings[] = [];
  if (!filter.all) clauses.push("archived = 0");
  if (filter.settledBefore !== undefined) { clauses.push("settled_at < ?"); bindings.push(filter.settledBefore); }
  if (filter.before !== undefined) { clauses.push("id < ?"); bindings.push(filter.before); }
  if (filter.states) {
    clauses.push(`state IN (${filter.states.map(() => "?").join(",")})`);
    bindings.push(...filter.states);
  }
  if (filter.updatedSince !== undefined) { clauses.push("updated_at >= ?"); bindings.push(filter.updatedSince); }
  const limit = filter.limit === undefined || filter.limit === Infinity ? -1 : Math.max(0, Math.floor(filter.limit));
  const sql = `SELECT record FROM tasks ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  const rows = connection(ctx).db.query<{ record: string }, SQLQueryBindings[]>(sql).all(...bindings, limit);
  return rows.map(row => { const task = JSON.parse(row.record) as TaskRecord; task.rev ??= 1; return task; });
}

/** Newest first. */
export function listTasks(ctx: Ctx, limit = 20): TaskRecord[] {
  return listTasksWhere(ctx, { limit });
}

/** Union of indexed active and recent selections for read-model consumers. */
export function listActiveAndRecentTasks(ctx: Ctx, updatedSince = ctx.now - 86400): TaskRecord[] {
  const selected = new Map(listTasksWhere(ctx, { updatedSince }).map(t => [t.id, t]));
  for (const task of listTasksWhere(ctx, { states: ["queued", "running"] })) selected.set(task.id, task);
  return [...selected.values()].sort((a, b) => b.id.localeCompare(a.id));
}
