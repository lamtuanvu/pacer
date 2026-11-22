// Run and step persistence, in the existing task store (ARCH-16): the workflow tables
// are created once per connection by a guard, the same pattern dispatchDatabase uses.
// Definitions are immutable per version; run updates go through expect_rev.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { taskDatabase } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import type { WorkflowDef } from "./schema";

// The connection is cached by taskDatabase; schema setup must therefore also run once
// per connection, not per call (see dispatch/store.ts for the same guard). Apply the
// whole DDL in one immediate transaction so a concurrent reader (or a test that copies
// tasks.db + WAL mid-startup) never observes a partial workflow schema — phase 2 added
// many CREATE/ALTER steps after the original tables, which made that window flake
// native/forwarded parity (workflow_decisions appearing on only one side).
const ready = new WeakSet<Database>();
export function workflowDatabase(ctx: Ctx): Database {
  const db = taskDatabase(ctx);
  if (ready.has(db)) return db;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_defs(id TEXT, version INTEGER, source TEXT, def TEXT, added_at REAL, PRIMARY KEY(id, version));
      CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT, status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL);
      CREATE TABLE IF NOT EXISTS workflow_steps(run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT, task_id TEXT UNIQUE, status TEXT, result TEXT, error TEXT, started_at REAL, ended_at REAL, PRIMARY KEY(run_id, step_id, attempt, branch));
      CREATE TABLE IF NOT EXISTS workflow_cursor(id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER);
    `);
    // Added after the first schema; existing databases gain the columns in place
    // (pattern: src/messaging/store.ts). advanced_at records when a done step's
    // outgoing edges were processed ("nothing left to do" for the re-advance query),
    // so advancement survives a crash in between; a database that predates the
    // column has its finished rows backfilled as already advanced, so an upgrade
    // does not replay every historical step's edges once.
    if (!db.query<{ name: string }, []>("PRAGMA table_info(workflow_steps)").all().some(c => c.name === "advanced_at")) {
      db.exec("ALTER TABLE workflow_steps ADD COLUMN advanced_at REAL NULL");
      db.exec("UPDATE workflow_steps SET advanced_at = COALESCE(ended_at, started_at) WHERE status NOT IN ('running', 'waiting')");
    }
    // trigger records what caused a successor row: '<runId>/<stepId>#<attempt>/<branch>@<edgeIndex>'.
    // The unique index makes firing an edge exclusive: a second attempt to insert a
    // successor for an already-fired edge fails instead of duplicating the work
    // (NULLs are allowed — entry steps and join rows have no trigger).
    if (!db.query<{ name: string }, []>("PRAGMA table_info(workflow_steps)").all().some(c => c.name === "trigger")) db.exec(`ALTER TABLE workflow_steps ADD COLUMN "trigger" TEXT NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS workflow_steps_trigger ON workflow_steps("trigger")`);
    // The tick runs every second and reads steps by live status (orphans, re-advance,
    // recovery); partial indexes keep those scans cheap as the step history grows
    // (round 4 review).
    db.exec("CREATE INDEX IF NOT EXISTS workflow_steps_live ON workflow_steps(run_id) WHERE status IN ('running', 'waiting')");
    db.exec("CREATE INDEX IF NOT EXISTS workflow_steps_unadvanced ON workflow_steps(run_id) WHERE status = 'done' AND advanced_at IS NULL");
    // Phase 2: durable orchestrator wake-ups and turns (one live turn per run).
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_wakeups(
        run_id TEXT NOT NULL,
        cause TEXT NOT NULL,
        ref TEXT NOT NULL,
        created_at REAL NOT NULL,
        turn_id TEXT NULL,
        done_at REAL NULL,
        by_person INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(run_id, cause, ref)
      );
      CREATE TABLE IF NOT EXISTS workflow_turns(
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        planner TEXT NOT NULL,
        session_id TEXT NULL,
        task_id TEXT NULL,
        status TEXT NOT NULL,
        reason TEXT NULL,
        started_at REAL NOT NULL,
        deadline REAL NOT NULL,
        ended_at REAL NULL,
        failures INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS workflow_turns_live ON workflow_turns(run_id) WHERE status IN ('starting', 'running')");
    const turnColumns = db.query<{ name: string }, []>("PRAGMA table_info(workflow_turns)").all().map(c => c.name);
    if (!turnColumns.includes("seq")) {
      db.exec("ALTER TABLE workflow_turns ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
    }
    // Orchestrator state columns on the run (auto mode, planner, session, budget).
    const runColumns = db.query<{ name: string }, []>("PRAGMA table_info(workflow_runs)").all().map(c => c.name);
    if (!runColumns.includes("auto")) db.exec("ALTER TABLE workflow_runs ADD COLUMN auto INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.includes("planner")) db.exec("ALTER TABLE workflow_runs ADD COLUMN planner TEXT");
    if (!runColumns.includes("orchestrator_task_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN orchestrator_task_id TEXT");
    if (!runColumns.includes("session_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN session_id TEXT");
    if (!runColumns.includes("budget")) db.exec("ALTER TABLE workflow_runs ADD COLUMN budget TEXT");
    if (!runColumns.includes("spent")) db.exec("ALTER TABLE workflow_runs ADD COLUMN spent TEXT");
    if (!runColumns.includes("next_wake_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN next_wake_at REAL");
    if (!runColumns.includes("orchestrator_state")) db.exec("ALTER TABLE workflow_runs ADD COLUMN orchestrator_state TEXT");
    if (!runColumns.includes("parent_run_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT");
    if (!runColumns.includes("parent_step")) db.exec("ALTER TABLE workflow_runs ADD COLUMN parent_step TEXT");
    if (!runColumns.includes("strict_steps")) db.exec("ALTER TABLE workflow_runs ADD COLUMN strict_steps TEXT");
    if (!runColumns.includes("pending_planner")) db.exec("ALTER TABLE workflow_runs ADD COLUMN pending_planner TEXT");
    // Phase 3: pin each run's step start path (D8). Pre-existing rows read as plain.
    if (!runColumns.includes("step_mode")) db.exec("ALTER TABLE workflow_runs ADD COLUMN step_mode TEXT NOT NULL DEFAULT 'plain'");
    if (!runColumns.includes("root_task_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN root_task_id TEXT");
    // Phase 5: run branch (created lazily at the first code step). Pre-existing rows stay NULL.
    if (!runColumns.includes("branch")) db.exec("ALTER TABLE workflow_runs ADD COLUMN branch TEXT");
    if (!runColumns.includes("base_ref")) db.exec("ALTER TABLE workflow_runs ADD COLUMN base_ref TEXT");
    if (!runColumns.includes("base_sha")) db.exec("ALTER TABLE workflow_runs ADD COLUMN base_sha TEXT");
    // Phase 5 publishing: optional draft opt-in at start, and the PR URL after publish.
    if (!runColumns.includes("publish_opt_in")) db.exec("ALTER TABLE workflow_runs ADD COLUMN publish_opt_in TEXT");
    if (!runColumns.includes("pr_url")) db.exec("ALTER TABLE workflow_runs ADD COLUMN pr_url TEXT");
    // Phase 5 fix I1: durable unresolved conflict marker (JSON RunConflict).
    if (!runColumns.includes("conflict")) db.exec("ALTER TABLE workflow_runs ADD COLUMN conflict TEXT");
    // Decision log: every orchestrator (and refused) choice with its reason (G7).
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_decisions(
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        choice TEXT NOT NULL,
        reason TEXT NOT NULL,
        at REAL NOT NULL
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS workflow_decisions_run ON workflow_decisions(run_id, at, id)");
    // Phase 3: versioned generated graphs linked to the producing generate step.
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_graphs(
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        version INTEGER NOT NULL,
        def TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at REAL NOT NULL,
        PRIMARY KEY(run_id, step_id, attempt, version)
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS workflow_graphs_run ON workflow_graphs(run_id, step_id, attempt, version)");
    // Phase 5: step artifact metadata (blobs live under PACER_HOME/runs/<id>/artifacts/).
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_artifacts(
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        label TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at REAL NOT NULL
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS workflow_artifacts_run ON workflow_artifacts(run_id, created_at, id)");
  }).immediate();
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
  /** Phase 2 orchestrator: auto mode (0/1), planner agent, owned task and session. */
  auto?: boolean;
  planner?: string;
  orchestratorTaskId?: string;
  sessionId?: string;
  budget?: string;
  spent?: string;
  nextWakeAt?: number;
  /** idle | turn | retrying | blocked */
  orchestratorState?: string;
  parentRunId?: string;
  parentStep?: string;
  /** Step ids the person marked must for this run (never loosens a must). */
  strictSteps?: string[];
  /** Planner switch queued for the next turn (D2). */
  pendingPlanner?: string;
  /** Phase 3: `plain` (Phase 1/2) or `work_node` (engine-owned root). Pinned for the run's life (D8). */
  stepMode?: "plain" | "work_node";
  /** Engine-owned dispatcher root for `work_node` runs. */
  rootTaskId?: string;
  /** Phase 5: local run branch (`pacer/run-<id>`), base ref name and the tip sha at creation. */
  branch?: string;
  baseRef?: string;
  baseSha?: string;
  /** Phase 5: `draft` when the person opted in at start for draft-only publish. */
  publishOptIn?: "draft";
  /** Phase 5: URL of the opened PR after a successful publish. */
  prUrl?: string;
  /** Phase 5: durable unresolved merge conflict (publish gate); cleared only after a clean merge. */
  conflict?: RunConflict;
}

/** Durable run-level merge conflict marker (not derived from resolution-task state). */
export type RunConflict = {
  taskId: string;
  branch: string;
  resolutionTaskId: string;
};

export interface DecisionRow {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  actor: string;
  kind: string;
  choice: string;
  reason: string;
  at: number;
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
  /** When the step's outgoing edges were processed; unset means advancement may
   *  still be owed (a crash between marking the step done and advancing). */
  advancedAt?: number;
  /** What caused this row: '<runId>/<stepId>#<attempt>/<branch>@<edgeIndex>' of the
   *  predecessor instance and the edge that started it. Unique, so an edge fires
   *  at most one successor; unset for entry steps and join rows. */
  trigger?: string;
}

export type NewRun = {
  workflow: string;
  version: number;
  repo: string;
  brief: string;
  title?: string;
  parentRunId?: string;
  parentStep?: string;
  /** Share the root's orchestrator task/session/planner. */
  planner?: string;
  orchestratorTaskId?: string;
  sessionId?: string;
  budget?: string;
  spent?: string;
  stepMode?: "plain" | "work_node";
  rootTaskId?: string;
};

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
  auto?: number | null;
  planner?: string | null;
  orchestrator_task_id?: string | null;
  session_id?: string | null;
  budget?: string | null;
  spent?: string | null;
  next_wake_at?: number | null;
  orchestrator_state?: string | null;
  parent_run_id?: string | null;
  parent_step?: string | null;
  strict_steps?: string | null;
  pending_planner?: string | null;
  step_mode?: string | null;
  root_task_id?: string | null;
  branch?: string | null;
  base_ref?: string | null;
  base_sha?: string | null;
  publish_opt_in?: string | null;
  pr_url?: string | null;
  conflict?: string | null;
}
interface StepDbRow {
  run_id: string; step_id: string; attempt: number; branch: string | null; task_id: string | null;
  status: string; result: string | null; error: string | null; started_at: number; ended_at: number | null; advanced_at: number | null; trigger: string | null;
}

function runFromRow(row: RunDbRow): RunRow {
  const out: RunRow = {
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
  if (row.auto != null) out.auto = row.auto === 1;
  if (row.planner) out.planner = row.planner;
  if (row.orchestrator_task_id) out.orchestratorTaskId = row.orchestrator_task_id;
  if (row.session_id) out.sessionId = row.session_id;
  if (row.budget) out.budget = row.budget;
  if (row.spent) out.spent = row.spent;
  if (row.next_wake_at != null) out.nextWakeAt = row.next_wake_at;
  if (row.orchestrator_state) out.orchestratorState = row.orchestrator_state;
  if (row.parent_run_id) out.parentRunId = row.parent_run_id;
  if (row.parent_step) out.parentStep = row.parent_step;
  if (row.strict_steps) {
    try { out.strictSteps = JSON.parse(row.strict_steps) as string[]; } catch { /* ignore bad JSON */ }
  }
  if (row.pending_planner) out.pendingPlanner = row.pending_planner;
  out.stepMode = row.step_mode === "work_node" ? "work_node" : "plain";
  if (row.root_task_id) out.rootTaskId = row.root_task_id;
  if (row.branch) out.branch = row.branch;
  if (row.base_ref) out.baseRef = row.base_ref;
  if (row.base_sha) out.baseSha = row.base_sha;
  if (row.publish_opt_in === "draft") out.publishOptIn = "draft";
  if (row.pr_url) out.prUrl = row.pr_url;
  if (row.conflict) {
    try {
      const parsed = JSON.parse(row.conflict) as RunConflict;
      if (parsed && typeof parsed.taskId === "string" && typeof parsed.branch === "string"
        && typeof parsed.resolutionTaskId === "string") {
        out.conflict = parsed;
      }
    } catch { /* ignore bad JSON */ }
  }
  return out;
}

/** Run value published on the entity stream / returned by run.get (orchestrator block). */
export function runEntityValue(run: RunRow): RunRow & {
  orchestrator: { state: string; planner?: string; reason?: string; next_wake_at?: number };
} {
  return {
    ...run,
    orchestrator: {
      state: run.orchestratorState ?? "idle",
      ...(run.planner || run.pendingPlanner ? { planner: run.pendingPlanner ?? run.planner } : {}),
      ...(run.reason ? { reason: run.reason } : {}),
      ...(run.nextWakeAt !== undefined ? { next_wake_at: run.nextWakeAt } : {}),
    },
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
    advancedAt: row.advanced_at ?? undefined,
    trigger: row.trigger ?? undefined,
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
  if (r.parentRunId) row.parentRunId = r.parentRunId;
  if (r.parentStep) row.parentStep = r.parentStep;
  if (r.planner) row.planner = r.planner;
  if (r.orchestratorTaskId) row.orchestratorTaskId = r.orchestratorTaskId;
  if (r.sessionId) row.sessionId = r.sessionId;
  if (r.budget) row.budget = r.budget;
  if (r.spent) row.spent = r.spent;
  row.stepMode = r.stepMode ?? "work_node";
  if (r.rootTaskId) row.rootTaskId = r.rootTaskId;
  db.query(
    "INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at, parent_run_id, parent_step, planner, orchestrator_task_id, session_id, budget, spent, step_mode, root_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id, row.workflow, row.version, row.repo, row.brief, row.title, row.status, null,
    JSON.stringify(row.loops), row.rev, row.createdAt, row.updatedAt,
    row.parentRunId ?? null, row.parentStep ?? null,
    row.planner ?? null, row.orchestratorTaskId ?? null, row.sessionId ?? null,
    row.budget ?? null, row.spent ?? null,
    row.stepMode, row.rootTaskId ?? null,
  );
  return row;
}

/** Root run id: walk parent_run_id until none. */
export function rootRunId(ctx: Ctx, runId: string): string {
  let id = runId;
  for (;;) {
    const run = getRun(ctx, id);
    if (!run?.parentRunId) return id;
    id = run.parentRunId;
  }
}

export function getRun(ctx: Ctx, id: string): RunRow | null {
  const row = workflowDatabase(ctx).query<RunDbRow, [string]>("SELECT * FROM workflow_runs WHERE id = ?").get(id);
  return row ? runFromRow(row) : null;
}

/** Record the run branch once without bumping `rev` (engine-owned, like setRootTaskId). */
export function setRunBranch(ctx: Ctx, runId: string, info: { branch: string; base_ref: string; base_sha: string }): void {
  const db = workflowDatabase(ctx);
  const result = db.query(
    "UPDATE workflow_runs SET branch = ?, base_ref = ?, base_sha = ? WHERE id = ? AND (branch IS NULL OR branch = '')",
  ).run(info.branch, info.base_ref, info.base_sha, runId);
  if (result.changes === 0) {
    const current = getRun(ctx, runId);
    if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
    if (current.branch && current.branch !== info.branch) {
      throw new CoreError("conflict", `conflict: run ${runId} already has a branch`);
    }
  }
}

/** Person opt-in at start for draft-only publish (`publish: draft`). Does not bump `rev`. */
export function setPublishOptIn(ctx: Ctx, runId: string, optIn: "draft"): void {
  const db = workflowDatabase(ctx);
  const result = db.query(
    "UPDATE workflow_runs SET publish_opt_in = ? WHERE id = ? AND (publish_opt_in IS NULL OR publish_opt_in = ?)",
  ).run(optIn, runId, optIn);
  if (result.changes === 0) {
    const current = getRun(ctx, runId);
    if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
    if (current.publishOptIn && current.publishOptIn !== optIn) {
      throw new CoreError("conflict", `conflict: run ${runId} already has a publish opt-in`);
    }
  }
}

/** Clear local branch columns after `run.cleanup` deletes the branch. Does not bump `rev`. */
export function clearRunBranch(ctx: Ctx, runId: string): void {
  workflowDatabase(ctx).query(
    "UPDATE workflow_runs SET branch = NULL, base_ref = NULL, base_sha = NULL WHERE id = ?",
  ).run(runId);
}

/** Store the PR URL after publish. Idempotent for the same URL; a different URL is a conflict. */
export function setRunPrUrl(ctx: Ctx, runId: string, prUrl: string): void {
  const db = workflowDatabase(ctx);
  const result = db.query(
    "UPDATE workflow_runs SET pr_url = ? WHERE id = ? AND (pr_url IS NULL OR pr_url = '' OR pr_url = ?)",
  ).run(prUrl, runId, prUrl);
  if (result.changes === 0) {
    const current = getRun(ctx, runId);
    if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
    if (current.prUrl && current.prUrl !== prUrl) {
      throw new CoreError("conflict", `conflict: run ${runId} already has a different PR URL`);
    }
  }
}

/** Record an unresolved merge conflict on the run (publish gate). Does not bump `rev`. */
export function setRunConflict(ctx: Ctx, runId: string, conflict: RunConflict): void {
  const db = workflowDatabase(ctx);
  const result = db.query(
    "UPDATE workflow_runs SET conflict = ? WHERE id = ?",
  ).run(JSON.stringify(conflict), runId);
  if (result.changes === 0) throw new CoreError("not_found", `unknown run ${runId}`);
}

/** Clear the durable conflict marker after a clean merge of the conflicting work. */
export function clearRunConflict(ctx: Ctx, runId: string): void {
  workflowDatabase(ctx).query(
    "UPDATE workflow_runs SET conflict = NULL WHERE id = ?",
  ).run(runId);
}

/** Attach the engine-owned root work node without bumping `rev` (part of start, not a client-visible patch). */
export function setRootTaskId(ctx: Ctx, runId: string, rootTaskId: string): void {
  const db = workflowDatabase(ctx);
  const result = db.query(
    "UPDATE workflow_runs SET root_task_id = ?, step_mode = COALESCE(NULLIF(step_mode, ''), 'work_node') WHERE id = ? AND (root_task_id IS NULL OR root_task_id = ?)",
  ).run(rootTaskId, runId, rootTaskId);
  if (result.changes === 0) {
    const current = getRun(ctx, runId);
    if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
    if (current.rootTaskId && current.rootTaskId !== rootTaskId) {
      throw new CoreError("conflict", `conflict: run ${runId} already has a root task`);
    }
  }
}

/** Compare-and-set replacement when the previous root is dead (deleted/archived/lost work row). */
export function replaceRootTaskId(ctx: Ctx, runId: string, oldRootTaskId: string, newRootTaskId: string): void {
  const db = workflowDatabase(ctx);
  const result = db.query(
    "UPDATE workflow_runs SET root_task_id = ?, step_mode = COALESCE(NULLIF(step_mode, ''), 'work_node') WHERE id = ? AND root_task_id = ?",
  ).run(newRootTaskId, runId, oldRootTaskId);
  if (result.changes === 0) {
    const current = getRun(ctx, runId);
    if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
    if (current.rootTaskId === newRootTaskId) return;
    throw new CoreError("conflict", `conflict: run ${runId} root task changed`);
  }
}

export function listRuns(ctx: Ctx, status?: RunStatus): RunRow[] {
  const db = workflowDatabase(ctx);
  const rows = status === undefined
    ? db.query<RunDbRow, []>("SELECT * FROM workflow_runs ORDER BY created_at, id").all()
    : db.query<RunDbRow, [string]>("SELECT * FROM workflow_runs WHERE status = ? ORDER BY created_at, id").all(status);
  return rows.map(runFromRow);
}

/** Live runs only (running or waiting), oldest first: the tick's rescan, recovery
 *  and re-advance walks run every second, so the status filter lives in the SQL
 *  instead of walking every run ever recorded (round 4 review). */
export function liveRuns(ctx: Ctx): RunRow[] {
  return workflowDatabase(ctx).query<RunDbRow, []>("SELECT * FROM workflow_runs WHERE status IN ('running', 'waiting') ORDER BY created_at, id").all().map(runFromRow);
}

export type RunPatch = Partial<Pick<RunRow, "status" | "title" | "loops" | "auto" | "planner" | "orchestratorTaskId" | "sessionId" | "budget" | "spent" | "strictSteps" | "stepMode" | "rootTaskId">> & {
  reason?: string | null;
  nextWakeAt?: number | null;
  orchestratorState?: string | null;
  pendingPlanner?: string | null;
};

/** Applies a patch when `expectRev` is the run's current rev; a stale rev is a conflict.
 *  The rev check and the write share one transaction guarded by `WHERE id = ? AND rev = ?`,
 *  so a concurrent writer can never slip between the check and the write
 *  (pattern: src/dispatch/work.ts registerWork). */
export function updateRun(ctx: Ctx, id: string, expectRev: number, patch: RunPatch): RunRow {
  const db = workflowDatabase(ctx);
  return db.transaction(() => {
    const current = getRun(ctx, id);
    if (!current) throw new CoreError("not_found", `unknown run ${id}`);
    if (current.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${id} changed since rev ${expectRev}`);
    const updated: RunRow = {
      ...current,
      status: patch.status ?? current.status,
      reason: patch.reason === undefined ? current.reason : (patch.reason ?? undefined),
      title: patch.title ?? current.title,
      loops: patch.loops ?? current.loops,
      auto: patch.auto === undefined ? current.auto : patch.auto,
      planner: patch.planner === undefined ? current.planner : patch.planner,
      orchestratorTaskId: patch.orchestratorTaskId === undefined ? current.orchestratorTaskId : patch.orchestratorTaskId,
      sessionId: patch.sessionId === undefined ? current.sessionId : patch.sessionId,
      budget: patch.budget === undefined ? current.budget : patch.budget,
      spent: patch.spent === undefined ? current.spent : patch.spent,
      strictSteps: patch.strictSteps === undefined ? current.strictSteps : patch.strictSteps,
      pendingPlanner: patch.pendingPlanner === undefined ? current.pendingPlanner : (patch.pendingPlanner ?? undefined),
      nextWakeAt: patch.nextWakeAt === undefined ? current.nextWakeAt : (patch.nextWakeAt ?? undefined),
      orchestratorState: patch.orchestratorState === undefined ? current.orchestratorState : (patch.orchestratorState ?? undefined),
      stepMode: patch.stepMode === undefined ? current.stepMode : patch.stepMode,
      rootTaskId: patch.rootTaskId === undefined ? current.rootTaskId : patch.rootTaskId,
      rev: current.rev + 1,
      updatedAt: ctx.now,
    };
    if (updated.reason === undefined) delete updated.reason;
    if (updated.planner === undefined) delete updated.planner;
    if (updated.orchestratorTaskId === undefined) delete updated.orchestratorTaskId;
    if (updated.sessionId === undefined) delete updated.sessionId;
    if (updated.budget === undefined) delete updated.budget;
    if (updated.spent === undefined) delete updated.spent;
    if (updated.strictSteps === undefined) delete updated.strictSteps;
    if (updated.pendingPlanner === undefined) delete updated.pendingPlanner;
    if (updated.nextWakeAt === undefined) delete updated.nextWakeAt;
    if (updated.orchestratorState === undefined) delete updated.orchestratorState;
    if (updated.stepMode === undefined) delete updated.stepMode;
    if (updated.rootTaskId === undefined) delete updated.rootTaskId;
    const result = db.query(
      "UPDATE workflow_runs SET status = ?, reason = ?, title = ?, loops = ?, rev = ?, updated_at = ?, auto = ?, planner = ?, orchestrator_task_id = ?, session_id = ?, budget = ?, spent = ?, next_wake_at = ?, orchestrator_state = ?, strict_steps = ?, pending_planner = ?, step_mode = ?, root_task_id = ? WHERE id = ? AND rev = ?",
    ).run(
      updated.status,
      updated.reason ?? null,
      updated.title,
      JSON.stringify(updated.loops),
      updated.rev,
      updated.updatedAt,
      updated.auto ? 1 : 0,
      updated.planner ?? null,
      updated.orchestratorTaskId ?? null,
      updated.sessionId ?? null,
      updated.budget ?? null,
      updated.spent ?? null,
      updated.nextWakeAt ?? null,
      updated.orchestratorState ?? null,
      updated.strictSteps ? JSON.stringify(updated.strictSteps) : null,
      updated.pendingPlanner ?? null,
      updated.stepMode ?? "plain",
      updated.rootTaskId ?? null,
      id,
      expectRev,
    );
    if (result.changes === 0) throw new CoreError("conflict", `conflict: run ${id} changed since rev ${expectRev}`);
    return updated;
  })();
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

