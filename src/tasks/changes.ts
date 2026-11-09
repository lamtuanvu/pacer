import type { Ctx } from "../types";
import { taskDatabase } from "./store";
import type { TaskState } from "./types";

/** One row of the shared `task_changes` log (`src/tasks/store.ts`), filled by
 *  SQLite triggers on `tasks` so every writer, in either runtime and any
 *  binary version, is recorded once without re-diffing the whole table. */
export interface TaskChange { seq: number; taskId: string; rev: number; state: TaskState; at: number }

/** The newest `seq` in the log, or 0 when it is empty. A fresh reader should
 *  start its cursor here instead of replaying history it never needs. */
export function taskChangesHead(ctx: Ctx): number {
  const row = taskDatabase(ctx).query<{ head: number | null }, []>("SELECT MAX(seq) AS head FROM task_changes").get();
  return row?.head ?? 0;
}

/** Changes after `cursor`, oldest first, up to `limit`. `gap` is true when
 *  `cursor` is older than the retained window (pruned past) or ahead of the
 *  log (a restored or reset database rewound `seq`); the caller must then run
 *  a full reconcile instead of trusting an empty `changes` array to mean
 *  "nothing changed". */
export function taskChangesSince(ctx: Ctx, cursor: number, limit = 500): { changes: TaskChange[]; head: number; gap: boolean } {
  const db = taskDatabase(ctx);
  const head = taskChangesHead(ctx);
  if (cursor > head) return { changes: [], head, gap: true };
  if (head === 0) return { changes: [], head, gap: false };
  const oldest = db.query<{ min: number }, []>("SELECT MIN(seq) AS min FROM task_changes").get()!.min;
  if (cursor < oldest - 1) return { changes: [], head, gap: true };
  const rows = db.query<{ seq: number; task_id: string; rev: number; state: TaskState; at: number }, [number, number]>(
    "SELECT seq, task_id, rev, state, at FROM task_changes WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(cursor, limit);
  return { changes: rows.map(row => ({ seq: row.seq, taskId: row.task_id, rev: row.rev, state: row.state, at: row.at })), head, gap: false };
}

/** Bound the log to a window so it never grows forever. Deletes rows older
 *  than `keepDays` or beyond the newest `keepRows` rows (either bound applies);
 *  called from the maintenance child's daily run (`src/tasks/history.ts`). */
export function pruneTaskChanges(ctx: Ctx, opts: { keepDays?: number; keepRows?: number } = {}): number {
  const db = taskDatabase(ctx);
  const keepDays = opts.keepDays ?? 7;
  const keepRows = opts.keepRows ?? 100_000;
  const cutoffAt = ctx.now - keepDays * 86400;
  const boundary = db.query<{ seq: number }, [number]>(
    "SELECT seq FROM task_changes ORDER BY seq DESC LIMIT 1 OFFSET ?").get(Math.max(0, keepRows - 1));
  const result = boundary
    ? db.query("DELETE FROM task_changes WHERE at < ? OR seq < ?").run(cutoffAt, boundary.seq)
    : db.query("DELETE FROM task_changes WHERE at < ?").run(cutoffAt);
  return result.changes;
}
