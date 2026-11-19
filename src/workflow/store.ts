// Run and step persistence, in the existing task store (ARCH-16): the workflow tables
// are created once per connection by a guard, the same pattern dispatchDatabase uses.
// Definitions are immutable per version; run updates go through expect_rev.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { taskDatabase } from "../tasks/store";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import type { WorkflowDef } from "./schema";

// The connection is cached by taskDatabase; schema setup must therefore also run once
// per connection, not per call (see dispatch/store.ts for the same guard).
const ready = new WeakSet<Database>();
export function workflowDatabase(ctx: Ctx): Database {
  const db = taskDatabase(ctx);
  if (ready.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_defs(id TEXT, version INTEGER, source TEXT, def TEXT, added_at REAL, PRIMARY KEY(id, version));
    CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT, status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL);
    CREATE TABLE IF NOT EXISTS workflow_steps(run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT, task_id TEXT UNIQUE, status TEXT, result TEXT, error TEXT, started_at REAL, ended_at REAL, PRIMARY KEY(run_id, step_id, attempt, branch));
    CREATE TABLE IF NOT EXISTS workflow_cursor(id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER);
  `);
  ready.add(db);
  return db;
}

export type RunStatus = "running" | "waiting" | "done" | "failed" | "stopped";
export type StepStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export interface RunRow {
  id: string;
  workflow: string;
  version: number;
  repo: string;
  brief: string;
  title: string;
  status: RunStatus;
  reason?: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
  loops: Record<string, number>;
}

export interface StepRow {
  runId: string;
  stepId: string;
  attempt: number;
  branch?: string;
  taskId?: string;
  status: StepStatus;
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export type NewRun = { workflow: string; version: number; repo: string; brief: string; title?: string };

export type StepKey = { runId: string; stepId: string; attempt: number; branch?: string };

export type NewStep = StepKey & { taskId?: string; status: StepStatus };

// Run ids: `run_` plus 10 lowercase base32 characters.
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export function newRunId(): string {
  const bytes = randomBytes(10);
  let id = "run_";
  for (const byte of bytes) id += BASE32[byte % 32];
  return id;
}

interface DefRow { id: string; version: number; source: string; def: string; added_at: number }
interface RunDbRow {
  id: string; workflow: string; version: number; repo: string; brief: string; title: string;
  status: string; reason: string | null; loops: string | null; rev: number;
  created_at: number; updated_at: number;
}
interface StepDbRow {
  run_id: string; step_id: string; attempt: number; branch: string | null; task_id: string | null;
  status: string; result: string | null; error: string | null; started_at: number; ended_at: number | null;
}

function runFromRow(row: RunDbRow): RunRow {
  return {
    id: row.id,
    workflow: row.workflow,
    version: row.version,
    repo: row.repo,
    brief: row.brief,
    title: row.title,
    status: row.status as RunStatus,
    reason: row.reason ?? undefined,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    loops: row.loops ? (JSON.parse(row.loops) as Record<string, number>) : {},
  };
}

function stepFromRow(row: StepDbRow): StepRow {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    branch: row.branch ? row.branch : undefined,
    taskId: row.task_id ?? undefined,
    status: row.status as StepStatus,
    result: row.result === null ? undefined : JSON.parse(row.result),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  };
}

function stepWhere(key: StepKey): { sql: string; bindings: SQLQueryBindings[] } {
  const branch = key.branch ?? "";
  return { sql: "run_id = ? AND step_id = ? AND attempt = ? AND branch = ?", bindings: [key.runId, key.stepId, key.attempt, branch] };
}

/** Stores a definition version. The same id@version with the same source is a no-op;
 * with a different source it is a conflict. */
export function addDefinition(ctx: Ctx, def: WorkflowDef, source: string): { id: string; version: number; created: boolean } {
  const db = workflowDatabase(ctx);
  const existing = db.query<DefRow, [string, number]>("SELECT * FROM workflow_defs WHERE id = ? AND version = ?").get(def.id, def.version);
  if (existing) {
    if (existing.source !== source) throw new CoreError("conflict", `conflict: definition ${def.id}@${def.version} already exists with a different source`);
    return { id: def.id, version: def.version, created: false };
  }
  db.query("INSERT INTO workflow_defs(id, version, source, def, added_at) VALUES (?, ?, ?, ?, ?)")
    .run(def.id, def.version, source, JSON.stringify(def), ctx.now);
  return { id: def.id, version: def.version, created: true };
}

/** Looks up `id@N`, or the latest version of `id`. */
export function getDefinition(ctx: Ctx, ref: string): WorkflowDef | null {
  const db = workflowDatabase(ctx);
  const at = ref.lastIndexOf("@");
  let row: DefRow | null = null;
  if (at > 0) {
    const version = Number(ref.slice(at + 1));
    if (Number.isInteger(version)) row = db.query<DefRow, [string, number]>("SELECT * FROM workflow_defs WHERE id = ? AND version = ?").get(ref.slice(0, at), version) ?? null;
    if (row) return JSON.parse(row.def) as WorkflowDef;
  }
  row = db.query<DefRow, [string]>("SELECT * FROM workflow_defs WHERE id = ? ORDER BY version DESC LIMIT 1").get(ref) ?? null;
  return row ? (JSON.parse(row.def) as WorkflowDef) : null;
}

export function listDefinitions(ctx: Ctx): { id: string; version: number; title?: string; addedAt: number }[] {
  const db = workflowDatabase(ctx);
  return db.query<DefRow, []>("SELECT * FROM workflow_defs ORDER BY id, version").all().map(row => {
    const def = JSON.parse(row.def) as WorkflowDef;
    const entry = { id: row.id, version: row.version, addedAt: row.added_at };
    return def.title === undefined ? entry : { ...entry, title: def.title };
  });
}

export function insertRun(ctx: Ctx, r: NewRun): RunRow {
  const db = workflowDatabase(ctx);
  const row: RunRow = {
    id: newRunId(),
    workflow: r.workflow,
    version: r.version,
    repo: r.repo,
    brief: r.brief,
    title: r.title ?? r.workflow,
    status: "running",
    rev: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    loops: {},
  };
  db.query("INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.workflow, row.version, row.repo, row.brief, row.title, row.status, null, JSON.stringify(row.loops), row.rev, row.createdAt, row.updatedAt);
  return row;
}

export function getRun(ctx: Ctx, id: string): RunRow | null {
  const row = workflowDatabase(ctx).query<RunDbRow, [string]>("SELECT * FROM workflow_runs WHERE id = ?").get(id);
  return row ? runFromRow(row) : null;
}

export function listRuns(ctx: Ctx, status?: RunStatus): RunRow[] {
  const db = workflowDatabase(ctx);
  const rows = status === undefined
    ? db.query<RunDbRow, []>("SELECT * FROM workflow_runs ORDER BY created_at, id").all()
    : db.query<RunDbRow, [string]>("SELECT * FROM workflow_runs WHERE status = ? ORDER BY created_at, id").all(status);
  return rows.map(runFromRow);
}

export type RunPatch = Partial<Pick<RunRow, "status" | "reason" | "title" | "loops">>;

/** Applies a patch when `expectRev` is the run's current rev; a stale rev is a conflict. */
export function updateRun(ctx: Ctx, id: string, expectRev: number, patch: RunPatch): RunRow {
  const db = workflowDatabase(ctx);
  const current = getRun(ctx, id);
  if (!current) throw new CoreError("not_found", `unknown run ${id}`);
  if (current.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${id} changed since rev ${expectRev}`);
  const updated: RunRow = {
    ...current,
    status: patch.status ?? current.status,
    reason: patch.reason === undefined ? current.reason : patch.reason,
    title: patch.title ?? current.title,
    loops: patch.loops ?? current.loops,
    rev: current.rev + 1,
    updatedAt: ctx.now,
  };
  if (updated.reason === undefined) delete updated.reason;
  db.query("UPDATE workflow_runs SET status = ?, reason = ?, title = ?, loops = ?, rev = ?, updated_at = ? WHERE id = ?")
    .run(updated.status, updated.reason ?? null, updated.title, JSON.stringify(updated.loops), updated.rev, updated.updatedAt, id);
  return updated;
}