/** Inserts every branch row of one fan-out attempt in ONE transaction (the fireEdge
 *  pattern): all branches of the attempt become visible together, before any branch
 *  is delegated, so a branch whose task settles inside its own delegation call can
 *  never evaluate the join — or stop a join:'any' branch — while a later branch row
 *  of the attempt does not exist yet (round 4 review). */
export function insertFanoutBranches(ctx: Ctx, runId: string, stepId: string, attempt: number, branches: string[]): StepRow[] {
  const db = workflowDatabase(ctx);
  return db.transaction(() => branches.map(branch => {
    db.query("INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at) VALUES (?, ?, ?, ?, NULL, 'running', NULL, NULL, ?, NULL)")
      .run(runId, stepId, attempt, branch, ctx.now);
    return { runId, stepId, attempt, branch, status: "running" as const, startedAt: ctx.now };
  }))();
}

/** Atomically records a fan-out attempt's join row (INSERT OR IGNORE): of two
 *  concurrent joins of the same attempt exactly one caller inserts the row and owns
 *  the advancement; the loser gets null and returns quietly instead of failing a
 *  healthy run on the attempt's PRIMARY KEY (round 4 review). */
export function insertJoinStep(ctx: Ctx, runId: string, stepId: string, attempt: number, status: "done" | "failed", result: unknown): StepRow | null {
  const db = workflowDatabase(ctx);
  const inserted = db.query(
    "INSERT OR IGNORE INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at) VALUES (?, ?, ?, '', NULL, ?, ?, NULL, ?, ?)",
  ).run(runId, stepId, attempt, status, JSON.stringify(result), ctx.now, ctx.now);
  if (inserted.changes === 0) return null;
  const row = db.query<StepDbRow, SQLQueryBindings[]>("SELECT * FROM workflow_steps WHERE run_id = ? AND step_id = ? AND attempt = ? AND branch = ''").get(runId, stepId, attempt);
  return row ? stepFromRow(row) : null;
}

