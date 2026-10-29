import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { observationSchema, type Observation } from "./types";

/**
 * A read-only view of the task store for `dispatch.explain`. Unlike `taskDatabase`, opening it
 * creates no file, runs no DDL, sets no journal mode and imports no legacy JSON. A missing
 * store, or a store without a table, reads as empty and says so through `available`.
 */
export interface ReadOnlyStore {
  available: boolean;
  has(table: string): boolean;
  query<T>(sql: string, ...bindings: (string | number)[]): T[];
  close(): void;
}
export function openReadOnlyStore(ctx: Ctx): ReadOnlyStore {
  const path = resolve(ctx.pacerHome, "state", "tasks.db");
  let db = null as Database | null;
  const open = (target: string, options: ConstructorParameters<typeof Database>[1]) => { const d = new Database(target, options); d.run("PRAGMA query_only = ON"); return d; };
  try {
    if (existsSync(path)) {
      try { db = open(path, { readonly: true, strict: true }); }
      catch (error) {
        // A cleanly closed WAL database has no -wal/-shm files, which a read-only handle cannot create.
        // With no WAL content to miss, an immutable handle reads it safely.
        const wal = `${path}-wal`;
        if (existsSync(wal) && statSync(wal).size > 0) throw error;
        db = open(`file:${path}?mode=ro&immutable=1`, { readonly: true, strict: true });
      }
    }
  } catch { db?.close(); db = null; }
  const tables = new Set<string>();
  if (db) try { for (const r of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all()) tables.add(r.name); } catch { /* unreadable store reads as empty */ }
  return {
    available: db !== null && tables.has("tasks"),
    has: t => tables.has(t),
    query: <T>(sql: string, ...b: (string | number)[]) => { try { return db ? db.query<T, (string | number)[]>(sql).all(...b) : []; } catch { return []; } },
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
