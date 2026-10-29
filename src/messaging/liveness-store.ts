import type { Database } from "bun:sqlite";
import type { Ctx } from "../types";
import { messagesDatabase } from "./store";

/** Broker state for one participant: its current stall, backoff and the Stop-hook block count. */
export interface LivenessRow {
  node: string; reason: string; since: number; attempts: number; nextAt: number; progressMark: string | null;
  stalledAt: number | null; escalatedAt: number | null; hookSet: string | null; hookBlocks: number;
}
export type LivenessUpsert = Omit<LivenessRow, "hookSet" | "hookBlocks">;

interface Row { node: string; reason: string; since: number; attempts: number; next_at: number; progress_mark: string | null;
  stalled_at: number | null; escalated_at: number | null; hook_set: string | null; hook_blocks: number }

const ready = new WeakSet<Database>();
function db(ctx: Ctx): Database {
  const d = messagesDatabase(ctx);
  if (ready.has(d)) return d;
  d.exec(`CREATE TABLE IF NOT EXISTS msg_liveness(
    node TEXT PRIMARY KEY, reason TEXT NOT NULL, since REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL,
    progress_mark TEXT NULL, stalled_at REAL NULL, escalated_at REAL NULL, hook_set TEXT NULL, hook_blocks INTEGER NOT NULL DEFAULT 0);`);
  ready.add(d);
  return d;
}

const toRow = (r: Row): LivenessRow => ({ node: r.node, reason: r.reason, since: r.since, attempts: r.attempts, nextAt: r.next_at, progressMark: r.progress_mark,
  stalledAt: r.stalled_at, escalatedAt: r.escalated_at, hookSet: r.hook_set, hookBlocks: r.hook_blocks });

export function getLiveness(ctx: Ctx, node: string): LivenessRow | null {
  const r = db(ctx).query<Row, [string]>("SELECT * FROM msg_liveness WHERE node=?").get(node);
  return r ? toRow(r) : null;
}

/** Writes the stall fields; the Stop-hook counters are kept. */
export function upsertLiveness(ctx: Ctx, row: LivenessUpsert): void {
  db(ctx).query(`INSERT INTO msg_liveness(node,reason,since,attempts,next_at,progress_mark,stalled_at,escalated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(node) DO UPDATE SET reason=excluded.reason, since=excluded.since, attempts=excluded.attempts, next_at=excluded.next_at,
    progress_mark=excluded.progress_mark, stalled_at=excluded.stalled_at, escalated_at=excluded.escalated_at`)
    .run(row.node, row.reason, row.since, row.attempts, row.nextAt, row.progressMark, row.stalledAt, row.escalatedAt);
}

export function clearLiveness(ctx: Ctx, node: string): void {
  db(ctx).query("DELETE FROM msg_liveness WHERE node=?").run(node);
}

export function listLiveness(ctx: Ctx): LivenessRow[] {
  return db(ctx).query<Row, []>("SELECT * FROM msg_liveness ORDER BY node").all().map(toRow);
}

/**
 * Counts Stop-hook blocks on the same set of pending messages; a new set starts again at 1.
 * A node with no stall row gets one with an empty reason, which the broker treats as no stall.
 */
export function recordHookBlock(ctx: Ctx, node: string, set: string): number {
  const d = db(ctx);
  return d.transaction(() => {
    d.query(`INSERT INTO msg_liveness(node,reason,since,next_at,hook_set,hook_blocks) VALUES(?,'',?,?,?,1)
      ON CONFLICT(node) DO UPDATE SET hook_blocks=CASE WHEN hook_set IS excluded.hook_set THEN hook_blocks+1 ELSE 1 END, hook_set=excluded.hook_set`)
      .run(node, ctx.now, ctx.now, set);
    return d.query<{ n: number }, [string]>("SELECT hook_blocks AS n FROM msg_liveness WHERE node=?").get(node)!.n;
  }).immediate();
}

/** Resets the Stop-hook block count once nothing is pending. */
export function clearHookBlocks(ctx: Ctx, node: string): void {
  db(ctx).query("UPDATE msg_liveness SET hook_set=NULL, hook_blocks=0 WHERE node=?").run(node);
}