export type StepPatch = Partial<Pick<StepRow, "status" | "error" | "endedAt" | "advancedAt">> & {
  /** `undefined` keeps the current value; `null` clears it (SQL NULL). */
  result?: unknown | null;
};

/** Resolves a result patch: undefined keeps, null clears, otherwise JSON. */
function resultSqlValue(current: string | null, patch: unknown | null | undefined): string | null {
  if (patch === undefined) return current;
  if (patch === null) return null;
  return JSON.stringify(patch);
}

export function updateStep(ctx: Ctx, key: StepKey, patch: StepPatch): StepRow {
  const db = workflowDatabase(ctx);
  const where = stepWhere(key);
  const row = db.query<StepDbRow, SQLQueryBindings[]>(`SELECT * FROM workflow_steps WHERE ${where.sql}`).get(...where.bindings);
  if (!row) throw new CoreError("not_found", `unknown step ${key.stepId}#${key.attempt} of ${key.runId}`);
  const nextResult = resultSqlValue(row.result, patch.result);
  const nextStatus = patch.status ?? row.status;
  const nextError = patch.error === undefined ? row.error : patch.error;
  const nextEnded = patch.endedAt === undefined ? row.ended_at : patch.endedAt;
  const nextAdvanced = patch.advancedAt === undefined ? row.advanced_at : patch.advancedAt;
  db.query(`UPDATE workflow_steps SET status = ?, result = ?, error = ?, ended_at = ?, advanced_at = ? WHERE ${where.sql}`)
    .run(nextStatus, nextResult, nextError ?? null, nextEnded ?? null, nextAdvanced ?? null, ...where.bindings);
  return stepFromRow({
    ...row,
    status: nextStatus,
    result: nextResult,
    error: nextError,
    ended_at: nextEnded,
    advanced_at: nextAdvanced,
  });
}