export function insertStep(ctx: Ctx, s: NewStep): StepRow {
  const db = workflowDatabase(ctx);
  const row: StepRow = {
    runId: s.runId,
    stepId: s.stepId,
    attempt: s.attempt,
    branch: s.branch,
    taskId: s.taskId,
    status: s.status,
    startedAt: ctx.now,
  };
  if (row.branch === undefined) delete row.branch;
  if (row.taskId === undefined) delete row.taskId;
  db.query("INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.runId, row.stepId, row.attempt, row.branch ?? "", row.taskId ?? null, row.status, null, null, row.startedAt, null);
  return row;
}

export type StepPatch = Partial<Pick<StepRow, "status" | "result" | "error" | "endedAt">>;

export function updateStep(ctx: Ctx, key: StepKey, patch: StepPatch): StepRow {
  const db = workflowDatabase(ctx);
  const where = stepWhere(key);
  const row = db.query<StepDbRow, SQLQueryBindings[]>(`SELECT * FROM workflow_steps WHERE ${where.sql}`).get(...where.bindings);
  if (!row) throw new CoreError("not_found", `unknown step ${key.stepId}#${key.attempt} of ${key.runId}`);
  const merged = stepFromRow({ ...row, status: patch.status ?? row.status, result: patch.result === undefined ? row.result : JSON.stringify(patch.result), error: patch.error === undefined ? row.error : patch.error, ended_at: patch.endedAt === undefined ? row.ended_at : patch.endedAt });
  db.query(`UPDATE workflow_steps SET status = ?, result = ?, error = ?, ended_at = ? WHERE ${where.sql}`)
    .run(merged.status, merged.result === undefined ? null : JSON.stringify(merged.result), merged.error ?? null, merged.endedAt ?? null, ...where.bindings);
  return merged;
}

export function stepsOfRun(ctx: Ctx, runId: string): StepRow[] {
  return workflowDatabase(ctx).query<StepDbRow, [string]>("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY started_at, step_id, attempt, branch").all(runId).map(stepFromRow);
}

export function stepByTask(ctx: Ctx, taskId: string): StepRow | null {
  const row = workflowDatabase(ctx).query<StepDbRow, [string]>("SELECT * FROM workflow_steps WHERE task_id = ?").get(taskId);
  return row ? stepFromRow(row) : null;
}

export function getCursor(ctx: Ctx): number {
  const row = workflowDatabase(ctx).query<{ seq: number | null }, []>("SELECT seq FROM workflow_cursor WHERE id = 1").get();
  return row?.seq ?? 0;
}

export function setCursor(ctx: Ctx, seq: number): void {
  workflowDatabase(ctx).query("INSERT OR REPLACE INTO workflow_cursor(id, seq) VALUES (1, ?)").run(seq);
}
