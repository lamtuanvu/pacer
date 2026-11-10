// The pump's durable ledgers and change-log cursor (spec §3). They live in
// state/tasks.db beside the tasks table so a tick reads and writes only the rows
// for the tasks it touches, instead of rewriting whole JSON files whose size grows
// with task history. The legacy `link/task-data-seen.json`, `task-states.json` and
// `task-events-at.json` ledgers are imported once and left in place, and until
// older binaries stop reading them they are also re-kept in sync (see
// `writeLegacyLedgers`) so a rollback or observability tool never re-alerts
// settled tasks.
import type { Ctx } from "../types";
import { isTaskId, listLiveTasks, listTasksWhere, taskDatabase } from "../tasks/store";
import { activeAgentSessions } from "../session/agents-state";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { TaskData } from "./envelope";
import { join } from "node:path";

/** One task's published-diff state: the last published task data, its visible
 *  state (the old `task-states.json` value) and when an event was last emitted. */
export interface LedgerRow { id: string; data?: TaskData; state?: string; eventAt?: number }

export interface PumpLedgerApi {
  /** One-time import of the legacy JSON ledgers, only while the tables are empty. */
  importLegacyLedgers(ctx: Ctx): void;
  /** True while both ledger tables have no rows (a pump that never ran here). */
  isEmpty(ctx: Ctx): boolean;
  readLedger(ctx: Ctx, ids: string[]): Map<string, LedgerRow>;
  writeLedger(ctx: Ctx, rows: Iterable<LedgerRow>): void;
  /** The change-log cursor, or null before the first cursor write. */
  readCursor(ctx: Ctx): number | null;
  writeCursor(ctx: Ctx, seq: number): void;
  /** When the last full reconcile finished, or null before the first one. */
  readReconcileAt(ctx: Ctx): number | null;
  writeReconcileAt(ctx: Ctx, at: number): void;
  /** Active-set membership (spec §3): SQL reads bounded by open work, not history. */
  nonTerminalTaskIds(ctx: Ctx): string[];
  liveTaskIds(ctx: Ctx): string[];
  /** Tasks with a session-registry entry: live agent_sessions rows plus what the
   *  pump observed with a live session or live orca terminal (pump_session). */
  registryTaskIds(ctx: Ctx): string[];
  writeSessions(ctx: Ctx, keep: string[], drop: string[]): void;
  /** Rollback bridge: the legacy `link/*.json` ledgers keep mirroring the tables
   *  until older binaries stop reading them, so a rollback never re-alerts
   *  settled tasks. Written on reconciles and settle ticks, not every tick. */
  writeLegacyLedgers(ctx: Ctx): void;
}

const chunked = <T,>(values: T[], size = 400): T[][] => {
  const parts: T[][] = [];
  for (let i = 0; i < values.length; i += size) parts.push(values.slice(i, i + size));
  return parts.length ? parts : [[]];
};

export function readLedger(ctx: Ctx, ids: string[]): Map<string, LedgerRow> {
  const out = new Map<string, LedgerRow>();
  const db = taskDatabase(ctx);
  for (const part of chunked(ids)) {
    const marks = part.map(() => "?").join(",");
    for (const row of db.query<{ task_id: string; data: string }, string[]>(`SELECT task_id, data FROM pump_seen WHERE task_id IN (${marks})`).all(...part)) {
      out.set(row.task_id, { ...out.get(row.task_id), id: row.task_id, data: JSON.parse(row.data) as TaskData });
    }
    for (const row of db.query<{ task_id: string; state: string; event_at: number | null }, string[]>(`SELECT task_id, state, event_at FROM pump_state WHERE task_id IN (${marks})`).all(...part)) {
      out.set(row.task_id, { ...out.get(row.task_id), id: row.task_id, state: row.state, eventAt: row.event_at ?? undefined });
    }
  }
  return out;
}

export function writeLedger(ctx: Ctx, rows: Iterable<LedgerRow>): void {
  const db = taskDatabase(ctx);
  db.transaction(() => {
    for (const row of rows) {
      if (row.data !== undefined) db.query("INSERT OR REPLACE INTO pump_seen(task_id,data) VALUES(?,?)").run(row.id, JSON.stringify(row.data));
      if (row.state !== undefined) db.query("INSERT INTO pump_state(task_id,state,event_at) VALUES(?,?,COALESCE(?,(SELECT event_at FROM pump_state WHERE task_id=?))) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,event_at=excluded.event_at").run(row.id, row.state, row.eventAt ?? null, row.id);
      else if (row.eventAt !== undefined) db.query("UPDATE pump_state SET event_at=? WHERE task_id=?").run(row.eventAt, row.id);
    }
  }).immediate();
}

export function readCursor(ctx: Ctx): number | null {
  const row = taskDatabase(ctx).query<{ seq: number }, []>("SELECT seq FROM pump_cursor WHERE id=1").get();
  return row ? row.seq : null;
}

export function writeCursor(ctx: Ctx, seq: number): void {
  taskDatabase(ctx).query("INSERT INTO pump_cursor(id,seq) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq").run(seq);
}

export function readReconcileAt(ctx: Ctx): number | null {
  const row = taskDatabase(ctx).query<{ at: number }, []>("SELECT at FROM pump_reconcile WHERE id=1").get();
  return row ? row.at : null;
}

export function writeReconcileAt(ctx: Ctx, at: number): void {
  taskDatabase(ctx).query("INSERT INTO pump_reconcile(id,at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at").run(at);
}