/** Atomically claims the settlement of a running step row: the write lands only when
 *  the row is still `running`, so of two concurrent settlers (the request thread's
 *  attachAndSettle and the tick thread's onTaskSettled) exactly one wins and advances
 *  the run. Returns the settled row, or null when another caller already claimed it. */
export function claimStepSettlement(ctx: Ctx, key: StepKey, patch: StepPatch): StepRow | null {
  const db = workflowDatabase(ctx);
  const where = stepWhere(key);
  const row = db.query<StepDbRow, SQLQueryBindings[]>(`SELECT * FROM workflow_steps WHERE ${where.sql}`).get(...where.bindings);
  if (!row || row.status !== "running") return null;
  const nextResult = resultSqlValue(row.result, patch.result);
  const nextStatus = patch.status ?? row.status;
  const nextError = patch.error === undefined ? row.error : patch.error;
  const nextEnded = patch.endedAt === undefined ? row.ended_at : patch.endedAt;
  const result = db.query(`UPDATE workflow_steps SET status = ?, result = ?, error = ?, ended_at = ? WHERE ${where.sql} AND status = 'running'`)
    .run(nextStatus, nextResult, nextError ?? null, nextEnded ?? null, ...where.bindings);
  return result.changes === 1
    ? stepFromRow({ ...row, status: nextStatus, result: nextResult, error: nextError, ended_at: nextEnded })
    : null;
}

