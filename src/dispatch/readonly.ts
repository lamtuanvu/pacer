import { CoreError } from "../core/errors";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { observationSchema, type Observation } from "./types";

/**
 * A read-only view of the task store for `dispatch.explain`. Unlike `taskDatabase`, opening it
 * creates no file, runs no DDL, sets no journal mode and imports no legacy JSON. A missing
 * store, or a store without a table, reads as empty and says so through `available`.
 *
 * A WAL-mode store needs `-wal` and `-shm` to be read normally: SQLite creates them when
 * `state/` is writable, and the first read fails when it is not (or always, with the system
 * SQLite on macOS). A WAL-mode store whose WAL is absent or empty has nothing to miss, so when
 * either file is absent it is opened `immutable`. Otherwise the plain open and its first read
 * run first, and a WAL-mode store with an empty WAL falls back to `immutable` if either fails.
 * The one file SQLite may still create is `-shm` beside a WAL with content whose index was
 * removed. Mirrored by `pacer_store::read_only`.
 */
export interface ReadOnlyStore {
  readonly available: boolean;
  /** True only for the `immutable` snapshot, which cannot observe a later WAL. */
  immutable: boolean;
  refresh(): void;
  has(table: string): boolean;
  query<T>(sql: string, ...bindings: (string | number)[]): T[];
  close(): void;
}
class ReadFailure extends Error {}
const readTables = (db: Database) => new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
/** The header says WAL mode (read version 2). */
function walMode(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(20);
    return readSync(fd, header, 0, 20, 0) === 20 && header.toString("latin1", 0, 16) === "SQLite format 3\0" && header[19] === 2;
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}
/** Opens and reads the table list. A failed first read closes the handle and throws `ReadFailure`. */
function attempt(target: string, immutable: boolean): { db: Database; tables: Set<string>; immutable: boolean } {
  const db = new Database(target, { readonly: true, strict: true });
  try { db.run("PRAGMA query_only = ON"); } catch (error) { db.close(); throw error; }
  try { return { db, tables: readTables(db), immutable }; } catch (error) { db.close(); throw new ReadFailure(String(error)); }
}
function connect(path: string) {
  const size = (suffix: string) => { try { return statSync(path + suffix).size; } catch { return undefined; } };
  const wal = size("-wal");
  const emptyWal = walMode(path) && !wal;
  const immutable = () => attempt(`file:${path.replace(/[%?#]/g, encodeURIComponent)}?mode=ro&immutable=1`, true);
  if (emptyWal && (wal === undefined || size("-shm") === undefined)) return immutable();
  try { return attempt(path, false); }
  catch (error) { if (!emptyWal) throw error; return immutable(); }
}
export function openReadOnlyStore(ctx: Ctx, strict = false): ReadOnlyStore {
  const path = resolve(ctx.pacerHome, "state", "tasks.db");
  let db = null as Database | null;
  let immutable = false;
  let tables = new Set<string>();
  if (existsSync(path)) {
    try { ({ db, tables, immutable } = connect(path)); }
    catch (error) {
      if (strict) throw new CoreError("conflict", error instanceof ReadFailure ? "Session reservations are unreadable" : "Session reservations are unavailable; retry before changing workspaces");
      /* previews read empty */
    }
  }
  return {
    get available() { return db !== null && tables.has("tasks"); },
    immutable,
    refresh: () => {
      if (!db) return;
      try { tables = readTables(db); }
      catch { tables = new Set(); if (strict) throw new CoreError("conflict", "Session reservations are unreadable"); }
    },
    has: t => tables.has(t),
    query: <T>(sql: string, ...b: (string | number)[]) => { try { return db ? db.query<T, (string | number)[]>(sql).all(...b) : []; } catch { if(strict)throw new CoreError("conflict","Session reservations could not be read"); return []; } },
    close: () => db?.close(),
  };
}
export function runningTasksReadOnly(store: ReadOnlyStore): TaskRecord[] {
  if (!store.has("tasks")) return [];
  return store.query<{ record: string }>("SELECT record FROM tasks WHERE state='running' ORDER BY id DESC").flatMap(r => { try { return [JSON.parse(r.record) as TaskRecord]; } catch { return []; } });
}
/** Tasks that may hold an executor slot (see `holdsSlot`): running, or waiting on a question with a live worker. */
export function slotTasksReadOnly(store: ReadOnlyStore): TaskRecord[] {
  if (!store.has("tasks")) return [];
  return store.query<{ record: string }>("SELECT record FROM tasks WHERE state IN ('running','needs_input') ORDER BY id DESC").flatMap(r => { try { return [JSON.parse(r.record) as TaskRecord]; } catch { return []; } });
}
export function storedObservationsReadOnly(store: ReadOnlyStore, now: number): Observation[] {
  if (!store.has("work_observations")) return [];
  return store.query<{ data: string }>("SELECT data FROM work_observations ORDER BY at DESC LIMIT 2048").flatMap(row => {
    try { const parsed = observationSchema.safeParse(JSON.parse(row.data)); return parsed.success && parsed.data.expiresAt > now ? [parsed.data] : []; } catch { return []; }
  });
}
export function reservationsReadOnly(store: ReadOnlyStore): { poolIds: string[]; estimate: number }[] {
  if (!store.has("work_reservations")) return [];
  return store.query<{ pools: string; estimate: number }>("SELECT pools,estimate FROM work_reservations").flatMap(r => { try { return [{ poolIds: JSON.parse(r.pools) as string[], estimate: r.estimate }]; } catch { return []; } });
}