export function isEmpty(ctx: Ctx): boolean {
  const row = taskDatabase(ctx).query<{ quiet: number }, []>(
    "SELECT CASE WHEN EXISTS(SELECT 1 FROM pump_seen) OR EXISTS(SELECT 1 FROM pump_state) THEN 0 ELSE 1 END AS quiet").get();
  return !!row?.quiet;
}

export function importLegacyLedgers(ctx: Ctx): void {
  if (!isEmpty(ctx)) return;
  const dataPath = join(ctx.pacerHome, "link", "task-data-seen.json");
  const statesPath = join(ctx.pacerHome, "link", "task-states.json");
  const timesPath = join(ctx.pacerHome, "link", "task-events-at.json");
  const data = readJson<Record<string, TaskData>>(dataPath);
  const states = readJson<Record<string, string>>(statesPath);
  const times = readJson<Record<string, number>>(timesPath);
  if (!data && !states) return; // nothing to import; the JSON ledgers stay in place either way
  const db = taskDatabase(ctx);
  const ids = new Set([...Object.keys(data ?? {}), ...Object.keys(states ?? {})].filter(isTaskId));
  db.transaction(() => {
    for (const id of ids) {
      if (data?.[id] !== undefined) db.query("INSERT OR REPLACE INTO pump_seen(task_id,data) VALUES(?,?)").run(id, JSON.stringify(data[id]));
      if (states?.[id] !== undefined) db.query("INSERT INTO pump_state(task_id,state,event_at) VALUES(?,?,?)").run(id, states[id], times?.[id] ?? null);
    }
  }).immediate();
}

/** Non-terminal tasks (queued, running, and the visible needs_input follow-ups kept out of
 *  TERMINAL_STATES by callers) — bounded by open work. */
export function nonTerminalTaskIds(ctx: Ctx): string[] {
  return listTasksWhere(ctx, { states: ["queued", "running"] }).map(t => t.id);
}

/** Tasks whose backend still records a live worker (TaskRecord.live). */
export function liveTaskIds(ctx: Ctx): string[] {
  return listLiveTasks(ctx).map(t => t.id);
}

export function registryTaskIds(ctx: Ctx): string[] {
  // Live agent-session reservations: the same probe window other session readers use,
  // where ended or dead reservations never appear (bounded by open sessions, not history).
  const present = new Set<string>();
  const ids: string[] = [];
  try { for (const s of activeAgentSessions(ctx)) if (!present.has(s.task_id)) { present.add(s.task_id); ids.push(s.task_id); } }
  catch { /* An unreadable run record must never break selection. */ }
  const db = taskDatabase(ctx);
  // pump_session entries survive only while their task row does: a deleted task must
  // leave the registry (and its stale row goes with it) instead of paying a fetch forever.
  const stale = db.query<{ task_id: string }, []>(
    "SELECT ps.task_id AS task_id FROM pump_session ps LEFT JOIN tasks t ON t.id=ps.task_id WHERE t.id IS NULL OR t.archived=1").all()
    .map(row => row.task_id).filter(id => !present.has(id));
  if (stale.length) {
    try {
      db.transaction(() => { for (const id of stale) db.query("DELETE FROM pump_session WHERE task_id=?").run(id); }).immediate();
    } catch { /* Another process holds the database a moment; the next tick removes them. */ }
  }
  for (const row of db.query<{ task_id: string }, []>("SELECT task_id FROM pump_session").all())
    if (!present.has(row.task_id)) { ids.push(row.task_id); present.add(row.task_id); }
  return ids;
}

export function writeSessions(ctx: Ctx, keep: string[], drop: string[]): void {
  if (!keep.length && !drop.length) return;
  const db = taskDatabase(ctx);
  db.transaction(() => {
    for (const id of keep) if (isTaskId(id)) db.query("INSERT OR IGNORE INTO pump_session(task_id) VALUES(?)").run(id);
    for (const id of drop) if (isTaskId(id)) db.query("DELETE FROM pump_session WHERE task_id=?").run(id);
  }).immediate();
}

/** Whole-file rewrite of the legacy JSON ledgers from the SQLite tables (rollback
 *  bridge for this release). Whole files, like older binaries read them — paid only
 *  on reconciles and settle ticks, never on every tick. */
export function writeLegacyLedgers(ctx: Ctx): void {
  const db = taskDatabase(ctx);
  const data: Record<string, TaskData> = {}, states: Record<string, string> = {}, times: Record<string, number> = {};
  for (const row of db.query<{ task_id: string; data: string }, []>("SELECT task_id, data FROM pump_seen").all())
    data[row.task_id] = JSON.parse(row.data) as TaskData;
  for (const row of db.query<{ task_id: string; state: string; event_at: number | null }, []>("SELECT task_id, state, event_at FROM pump_state").all()) {
    states[row.task_id] = row.state;
    if (row.event_at !== null) times[row.task_id] = row.event_at;
  }
  writeJsonAtomic(join(ctx.pacerHome, "link", "task-data-seen.json"), data);
  writeJsonAtomic(join(ctx.pacerHome, "link", "task-states.json"), states);
  writeJsonAtomic(join(ctx.pacerHome, "link", "task-events-at.json"), times);
}

export const defaultLedgerApi: PumpLedgerApi = {
  importLegacyLedgers, isEmpty, readLedger, writeLedger, readCursor, writeCursor,
  readReconcileAt, writeReconcileAt,
  nonTerminalTaskIds, liveTaskIds, registryTaskIds, writeSessions, writeLegacyLedgers,
};