export interface EdgeFire {
  runId: string;
  /** The settled predecessor instance the edge fires from. */
  from: { stepId: string; attempt: number; branch?: string };
  /** The edge's position in the definition; part of the trigger. */
  edgeIndex: number;
  /** The successor step id. */
  stepId: string;
  /** The successor's initial status: waiting for a human step, running otherwise. */
  status: "running" | "waiting";
  /** Branch names for a fan-out target: one successor row per branch. */
  branches?: string[];
  /** Back-edge loop bookkeeping: the counter key and the edge's maxLoops. */
  back?: { key: string; maxLoops: number };
}

export type EdgeFireResult =
  | { kind: "handled" }
  | { kind: "terminal" }
  | { kind: "loop-limit"; loops: Record<string, number> }
  | { kind: "fired"; rows: StepRow[]; loops?: Record<string, number> };

const edgeTrigger = (fire: EdgeFire): string =>
  `${fire.runId}/${fire.from.stepId}#${fire.from.attempt}/${fire.from.branch ?? ""}@${fire.edgeIndex}`;

/** Fires one outgoing edge of a settled step exclusively and idempotently, in ONE
 *  immediate transaction: if a row with this edge's trigger already exists, the
 *  edge was already handled by an earlier or concurrent advancement and is skipped
 *  (no loop increment, no successor). Otherwise the back-edge loop counter is read
 *  and written directly inside the transaction — with no expect-rev check against a
 *  possibly stale rev, so a loop patch can never fail a healthy run over a rev
 *  conflict from the request thread; the immediate transaction (and the rev bump)
 *  is what serializes it against updateRun — and the successor row(s) are inserted
 *  with the trigger recorded. Delegation happens after the transaction, exactly
 *  like the insert-row-then-delegate start path, so a crash before it is an
 *  ordinary orphan the reconciliation recovers. */
export function fireEdge(ctx: Ctx, fire: EdgeFire): EdgeFireResult {
  const db = workflowDatabase(ctx);
  const trigger = edgeTrigger(fire);
  for (let tryn = 0; ; tryn++) {
    try {
      return db.transaction((): EdgeFireResult => {
        // Re-checked inside the transaction: a stop can land between the caller's
        // terminal check and this fire (the tick and run.answer run on different
        // connections), so a run that is no longer live inserts nothing and reports
        // terminal instead of leaving a running successor row behind
        // (round 4 review).
        const runRow = db.query<{ status: string }, [string]>("SELECT status FROM workflow_runs WHERE id = ?").get(fire.runId);
        if (!runRow || (runRow.status !== "running" && runRow.status !== "waiting")) return { kind: "terminal" };
        if (db.query(`SELECT 1 FROM workflow_steps WHERE "trigger" = ?`).get(trigger)) return { kind: "handled" };
        let loops: Record<string, number> | undefined;
        if (fire.back) {
          const row = db.query<{ loops: string | null }, [string]>("SELECT loops FROM workflow_runs WHERE id = ?").get(fire.runId);
          if (!row) throw new CoreError("not_found", `unknown run ${fire.runId}`);
          const current: Record<string, number> = row.loops ? JSON.parse(row.loops) : {};
          const next = { ...current, [fire.back.key]: (current[fire.back.key] ?? 0) + 1 };
          db.query("UPDATE workflow_runs SET loops = ?, rev = rev + 1, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(next), ctx.now, fire.runId);
          loops = next;
          if (next[fire.back.key]! > fire.back.maxLoops) return { kind: "loop-limit", loops: next };
        }
        const attempt = (db.query<{ n: number | null }, [string, string]>("SELECT MAX(attempt) AS n FROM workflow_steps WHERE run_id = ? AND step_id = ?")
          .get(fire.runId, fire.stepId)?.n ?? 0) + 1;
        const rows: StepRow[] = [];
        const branches = fire.branches ?? [undefined];
        branches.forEach((branch, i) => {
          // The first successor row carries the edge trigger; a fan-out's further
          // branch rows carry it suffixed with their branch so every row stays unique.
          const rowTrigger = i === 0 ? trigger : `${trigger}/${branch}`;
          db.query(`INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at, "trigger") VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, ?)`)
            .run(fire.runId, fire.stepId, attempt, branch ?? "", fire.status, ctx.now, rowTrigger);
          rows.push({ runId: fire.runId, stepId: fire.stepId, attempt, branch, status: fire.status, startedAt: ctx.now, trigger: rowTrigger });
        });
        return { kind: "fired", rows, ...(loops ? { loops } : {}) };
      }).immediate();
    } catch (err) {
      // A concurrent advancement of the same predecessor inserted the same successor
      // first (trigger or step key UNIQUE): retry the decision from fresh state —
      // the attempt must be recomputed — and treat an existing trigger as handled.
      if (`${err instanceof Error ? err.message : err}`.includes("UNIQUE constraint failed") && tryn < 2) continue;
      if (db.query(`SELECT 1 FROM workflow_steps WHERE "trigger" = ?`).get(trigger)) return { kind: "handled" };
      throw err;
    }
  }
}

/** Atomically answers a waiting human step row: the compare-and-set write lands
 *  only while the row is still `waiting` (like claimStepSettlement), so of two
 *  concurrent answers exactly one wins and the loser gets a conflict. Returns null
 *  when the row is not waiting (already answered, stopped, …). */
export function claimStepAnswer(ctx: Ctx, key: StepKey, result: unknown): StepRow | null {
  const db = workflowDatabase(ctx);
  const where = stepWhere(key);
  const row = db.query<StepDbRow, SQLQueryBindings[]>(`SELECT * FROM workflow_steps WHERE ${where.sql}`).get(...where.bindings);
  if (!row || row.status !== "waiting") return null;
  const done = db.query(`UPDATE workflow_steps SET status = 'done', result = ?, ended_at = ? WHERE ${where.sql} AND status = 'waiting'`)
    .run(JSON.stringify(result), ctx.now, ...where.bindings);
  return done.changes === 1 ? stepFromRow({ ...row, status: "done", result: JSON.stringify(result), ended_at: ctx.now }) : null;
}

/** Done step rows whose outgoing edges may never have been processed (advanced_at
 *  unset), in live runs, completed before `before`: the stalled advancements each
 *  tick re-advances. Fan-out branch rows are excluded here and by the caller: their
 *  branch-less join row owns the advancement. */
export function unadvancedDoneSteps(ctx: Ctx, before: number): StepRow[] {
  return workflowDatabase(ctx).query<StepDbRow, [number]>(
    `SELECT s.* FROM workflow_steps s JOIN workflow_runs r ON r.id = s.run_id
     WHERE s.status = 'done' AND s.advanced_at IS NULL AND s.branch = ''
       AND r.status IN ('running', 'waiting') AND COALESCE(s.ended_at, s.started_at) < ?
     ORDER BY s.started_at`).all(before).map(stepFromRow);
}

export function stepsOfRun(ctx: Ctx, runId: string): StepRow[] {
  return workflowDatabase(ctx).query<StepDbRow, [string]>("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY started_at, step_id, attempt, branch").all(runId).map(stepFromRow);
}

export function stepByTask(ctx: Ctx, taskId: string): StepRow | null {
  const row = workflowDatabase(ctx).query<StepDbRow, [string]>("SELECT * FROM workflow_steps WHERE task_id = ?").get(taskId);
  return row ? stepFromRow(row) : null;
}

/**
 * Read-only: true when `taskId` is a workflow step of a run that already has a
 * branch. Uses sqlite_master only — never runs workflow DDL — so ordinary
 * accepts and the native review probe stay side-effect free on old DBs.
 * Missing tables / columns mean "no" (fail closed for the merge gate: skip).
 */
export function stepTaskNeedsRunBranchMerge(ctx: Ctx, taskId: string): boolean {
  const db = taskDatabase(ctx);
  const present = db.query(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'workflow_steps'",
  ).get();
  if (!present) return false;
  const runsPresent = db.query(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'",
  ).get();
  if (!runsPresent) return false;
  try {
    const row = db.query<{ branch: string | null }, [string]>(
      `SELECT r.branch AS branch
       FROM workflow_steps s
       JOIN workflow_runs r ON r.id = s.run_id
       WHERE s.task_id = ?
       LIMIT 1`,
    ).get(taskId);
    if (typeof row?.branch === "string" && row.branch.length > 0) return true;
    // Conflict-resolution tasks are not step-attached; they still merge into the run branch.
    const conflictCol = db.query(
      "SELECT 1 AS ok FROM pragma_table_info('workflow_runs') WHERE name = 'conflict'",
    ).get();
    if (!conflictCol) return false;
    const marker = db.query<{ conflict: string | null }, [string]>(
      `SELECT conflict FROM workflow_runs
       WHERE conflict IS NOT NULL
         AND json_extract(conflict, '$.resolutionTaskId') = ?
       LIMIT 1`,
    ).get(taskId);
    return typeof marker?.conflict === "string" && marker.conflict.length > 0;
  } catch (error) {
    const msg = String(error);
    if (/no such table/i.test(msg) || /no such column/i.test(msg)) return false;
    throw error;
  }
}

/** Running step rows without a task id, oldest first: the orphans (a crash between
 *  writing the row and attaching the delegated task) that every tick reconciles. */
export function orphanSteps(ctx: Ctx): StepRow[] {
  return workflowDatabase(ctx).query<StepDbRow, []>("SELECT * FROM workflow_steps WHERE status = 'running' AND task_id IS NULL ORDER BY started_at").all().map(stepFromRow);
}

/** Attaches the delegated task id to a step row that was inserted before
 *  delegation (engine.ts startAgentStep/startFanout). */
export function attachStepTask(ctx: Ctx, key: StepKey, taskId: string): StepRow {
  const db = workflowDatabase(ctx);
  const where = stepWhere(key);
  const row = db.query<StepDbRow, SQLQueryBindings[]>(`SELECT * FROM workflow_steps WHERE ${where.sql}`).get(...where.bindings);
  if (!row) throw new CoreError("not_found", `unknown step ${key.stepId}#${key.attempt} of ${key.runId}`);
  db.query(`UPDATE workflow_steps SET task_id = ? WHERE ${where.sql}`).run(taskId, ...where.bindings);
  return stepFromRow({ ...row, task_id: taskId });
}

/** Finds an unarchived task by its delegation request id, newest first. Used to
 *  re-attach a step row that was written before its delegation completed. */
export function taskByRequestId(ctx: Ctx, requestId: string): TaskRecord | null {
  const row = taskDatabase(ctx).query<{ record: string }, [string]>(
    "SELECT record FROM tasks WHERE archived = 0 AND json_extract(record, '$.requestId') = ? ORDER BY created_at DESC LIMIT 1",
  ).get(requestId);
  return row ? (JSON.parse(row.record) as TaskRecord) : null;
}

export function getCursor(ctx: Ctx): number {
  const row = workflowDatabase(ctx).query<{ seq: number | null }, []>("SELECT seq FROM workflow_cursor WHERE id = 1").get();
  return row?.seq ?? 0;
}

export function setCursor(ctx: Ctx, seq: number): void {
  workflowDatabase(ctx).query("INSERT OR REPLACE INTO workflow_cursor(id, seq) VALUES (1, ?)").run(seq);
}

const DECISION_BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function newDecisionId(): string {
  const bytes = randomBytes(10);
  let id = "dec_";
  for (const byte of bytes) id += DECISION_BASE32[byte % 32];
  return id;
}

interface DecisionDbRow {
  id: string; run_id: string; step_id: string; attempt: number;
  actor: string; kind: string; choice: string; reason: string; at: number;
}

function decisionFromRow(row: DecisionDbRow): DecisionRow {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    actor: row.actor,
    kind: row.kind,
    choice: row.choice,
    reason: row.reason,
    at: row.at,
  };
}

/** Record a decision (or refused attempt) on a run. */
export function recordDecision(ctx: Ctx, d: {
  runId: string;
  stepId: string;
  attempt: number;
  actor: string;
  kind: string;
  choice: string;
  reason: string;
}): DecisionRow {
  const row: DecisionRow = {
    id: newDecisionId(),
    runId: d.runId,
    stepId: d.stepId,
    attempt: d.attempt,
    actor: d.actor,
    kind: d.kind,
    choice: d.choice,
    reason: d.reason,
    at: ctx.now,
  };
  workflowDatabase(ctx).query(
    "INSERT INTO workflow_decisions(id, run_id, step_id, attempt, actor, kind, choice, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.runId, row.stepId, row.attempt, row.actor, row.kind, row.choice, row.reason, row.at);
  return row;
}

export function listDecisions(ctx: Ctx, runId: string): DecisionRow[] {
  return workflowDatabase(ctx).query<DecisionDbRow, [string]>(
    "SELECT * FROM workflow_decisions WHERE run_id = ? ORDER BY at, rowid",
  ).all(runId).map(decisionFromRow);
}

export type GraphStatus = "proposed" | "approved" | "rejected" | "superseded";

export interface GraphRow {
  runId: string;
  stepId: string;
  attempt: number;
  version: number;
  def: WorkflowDef;
  status: GraphStatus;
  reason?: string;
  createdAt: number;
}

interface GraphDbRow {
  run_id: string;
  step_id: string;
  attempt: number;
  version: number;
  def: string;
  status: string;
  reason: string | null;
  created_at: number;
}

function graphFromRow(row: GraphDbRow): GraphRow {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    version: row.version,
    def: JSON.parse(row.def) as WorkflowDef,
    status: row.status as GraphStatus,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  };
}

export function listGraphs(ctx: Ctx, runId: string, stepId?: string): GraphRow[] {
  const db = workflowDatabase(ctx);
  if (stepId === undefined) {
    return db.query<GraphDbRow, [string]>(
      "SELECT * FROM workflow_graphs WHERE run_id = ? ORDER BY step_id, attempt, version",
    ).all(runId).map(graphFromRow);
  }
  return db.query<GraphDbRow, [string, string]>(
    "SELECT * FROM workflow_graphs WHERE run_id = ? AND step_id = ? ORDER BY attempt, version",
  ).all(runId, stepId).map(graphFromRow);
}

/** Insert a proposed graph version; any prior proposed/approved row for the same
 *  (run, step, attempt) becomes superseded. */
export function insertGraphVersion(ctx: Ctx, input: {
  runId: string;
  stepId: string;
  attempt: number;
  def: WorkflowDef;
  status?: GraphStatus;
  reason?: string;
}): GraphRow {
  const db = workflowDatabase(ctx);
  return db.transaction(() => {
    db.query(
      "UPDATE workflow_graphs SET status = 'superseded' WHERE run_id = ? AND step_id = ? AND attempt = ? AND status IN ('proposed', 'approved')",
    ).run(input.runId, input.stepId, input.attempt);
    const prior = db.query<{ version: number }, [string, string, number]>(
      "SELECT version FROM workflow_graphs WHERE run_id = ? AND step_id = ? AND attempt = ? ORDER BY version DESC LIMIT 1",
    ).get(input.runId, input.stepId, input.attempt);
    const version = (prior?.version ?? 0) + 1;
    const status = input.status ?? "proposed";
    db.query(
      "INSERT INTO workflow_graphs(run_id, step_id, attempt, version, def, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.runId, input.stepId, input.attempt, version, JSON.stringify(input.def), status, input.reason ?? null, ctx.now);
    return {
      runId: input.runId,
      stepId: input.stepId,
      attempt: input.attempt,
      version,
      def: input.def,
      status,
      reason: input.reason,
      createdAt: ctx.now,
    };
  })();
}

/** Update one graph version's status (and optional reason). */
export function setGraphStatus(
  ctx: Ctx,
  key: { runId: string; stepId: string; attempt: number; version: number },
  status: GraphStatus,
  reason?: string,
): GraphRow {
  const db = workflowDatabase(ctx);
  const row = db.query<GraphDbRow, [string, string, number, number]>(
    "SELECT * FROM workflow_graphs WHERE run_id = ? AND step_id = ? AND attempt = ? AND version = ?",
  ).get(key.runId, key.stepId, key.attempt, key.version);
  if (!row) throw new CoreError("not_found", `unknown graph ${key.runId}/${key.stepId}#${key.attempt}@${key.version}`);
  db.query(
    "UPDATE workflow_graphs SET status = ?, reason = ? WHERE run_id = ? AND step_id = ? AND attempt = ? AND version = ?",
  ).run(status, reason ?? row.reason, key.runId, key.stepId, key.attempt, key.version);
  return graphFromRow({ ...row, status, reason: reason ?? row.reason });
}

export function getGraph(
  ctx: Ctx,
  key: { runId: string; stepId: string; attempt: number; version: number },
): GraphRow | null {
  const row = workflowDatabase(ctx).query<GraphDbRow, [string, string, number, number]>(
    "SELECT * FROM workflow_graphs WHERE run_id = ? AND step_id = ? AND attempt = ? AND version = ?",
  ).get(key.runId, key.stepId, key.attempt, key.version);
  return row ? graphFromRow(row) : null;
}
