// Run and step persistence, in the existing task store (ARCH-16): the workflow tables
// are created once per connection by a guard, the same pattern dispatchDatabase uses.
// Definitions are immutable per version; run updates go through expect_rev.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { readTask, taskDatabase } from "../tasks/store";
import { fanoutAttempt } from "./fanout";
export { fanoutAttempt };
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import type { WorkflowDef } from "./schema";
import type { RunPriority } from "./priority";
import { nextLetter, resolveRunLetters } from "./letters";
import type { PausedReason } from "./pacing";

// The connection is cached by taskDatabase; schema setup must therefore also run once
// per connection, not per call (see dispatch/store.ts for the same guard). Apply the
// whole DDL in one immediate transaction so a concurrent reader (or a test that copies
// tasks.db + WAL mid-startup) never observes a partial workflow schema — phase 2 added
// many CREATE/ALTER steps after the original tables, which made that window flake
// native/forwarded parity (workflow_decisions appearing on only one side).
let ready = new WeakSet<Database>();
/** Test-only: forget schema-init so the next `workflowDatabase` re-runs DDL/migrations. */
export function resetWorkflowSchemaReadyForTests(): void {
  ready = new WeakSet();
}
export function workflowDatabase(ctx: Ctx): Database {
  const db = taskDatabase(ctx);
  if (ready.has(db)) return db;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_defs(id TEXT, version INTEGER, source TEXT, def TEXT, added_at REAL, PRIMARY KEY(id, version));
      CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT, status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL);
      CREATE TABLE IF NOT EXISTS workflow_steps(run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT, task_id TEXT UNIQUE, status TEXT, result TEXT, error TEXT, started_at REAL, ended_at REAL, PRIMARY KEY(run_id, step_id, attempt, branch));
      CREATE TABLE IF NOT EXISTS workflow_cursor(id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER);
      CREATE TABLE IF NOT EXISTS workflow_live_answers(message_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, question_id TEXT NOT NULL, UNIQUE(turn_id, question_id));
      CREATE TABLE IF NOT EXISTS workflow_live_closed(turn_id TEXT PRIMARY KEY);
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
    // Phase 5 fix I1/R2-F3: durable unresolved conflict marker(s) as a JSON list.
    if (!runColumns.includes("conflict")) db.exec("ALTER TABLE workflow_runs ADD COLUMN conflict TEXT");
    // Idempotent object→list migration for rows written before R2-F3.
    db.exec(`
      UPDATE workflow_runs
      SET conflict = json_array(json(conflict))
      WHERE conflict IS NOT NULL
        AND json_valid(conflict)
        AND json_type(conflict) = 'object'
    `);
    // Phase 6: run priority and pause reason (inside the same atomic schema transaction).
    if (!runColumns.includes("priority")) db.exec("ALTER TABLE workflow_runs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
    if (!runColumns.includes("paused_reason")) db.exec("ALTER TABLE workflow_runs ADD COLUMN paused_reason TEXT");
    // Phase 6: since-you-last-looked (last_seen_at + summary).
    if (!runColumns.includes("last_seen_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN last_seen_at REAL");
    if (!runColumns.includes("summary")) db.exec("ALTER TABLE workflow_runs ADD COLUMN summary TEXT");
    if (!runColumns.includes("summary_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN summary_at REAL");
    // Phase 6: last meaningful change (step/run status, answers, questions, person actions).
    // Orchestrator bookkeeping and summary writes do not bump this stamp.
    if (!runColumns.includes("meaningful_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN meaningful_at REAL");
    // Phase 6: stable run letter (A–Z, AA…) for clients; assigned at insert / schema migration.
    if (!runColumns.includes("letter")) db.exec("ALTER TABLE workflow_runs ADD COLUMN letter TEXT");
    // Phase 6 batch F: startRun holds entry ownership until this deadline so the tick
    // cannot race a fresh entry (or seedFinished) start; expired leases are recovered.
    if (!runColumns.includes("entry_lease_until")) db.exec("ALTER TABLE workflow_runs ADD COLUMN entry_lease_until REAL");
    // Phase 6 batch G: atomic claim owner token; clear/renew only when owner matches.
    if (!runColumns.includes("entry_owner")) db.exec("ALTER TABLE workflow_runs ADD COLUMN entry_owner TEXT");
    // Phase 6 batch G: durable seedFinished payload written in the same txn as insertRun.
    if (!runColumns.includes("entry_seed")) db.exec("ALTER TABLE workflow_runs ADD COLUMN entry_seed TEXT");
    // Phase 6 batch G: durable transient entry-start attempt count (survives restarts).
    if (!runColumns.includes("entry_start_attempts")) db.exec("ALTER TABLE workflow_runs ADD COLUMN entry_start_attempts INTEGER NOT NULL DEFAULT 0");
    // Phase 6 batch H: wall-clock of the first transient entry-start failure (time-based bound).
    if (!runColumns.includes("entry_first_transient_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN entry_first_transient_at REAL");
    // Phase 6 batch I: wall-clock of the most recent transient entry-start failure (gap restart).
    if (!runColumns.includes("entry_last_transient_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN entry_last_transient_at REAL");
    // Notification ownership: `human` or the caller participant id
    // (`external:<kind>[:<session>]` or `unknown:<caller id>`). A NULL origin marks
    // a pre-upgrade run and is treated as human-owned at read time; new runs always
    // record an origin (human, external:..., or unknown:<caller id>). Never backfill.
    if (!runColumns.includes("origin")) db.exec("ALTER TABLE workflow_runs ADD COLUMN origin TEXT");
    // Backfill letters for live letterless rows inside this write transaction only (never on read).
    // Used set includes ALL existing letters (terminal rows too) so the unique index cannot throw.
    {
      const allRows = db.query<{ id: string; letter: string | null; created_at: number; status: string }, []>(
        "SELECT id, letter, created_at, status FROM workflow_runs ORDER BY created_at, id",
      ).all();
      const liveLetterless = allRows.filter(r =>
        (r.status === "running" || r.status === "waiting") && (!r.letter || r.letter === ""),
      );
      if (liveLetterless.length > 0) {
        const seed = allRows
          .filter(r => r.letter && r.letter !== "")
          .map(r => ({ id: r.id, letter: r.letter!, createdAt: r.created_at }));
        const resolved = resolveRunLetters([
          ...seed,
          ...liveLetterless.map(r => ({ id: r.id, letter: undefined, createdAt: r.created_at })),
        ]);
        for (const row of liveLetterless) {
          const letter = resolved.get(row.id);
          if (!letter) continue;
          db.query("UPDATE workflow_runs SET letter = ? WHERE id = ? AND (letter IS NULL OR letter = '')")
            .run(letter, row.id);
        }
      }
    }
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_letter ON workflow_runs(letter) WHERE letter IS NOT NULL AND letter != ''");
    } catch { /* older SQLite / conflict during migrate */ }
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
    // Phase 4: structured questions (one thread = one record).
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_questions(
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        branch TEXT,
        asker_task_id TEXT,
        asker_kind TEXT NOT NULL,
        text TEXT NOT NULL,
        answer_type TEXT NOT NULL,
        options TEXT,
        recommended TEXT,
        blocks TEXT NOT NULL,
        artifact TEXT,
        answerer TEXT NOT NULL,
        chain TEXT NOT NULL,
        suggested TEXT,
        answer TEXT,
        answered_by TEXT,
        status TEXT NOT NULL,
        rev INTEGER NOT NULL,
        created_at REAL NOT NULL,
        answered_at REAL
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS workflow_questions_run ON workflow_questions(run_id, created_at, id)");
    db.exec("CREATE INDEX IF NOT EXISTS workflow_questions_open ON workflow_questions(run_id) WHERE status = 'open'");
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
    // Phase 7: plugin-originated definitions, disable flag, and stored prompt files.
    const defColumns = db.query<{ name: string }, []>("PRAGMA table_info(workflow_defs)").all().map(c => c.name);
    if (!defColumns.includes("origin")) db.exec("ALTER TABLE workflow_defs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
    if (!defColumns.includes("disabled")) db.exec("ALTER TABLE workflow_defs ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
    // Distinct from plugin-live `disabled`: survives sync/reconcile clearing disabled.
    if (!defColumns.includes("invalid")) db.exec("ALTER TABLE workflow_defs ADD COLUMN invalid INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_prompts(
        def_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        path TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY(def_id, version, path)
      );
    `);
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
  /**
   * Phase 5: durable unresolved merge conflict entries (publish gate).
   * Cleared per entry only after the conflicting branch is an ancestor of the run branch.
   */
  conflict?: RunConflict[];
  /** Phase 6: urgent | normal | background (default normal). */
  priority?: RunPriority;
  /** Phase 6: why the run is paused (pacing / person / budget), if any. */
  pausedReason?: PausedReason;
  /** Phase 6: when the person last opened the run (run.seen). */
  lastSeenAt?: number;
  /** Phase 6: since-you-last-looked summary text (≤ 4 KiB). */
  summary?: string;
  /** Phase 6: when the summary was written. */
  summaryAt?: number;
  /**
   * Phase 6: last meaningful change for since-you-last-looked wake-ups.
   * Step/run status, answers, questions, conflicts, person actions bump this;
   * orchestrator bookkeeping and summary writes do not.
   */
  meaningfulAt?: number;
  /** Phase 6: stable client letter (A–Z, AA…). */
  letter?: string;
  /**
   * Phase 6 batch F/G: unix seconds until which the entry_owner exclusively owns
   * entry start. Claimed atomically; the tick skips while this is in the future.
   */
  entryLeaseUntil?: number;
  /** Phase 6 batch G: opaque owner token for the entry lease (claim/renew/clear). */
  entryOwner?: string;
  /**
   * Phase 6 batch G: durable seedFinished payload (JSON) written with insertRun.
   * Recovery resumes from this seed instead of a fresh def.entry; cleared once applied.
   */
  entrySeed?: { finishedIds: string[]; results: Record<string, unknown> };
  /** Phase 6 batch G: durable count of transient entry-start failures. */
  entryStartAttempts?: number;
  /** Phase 6 batch H: unix seconds of the first durable transient entry-start failure. */
  entryFirstTransientAt?: number;
  /** Phase 6 batch I: unix seconds of the most recent durable transient entry-start failure. */
  entryLastTransientAt?: number;
  /** Notification owner at start: `human` or `external:<kind>[:<session>]`. NULL = not human-owned. */
  origin?: string;
}

/** How long an entry-start owner holds exclusive ownership after claim/renew (seconds). */
export const ENTRY_LEASE_S = 30;

/**
 * Effective entry-lease length. Prefer `ctx.entryLeaseS` (tests / harness boot override);
 * production stays at ENTRY_LEASE_S. Never reads files under $PACER_HOME.
 */
export function entryLeaseSeconds(ctx: Ctx): number {
  const n = ctx.entryLeaseS;
  if (typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 120) return n;
  return ENTRY_LEASE_S;
}

/**
 * Optional startRun fault delay (ms). Prefer `ctx.startRunDelayMs` (tests / harness);
 * production is always 0. Never reads files under $PACER_HOME.
 */
export function startRunDelayMs(ctx: Ctx): number {
  const n = ctx.startRunDelayMs;
  if (typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 120_000) return Math.floor(n);
  return 0;
}

/**
 * Minimum wall-clock seconds of durable transient entry-start failures before failRun.
 * Attempt count alone is not enough: BUSY_SNAPSHOT-style errors return immediately, so
 * a writer held for tens of seconds would burn a pure attempt budget too fast.
 */
export const ENTRY_START_TRANSIENT_MIN_S = 5 * 60;

/**
 * Gap (seconds) since the last transient after which the durable window restarts
 * (batch I: a lone BUSY blip must not fail a healthy run hours later).
 */
export const ENTRY_START_TRANSIENT_GAP_S = 60;

/**
 * Secondary attempt cap for durable transient entry-start failures.
 * Time is always primary: sized for a 500 ms pump floor × window × 2 so a short tick
 * cannot exhaust the cap before ENTRY_START_TRANSIENT_MIN_S elapses (batch I).
 */
export const ENTRY_START_TRANSIENT_MAX = Math.ceil(ENTRY_START_TRANSIENT_MIN_S / 0.5) * 2;

/**
 * Live unix seconds for entry-lease deadlines and expiry checks.
 * Prefer `ctx.clock` (tests bind it to mutable `ctx.now`); production falls back to
 * `Date.now()/1000` so a request-scoped `ctx.now` snapshot cannot freeze renewals.
 */
export function leaseNow(ctx: Ctx): number {
  return ctx.clock?.() ?? Date.now() / 1000;
}

/** Opaque entry-lease owner token (hex). */
export function newEntryOwner(): string {
  return randomBytes(16).toString("hex");
}

/** One durable run-level merge conflict entry (not derived from resolution-task state). */
export type RunConflict = {
  taskId: string;
  branch: string;
  resolutionTaskId: string;
  /** Whether a step still held the task when the merge conflicted (unset on
   *  markers stored before this was recorded: treated as held). */
  live?: boolean;
};

function isConflictEntry(value: unknown): value is RunConflict {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.taskId === "string" && typeof e.branch === "string"
    && typeof e.resolutionTaskId === "string";
}

/**
 * Parse stored conflict JSON: a list, or a legacy single object (pre R2-F3).
 * M4 fail-closed: malformed / non-entry JSON is treated as one unresolved sentinel
 * so the publish gate stays closed (never opens on garbage).
 */
export function parseRunConflicts(raw: string | null | undefined): RunConflict[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length === 0) return undefined;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const entries = list.filter(isConflictEntry);
    if (entries.length > 0) return entries;
    // Valid JSON but no recognizable entries (e.g. `{}`, `[null]`, `"x"`): still unresolved.
    return [{
      taskId: "__malformed__",
      branch: "__malformed__",
      resolutionTaskId: "__malformed__",
    }];
  } catch {
    // Unparseable: fail closed — publish must not proceed.
    return [{
      taskId: "__malformed__",
      branch: "__malformed__",
      resolutionTaskId: "__malformed__",
    }];
  }
}

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
  /** Phase 6 run priority (default normal). */
  priority?: RunPriority;
  /** Person/pacing pause to stamp at insert (e.g. inherit parent person pause). */
  pausedReason?: PausedReason;
  /** Exclusive entry-start lease deadline (unix seconds). */
  entryLeaseUntil?: number;
  /** Owner token paired with entryLeaseUntil. */
  entryOwner?: string;
  /** Durable seedFinished written atomically with the run row. */
  entrySeed?: { finishedIds: string[]; results: Record<string, unknown> };
  /** Notification owner; children inherit the root's value in startRun. */
  origin?: string;
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

interface DefRow {
  id: string; version: number; source: string; def: string; added_at: number;
  origin?: string | null; disabled?: number | null; invalid?: number | null;
}
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
  priority?: string | null;
  paused_reason?: string | null;
  last_seen_at?: number | null;
  summary?: string | null;
  summary_at?: number | null;
  meaningful_at?: number | null;
  letter?: string | null;
  entry_lease_until?: number | null;
  entry_owner?: string | null;
  entry_seed?: string | null;
  entry_start_attempts?: number | null;
  entry_first_transient_at?: number | null;
  entry_last_transient_at?: number | null;
  origin?: string | null;
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
  const conflicts = parseRunConflicts(row.conflict);
  if (conflicts) out.conflict = conflicts;
  if (row.priority === "urgent" || row.priority === "background" || row.priority === "normal") {
    out.priority = row.priority;
  } else {
    out.priority = "normal";
  }
  if (
    row.paused_reason === "pacing: strict"
    || row.paused_reason === "pacing: emergency"
    || row.paused_reason === "budget"
    || row.paused_reason === "person"
  ) {
    out.pausedReason = row.paused_reason;
  }
  if (row.last_seen_at != null) out.lastSeenAt = row.last_seen_at;
  if (row.summary) out.summary = row.summary;
  if (row.summary_at != null) out.summaryAt = row.summary_at;
  if (row.meaningful_at != null) out.meaningfulAt = row.meaningful_at;
  else out.meaningfulAt = row.updated_at;
  if (row.letter) out.letter = row.letter;
  if (row.entry_lease_until != null) out.entryLeaseUntil = row.entry_lease_until;
  if (row.entry_owner) out.entryOwner = row.entry_owner;
  if (row.entry_seed) {
    try {
      const parsed = JSON.parse(row.entry_seed) as { finishedIds?: unknown; results?: unknown };
      if (Array.isArray(parsed.finishedIds) && parsed.results && typeof parsed.results === "object") {
        out.entrySeed = {
          finishedIds: parsed.finishedIds.filter((id): id is string => typeof id === "string"),
          results: parsed.results as Record<string, unknown>,
        };
      }
    } catch { /* ignore bad seed JSON */ }
  }
  if (row.entry_start_attempts != null && row.entry_start_attempts > 0) {
    out.entryStartAttempts = row.entry_start_attempts;
  }
  if (row.entry_first_transient_at != null) {
    out.entryFirstTransientAt = row.entry_first_transient_at;
  }
  if (row.entry_last_transient_at != null) {
    out.entryLastTransientAt = row.entry_last_transient_at;
  }
  if (row.origin) out.origin = row.origin;
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

/** Stored prompts for a definition version, keyed by path. */
export function listDefinitionPrompts(ctx: Ctx, defId: string, version: number): Record<string, string> {
  const rows = workflowDatabase(ctx).query<{ path: string; text: string }, [string, number]>(
    "SELECT path, text FROM workflow_prompts WHERE def_id = ? AND version = ?",
  ).all(defId, version);
  const out: Record<string, string> = {};
  for (const row of rows) out[row.path] = row.text;
  return out;
}

function promptsEqual(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  const left = a ?? {};
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(b);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(b, key) || left[key] !== b[key]) return false;
  }
  return true;
}

/** Stores a definition version. The same id@version with the same source and prompts is a no-op;
 * with a different source or prompts it is a conflict (or skipped when allowSourceMismatch).
 * Hand-added definitions get `origin = manual`. When `supersede` is set, an existing row is
 * replaced in place (plugin upgrade delivering a fixed source for the same id@version),
 * unless a non-terminal run is pinned to that version (refused as `pinned_runs`). */
export function addDefinition(
  ctx: Ctx, def: WorkflowDef, source: string,
  opts: {
    origin?: string;
    prompts?: Record<string, string>;
    allowSourceMismatch?: boolean;
    supersede?: boolean;
  } = {},
): { id: string; version: number; created: boolean; skipped?: "source_mismatch" | "pinned_runs"; superseded?: boolean } {
  const db = workflowDatabase(ctx);
  const origin = opts.origin ?? "manual";
  const existing = db.query<DefRow, [string, number]>("SELECT * FROM workflow_defs WHERE id = ? AND version = ?").get(def.id, def.version);
  if (existing) {
    const existingPrompts = listDefinitionPrompts(ctx, def.id, def.version);
    // When prompts are supplied (plugin sync), both source and prompts must match.
    // Manual adds omit prompts and keep the prior source-only comparison.
    const same = existing.source === source
      && (opts.prompts === undefined || promptsEqual(opts.prompts, existingPrompts));
    if (!same) {
      if (opts.supersede) {
        const pinned = db.query<{ n: number }, [string, number]>(
          "SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow = ? AND version = ? AND status IN ('running', 'waiting')",
        ).get(def.id, def.version);
        if (pinned && pinned.n > 0) {
          return { id: def.id, version: def.version, created: false, skipped: "pinned_runs" };
        }
        db.transaction(() => {
          db.query(
            "UPDATE workflow_defs SET source = ?, def = ?, origin = ?, disabled = 0, invalid = 0, added_at = ? WHERE id = ? AND version = ?",
          ).run(source, JSON.stringify(def), origin, ctx.now, def.id, def.version);
          if (opts.prompts) replaceDefinitionPrompts(db, def.id, def.version, opts.prompts);
          else db.query("DELETE FROM workflow_prompts WHERE def_id = ? AND version = ?").run(def.id, def.version);
        })();
        return { id: def.id, version: def.version, created: false, superseded: true };
      }
      if (opts.allowSourceMismatch) return { id: def.id, version: def.version, created: false, skipped: "source_mismatch" };
      throw new CoreError("conflict", `conflict: definition ${def.id}@${def.version} already exists with a different source`);
    }
    return { id: def.id, version: def.version, created: false };
  }
  db.transaction(() => {
    db.query("INSERT INTO workflow_defs(id, version, source, def, added_at, origin, disabled, invalid) VALUES (?, ?, ?, ?, ?, ?, 0, 0)")
      .run(def.id, def.version, source, JSON.stringify(def), ctx.now, origin);
    if (opts.prompts) replaceDefinitionPrompts(db, def.id, def.version, opts.prompts);
  })();
  return { id: def.id, version: def.version, created: true };
}

function replaceDefinitionPrompts(db: Database, defId: string, version: number, prompts: Record<string, string>): void {
  db.query("DELETE FROM workflow_prompts WHERE def_id = ? AND version = ?").run(defId, version);
  const insert = db.query("INSERT INTO workflow_prompts(def_id, version, path, text) VALUES (?, ?, ?, ?)");
  for (const [path, text] of Object.entries(prompts)) insert.run(defId, version, path, text);
}

/** Looks up a stored prompt file for a definition version; null when absent or inline. */
export function getDefinitionPrompt(ctx: Ctx, defId: string, version: number, path: string): string | null {
  const row = workflowDatabase(ctx).query<{ text: string }, [string, number, string]>(
    "SELECT text FROM workflow_prompts WHERE def_id = ? AND version = ? AND path = ?",
  ).get(defId, version, path);
  return row?.text ?? null;
}

/** Resolve a step prompt: stored `prompt:` path text when present, otherwise the inline value. */
export function resolveWorkflowPrompt(ctx: Ctx, defId: string, version: number, prompt: string): string {
  return getDefinitionPrompt(ctx, defId, version, prompt) ?? prompt;
}

export type DefinitionMeta = {
  id: string; version: number; title?: string; addedAt: number;
  origin: string; disabled: boolean; invalid: boolean;
};

function defRowMeta(row: DefRow): DefinitionMeta {
  const def = JSON.parse(row.def) as WorkflowDef;
  const entry: DefinitionMeta = {
    id: row.id, version: row.version, addedAt: row.added_at,
    origin: row.origin ?? "manual", disabled: (row.disabled ?? 0) !== 0,
    invalid: (row.invalid ?? 0) !== 0,
  };
  return def.title === undefined ? entry : { ...entry, title: def.title };
}

/** Looks up `id@N`, or the latest version of `id`. Disabled definitions still resolve (pinned runs). */
export function getDefinition(ctx: Ctx, ref: string): WorkflowDef | null {
  const row = getDefinitionRow(ctx, ref);
  return row ? (JSON.parse(row.def) as WorkflowDef) : null;
}

export function getDefinitionRow(ctx: Ctx, ref: string): DefRow | null {
  const db = workflowDatabase(ctx);
  const at = ref.lastIndexOf("@");
  if (at > 0) {
    const version = Number(ref.slice(at + 1));
    if (Number.isInteger(version)) {
      return db.query<DefRow, [string, number]>("SELECT * FROM workflow_defs WHERE id = ? AND version = ?").get(ref.slice(0, at), version) ?? null;
    }
  }
  return db.query<DefRow, [string]>("SELECT * FROM workflow_defs WHERE id = ? ORDER BY version DESC LIMIT 1").get(ref) ?? null;
}

export function isDefinitionDisabled(ctx: Ctx, ref: string): boolean {
  const row = getDefinitionRow(ctx, ref);
  return row ? (row.disabled ?? 0) !== 0 : false;
}

export function isDefinitionInvalid(ctx: Ctx, ref: string): boolean {
  const row = getDefinitionRow(ctx, ref);
  return row ? (row.invalid ?? 0) !== 0 : false;
}

/** Mark one definition version as schema-invalid (distinct from plugin-live disabled). */
export function setDefinitionInvalid(ctx: Ctx, id: string, version: number, invalid: boolean): void {
  workflowDatabase(ctx).query(
    "UPDATE workflow_defs SET invalid = ? WHERE id = ? AND version = ?",
  ).run(invalid ? 1 : 0, id, version);
}

/**
 * Mark every definition whose origin is `plugin:<id>@…` as disabled (or clear the flag).
 * Writes only when at least one row would change; returns whether a write ran.
 * Never clears the `invalid` marker — that is independent of plugin liveness.
 */
export function setPluginDefinitionsDisabled(ctx: Ctx, pluginId: string, disabled: boolean): boolean {
  const db = workflowDatabase(ctx);
  const prefix = `plugin:${pluginId}@`;
  const want = disabled ? 1 : 0;
  const pending = db.query<{ n: number }, [string, number]>(
    "SELECT COUNT(*) AS n FROM workflow_defs WHERE origin LIKE ? AND disabled != ?",
  ).get(`${prefix}%`, want);
  if (!pending || pending.n === 0) return false;
  db.query("UPDATE workflow_defs SET disabled = ? WHERE origin LIKE ? AND disabled != ?")
    .run(want, `${prefix}%`, want);
  return true;
}

export function listDefinitions(ctx: Ctx): DefinitionMeta[] {
  const db = workflowDatabase(ctx);
  return db.query<DefRow, []>("SELECT * FROM workflow_defs ORDER BY id, version").all().map(defRowMeta);
}

export function insertRun(ctx: Ctx, r: NewRun): RunRow {
  const db = workflowDatabase(ctx);
  // Immediate txn: re-check parent person pause + write seed/lease with the row (M3/B2).
  return db.transaction(() => {
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
    row.priority = r.priority ?? "normal";
    // M3: re-read parent inside this txn so a pause between caller read and insert is seen.
    let pausedReason = r.pausedReason;
    if (r.parentRunId) {
      const parent = getRun(ctx, r.parentRunId);
      if (parent?.pausedReason === "person") pausedReason = "person";
    }
    if (pausedReason) row.pausedReason = pausedReason;
    if (r.entryLeaseUntil != null) row.entryLeaseUntil = r.entryLeaseUntil;
    if (r.entryOwner) row.entryOwner = r.entryOwner;
    if (r.entrySeed && r.entrySeed.finishedIds.length > 0) row.entrySeed = r.entrySeed;
    if (r.origin) row.origin = r.origin;
    row.meaningfulAt = ctx.now;
    const seedJson = row.entrySeed ? JSON.stringify(row.entrySeed) : null;
    const used = db.query<{ letter: string | null }, []>("SELECT letter FROM workflow_runs WHERE letter IS NOT NULL AND letter != ''")
      .all()
      .map(x => x.letter!)
      .filter(Boolean);
    // Retry letter assignment on unique-index races across processes.
    for (let attempt = 0; ; attempt++) {
      const letter = nextLetter(used);
      row.letter = letter;
      try {
        db.query(
          "INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at, parent_run_id, parent_step, planner, orchestrator_task_id, session_id, budget, spent, step_mode, root_task_id, priority, paused_reason, letter, meaningful_at, entry_lease_until, entry_owner, entry_seed, entry_start_attempts, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          row.id, row.workflow, row.version, row.repo, row.brief, row.title, row.status, null,
          JSON.stringify(row.loops), row.rev, row.createdAt, row.updatedAt,
          row.parentRunId ?? null, row.parentStep ?? null,
          row.planner ?? null, row.orchestratorTaskId ?? null, row.sessionId ?? null,
          row.budget ?? null, row.spent ?? null,
          row.stepMode, row.rootTaskId ?? null,
          row.priority, row.pausedReason ?? null, row.letter, row.meaningfulAt,
          row.entryLeaseUntil ?? null, row.entryOwner ?? null, seedJson, 0,
          row.origin ?? null,
        );
        return row;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE|unique|constraint/i.test(msg) || attempt >= 8) throw err;
        used.push(letter);
      }
    }
  }).immediate();
}

/**
 * Atomically claim or renew exclusive entry-start ownership in ONE UPDATE.
 * Succeeds only when the run is live and (lease free/expired OR same owner).
 * Returns true iff changes === 1.
 * Optional `db` lets a second SQLite connection on the same file call the same
 * claim (batch H concurrency tests) without retyping the SQL.
 */
export function claimEntryLease(
  ctx: Ctx,
  runId: string,
  owner: string,
  until: number,
  now: number,
  db?: Database,
): boolean {
  if (!runId || !owner) return false;
  const handle = db ?? workflowDatabase(ctx);
  const result = handle.transaction(() => handle.query(
    `UPDATE workflow_runs
     SET entry_lease_until = ?, entry_owner = ?
     WHERE id = ?
       AND status IN ('running', 'waiting')
       AND (
         entry_owner = ?
         OR entry_lease_until IS NULL
         OR entry_lease_until <= ?
       )`,
  ).run(until, owner, runId, owner, now)).immediate();
  return result.changes === 1;
}

/**
 * Clear the entry-ownership lease without bumping `rev` and without publishing
 * (I3: intentional — other writers' cached expect_rev stays valid). Only clears
 * when `owner` matches (or when owner is omitted for legacy/test cleanup).
 * Retries a bounded number of times on SQLITE_BUSY and logs a diagnostic (I2).
 */
export function clearEntryLease(ctx: Ctx, runId: string, owner?: string): void {
  const maxTries = 4;
  let lastErr: unknown;
  for (let i = 0; i < maxTries; i++) {
    try {
      const db = workflowDatabase(ctx);
      if (owner) {
        db.query(
          "UPDATE workflow_runs SET entry_lease_until = NULL, entry_owner = NULL WHERE id = ? AND entry_owner = ?",
        ).run(runId, owner);
      } else {
        db.query(
          "UPDATE workflow_runs SET entry_lease_until = NULL, entry_owner = NULL WHERE id = ?",
        ).run(runId);
      }
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/locked|BUSY|busy/i.test(msg) || i === maxTries - 1) break;
    }
  }
  if (lastErr) {
    console.warn(
      `pacer: clearEntryLease failed for ${runId} after ${maxTries} tries: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }
}

/**
 * Clear durable entry seed after it has been applied (no rev bump).
 * Retries a bounded number of times on SQLITE_BUSY and logs a diagnostic (like clearEntryLease).
 */
export function clearEntrySeed(ctx: Ctx, runId: string): void {
  const maxTries = 4;
  let lastErr: unknown;
  for (let i = 0; i < maxTries; i++) {
    try {
      workflowDatabase(ctx).query(
        "UPDATE workflow_runs SET entry_seed = NULL WHERE id = ?",
      ).run(runId);
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/locked|BUSY|busy/i.test(msg) || i === maxTries - 1) break;
    }
  }
  if (lastErr) {
    console.warn(
      `pacer: clearEntrySeed failed for ${runId} after ${maxTries} tries: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }
}

/**
 * Record one durable transient entry-start failure: bump attempts, stamp
 * `entry_first_transient_at` / `entry_last_transient_at`, and restart the window
 * when the gap since the last transient exceeds ENTRY_START_TRANSIENT_GAP_S (batch I).
 */
export function bumpEntryStartAttempts(
  ctx: Ctx,
  runId: string,
  now: number = leaseNow(ctx),
): { attempts: number; firstAt: number; lastAt: number; restarted: boolean } {
  const db = workflowDatabase(ctx);
  let restarted = false;
  db.transaction(() => {
    const prev = db.query<{
      entry_start_attempts: number | null;
      entry_first_transient_at: number | null;
      entry_last_transient_at: number | null;
    }, [string]>(
      "SELECT entry_start_attempts, entry_first_transient_at, entry_last_transient_at FROM workflow_runs WHERE id = ?",
    ).get(runId);
    const lastAt = prev?.entry_last_transient_at ?? null;
    const gapRestart = lastAt != null && (now - lastAt) > ENTRY_START_TRANSIENT_GAP_S;
    if (gapRestart || prev?.entry_first_transient_at == null) {
      restarted = gapRestart;
      db.query(
        `UPDATE workflow_runs
         SET entry_start_attempts = 1,
             entry_first_transient_at = ?,
             entry_last_transient_at = ?
         WHERE id = ?`,
      ).run(now, now, runId);
    } else {
      db.query(
        `UPDATE workflow_runs
         SET entry_start_attempts = COALESCE(entry_start_attempts, 0) + 1,
             entry_last_transient_at = ?
         WHERE id = ?`,
      ).run(now, runId);
    }
  }).immediate();
  const row = db.query<{
    entry_start_attempts: number;
    entry_first_transient_at: number | null;
    entry_last_transient_at: number | null;
  }, [string]>(
    "SELECT entry_start_attempts, entry_first_transient_at, entry_last_transient_at FROM workflow_runs WHERE id = ?",
  ).get(runId);
  const attempts = row?.entry_start_attempts ?? 0;
  const firstAt = row?.entry_first_transient_at ?? now;
  const lastAt = row?.entry_last_transient_at ?? now;
  return { attempts, firstAt, lastAt, restarted };
}

/** Reset transient entry-start budget after a successful start (or pause skip). */
export function resetEntryStartAttempts(ctx: Ctx, runId: string): void {
  try {
    workflowDatabase(ctx).query(
      "UPDATE workflow_runs SET entry_start_attempts = 0, entry_first_transient_at = NULL, entry_last_transient_at = NULL WHERE id = ?",
    ).run(runId);
  } catch { /* */ }
}

/**
 * Live runs that still need entry started or a durable seed applied: unpaused
 * (or budget-only), no step rows (or pending entry_seed), and no active entry
 * lease. Optional `rootRunId` limits to that run and its live descendants
 * (run.resume). One SQL filter — no per-run step scans.
 */
export function liveRunsNeedingEntry(
  ctx: Ctx,
  opts: { rootRunId?: string; now?: number } = {},
): RunRow[] {
  const db = workflowDatabase(ctx);
  const now = opts.now ?? leaseNow(ctx);
  // Needs work when there are no steps yet, or a durable seed still awaits apply.
  const needClause = `(
         NOT EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id = r.id)
         OR (r.entry_seed IS NOT NULL AND r.entry_seed != '')
       )`;
  if (opts.rootRunId) {
    return db.query<RunDbRow, [string, number]>(
      `WITH RECURSIVE tree(id) AS (
         SELECT ?
         UNION ALL
         SELECT r.id FROM workflow_runs r
         JOIN tree t ON r.parent_run_id = t.id
         WHERE r.status IN ('running', 'waiting')
       )
       SELECT r.* FROM workflow_runs r
       JOIN tree ON tree.id = r.id
       WHERE r.status IN ('running', 'waiting')
         AND (r.paused_reason IS NULL OR r.paused_reason = '' OR r.paused_reason = 'budget')
         AND (r.entry_lease_until IS NULL OR r.entry_lease_until <= ?)
         AND ${needClause}
       ORDER BY r.created_at, r.id`,
    ).all(opts.rootRunId, now).map(runFromRow);
  }
  return db.query<RunDbRow, [number]>(
    `SELECT r.* FROM workflow_runs r
     WHERE r.status IN ('running', 'waiting')
       AND (r.paused_reason IS NULL OR r.paused_reason = '' OR r.paused_reason = 'budget')
       AND (r.entry_lease_until IS NULL OR r.entry_lease_until <= ?)
       AND ${needClause}
     ORDER BY r.created_at, r.id`,
  ).all(now).map(runFromRow);
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

/** True when `run` is the child a `generate` step started under `parent`. */
function isGeneratedChild(ctx: Ctx, run: RunRow, parent: RunRow): boolean {
  if (!run.parentStep) return false;
  const def = getDefinition(ctx, `${parent.workflow}@${parent.version}`) ?? getDefinition(ctx, parent.workflow);
  return def?.steps[run.parentStep]?.type === "generate";
}

/** The run that owns `run`'s run branch. A generated child works on its parent's
 *  branch, so the parent's publish steps see the code; a top-level or
 *  `choose_workflow` run owns its own (it has its own publish steps). A generated
 *  child that already has a branch (started before this rule) keeps it until the
 *  branch is handed to the owner (`adoptGeneratedBranches`). */
export function branchOwner(ctx: Ctx, run: RunRow): RunRow {
  let current = getRun(ctx, run.id) ?? run;
  while (current.parentRunId && !current.branch) {
    const parent = getRun(ctx, current.parentRunId);
    if (!parent || !isGeneratedChild(ctx, current, parent)) break;
    current = parent;
  }
  return current;
}

/** The runs a `generate` step of `parent` started, oldest first. */
export function generatedChildren(ctx: Ctx, parent: RunRow): RunRow[] {
  return workflowDatabase(ctx).query<{ id: string }, [string]>(
    "SELECT id FROM workflow_runs WHERE parent_run_id = ? ORDER BY created_at, id",
  ).all(parent.id)
    .map(({ id }) => getRun(ctx, id))
    .filter((child): child is RunRow => !!child && isGeneratedChild(ctx, child, parent));
}

/** Whether a `generate` step produced `run`, directly or through its parents. */
export function isGeneratedRun(ctx: Ctx, run: RunRow): boolean {
  let current: RunRow | null = run;
  while (current?.parentRunId) {
    const parent: RunRow | null = getRun(ctx, current.parentRunId);
    if (!parent) return false;
    if (isGeneratedChild(ctx, current, parent)) return true;
    current = parent;
  }
  return false;
}

/** `owner` plus every generated descendant: all runs whose steps share its branch. */
export function runsSharingBranch(ctx: Ctx, owner: RunRow): RunRow[] {
  const out: RunRow[] = [owner];
  for (let i = 0; i < out.length; i++) out.push(...generatedChildren(ctx, out[i]!));
  return out;
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
  const prior = getRun(ctx, runId);
  const result = db.query(
    "UPDATE workflow_runs SET pr_url = ? WHERE id = ? AND (pr_url IS NULL OR pr_url = '' OR pr_url = ?)",
  ).run(prUrl, runId, prUrl);
  if (result.changes === 0) {
    const current = getRun(ctx, runId);
    if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
    if (current.prUrl && current.prUrl !== prUrl) {
      throw new CoreError("conflict", `conflict: run ${runId} already has a different PR URL`);
    }
    return;
  }
  if (!prior?.prUrl || prior.prUrl !== prUrl) touchMeaningful(ctx, runId);
}

/**
 * Upsert one unresolved merge conflict entry on the run (publish gate).
 * Keyed by taskId+branch so a second conflict does not erase the first (R2-F3).
 * Stamps meaningful_at (no rev bump) so since-you-last-looked wakes.
 */
export function setRunConflict(ctx: Ctx, runId: string, conflict: RunConflict): void {
  const db = workflowDatabase(ctx);
  db.transaction(() => upsertRunConflict(ctx, runId, conflict)).immediate();
  touchMeaningful(ctx, runId);
}

function upsertRunConflict(ctx: Ctx, runId: string, conflict: RunConflict): void {
  const db = workflowDatabase(ctx);
  const current = getRun(ctx, runId);
  if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
  const list = [...(current.conflict ?? [])];
  const idx = list.findIndex(e => e.taskId === conflict.taskId && e.branch === conflict.branch);
  if (idx >= 0) list[idx] = conflict;
  else list.push(conflict);
  const result = db.query(
    "UPDATE workflow_runs SET conflict = ? WHERE id = ?",
  ).run(JSON.stringify(list), runId);
  if (result.changes === 0) throw new CoreError("not_found", `unknown run ${runId}`);
}

/** Removes the matching entries from the run's current list, in one transaction. */
export function removeRunConflicts(ctx: Ctx, runId: string, match: (entry: RunConflict) => boolean): RunConflict[] {
  return workflowDatabase(ctx).transaction(() => {
    const list = getRun(ctx, runId)?.conflict ?? [];
    const removed = list.filter(match);
    if (removed.length > 0) replaceRunConflicts(ctx, runId, list.filter(entry => !match(entry)));
    return removed;
  }).immediate();
}

/** Replace the full conflict list (or clear when empty). */
export function replaceRunConflicts(ctx: Ctx, runId: string, conflicts: RunConflict[]): void {
  const db = workflowDatabase(ctx);
  const result = db.query(
    "UPDATE workflow_runs SET conflict = ? WHERE id = ?",
  ).run(conflicts.length > 0 ? JSON.stringify(conflicts) : null, runId);
  if (result.changes === 0) throw new CoreError("not_found", `unknown run ${runId}`);
  touchMeaningful(ctx, runId);
}

/** Clear every durable conflict marker on the run. Prefer clearRunConflictEntry. */
export function clearRunConflict(ctx: Ctx, runId: string): void {
  replaceRunConflicts(ctx, runId, []);
}

/** Remove conflict entries matching the predicate. */
export function clearRunConflictEntry(
  ctx: Ctx,
  runId: string,
  match: (entry: RunConflict) => boolean,
): void {
  removeRunConflicts(ctx, runId, match);
}

/** Find a conflict entry that names this resolution task (or the conflicting task). */
export function conflictEntryForTask(run: { conflict?: RunConflict[] }, taskId: string): RunConflict | undefined {
  return run.conflict?.find(e => e.resolutionTaskId === taskId || e.taskId === taskId);
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
  const db = workflowDatabase(ctx);
  // Read-only: letters for letterless rows are computed in memory by callers
  // (resolveRunLetters); persistence happens only in insertRun / schema migration.
  return db.query<RunDbRow, []>("SELECT * FROM workflow_runs WHERE status IN ('running', 'waiting') ORDER BY created_at, id").all().map(runFromRow);
}

/** Cheap existence check for live runs (no letter work, no mode reads). */
export function hasLiveRuns(ctx: Ctx): boolean {
  if (!workflowSchemaPresent(ctx)) return false;
  const row = workflowDatabase(ctx).query<{ n: number }, []>(
    "SELECT 1 AS n FROM workflow_runs WHERE status IN ('running', 'waiting') LIMIT 1",
  ).get();
  return !!row;
}

/** Patches that count as a meaningful change for since-you-last-looked.
 *  Pacing/person pause flips and summary/bookkeeping patches are excluded. */
const MEANINGFUL_PATCH_KEYS = new Set([
  "status", "title", "loops", "auto", "strictSteps", "stepMode", "rootTaskId",
  "priority",
]);

export type RunPatch = Partial<Pick<RunRow, "status" | "title" | "loops" | "auto" | "planner" | "orchestratorTaskId" | "sessionId" | "budget" | "spent" | "strictSteps" | "stepMode" | "rootTaskId" | "priority" | "lastSeenAt" | "summary" | "summaryAt" | "meaningfulAt">> & {
  reason?: string | null;
  nextWakeAt?: number | null;
  orchestratorState?: string | null;
  pendingPlanner?: string | null;
  pausedReason?: PausedReason | null;
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
    const bumpMeaningful = patch.meaningfulAt !== undefined
      || Object.keys(patch).some(k => MEANINGFUL_PATCH_KEYS.has(k));
    const meaningfulAt = patch.meaningfulAt !== undefined
      ? patch.meaningfulAt
      : (bumpMeaningful ? ctx.now : (current.meaningfulAt ?? current.updatedAt));
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
      priority: patch.priority === undefined ? current.priority : patch.priority,
      pausedReason: patch.pausedReason === undefined ? current.pausedReason : (patch.pausedReason ?? undefined),
      lastSeenAt: patch.lastSeenAt === undefined ? current.lastSeenAt : patch.lastSeenAt,
      summary: patch.summary === undefined ? current.summary : patch.summary,
      summaryAt: patch.summaryAt === undefined ? current.summaryAt : patch.summaryAt,
      meaningfulAt,
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
    if (updated.priority === undefined) delete updated.priority;
    if (updated.pausedReason === undefined) delete updated.pausedReason;
    if (updated.lastSeenAt === undefined) delete updated.lastSeenAt;
    if (updated.summary === undefined) delete updated.summary;
    if (updated.summaryAt === undefined) delete updated.summaryAt;
    if (updated.meaningfulAt === undefined) delete updated.meaningfulAt;
    const result = db.query(
      "UPDATE workflow_runs SET status = ?, reason = ?, title = ?, loops = ?, rev = ?, updated_at = ?, auto = ?, planner = ?, orchestrator_task_id = ?, session_id = ?, budget = ?, spent = ?, next_wake_at = ?, orchestrator_state = ?, strict_steps = ?, pending_planner = ?, step_mode = ?, root_task_id = ?, priority = ?, paused_reason = ?, last_seen_at = ?, summary = ?, summary_at = ?, meaningful_at = ? WHERE id = ? AND rev = ?",
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
      updated.priority ?? "normal",
      updated.pausedReason ?? null,
      updated.lastSeenAt ?? null,
      updated.summary ?? null,
      updated.summaryAt ?? null,
      updated.meaningfulAt ?? null,
      id,
      expectRev,
    );
    if (result.changes === 0) throw new CoreError("conflict", `conflict: run ${id} changed since rev ${expectRev}`);
    return updated;
  })();
}

/**
 * Stamp meaningful_at without bumping `rev` (step settle, questions, conflicts, PR).
 * Compare-and-set clients keep a stable expect_rev; since-you-last-looked still wakes.
 */
export function touchMeaningful(ctx: Ctx, runId: string): void {
  try {
    workflowDatabase(ctx).query(
      "UPDATE workflow_runs SET meaningful_at = ? WHERE id = ? AND status IN ('running', 'waiting')",
    ).run(ctx.now, runId);
  } catch { /* missing table / concurrent / terminal */ }
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

/** A new attempt of one fan-out branch, joined with the rest of its fan-out. */
export function insertBranchRetry(
  ctx: Ctx, failed: StepRow & { branch: string }, attempt: number,
): StepRow {
  const trigger = `retry:${fanoutAttempt(failed)}:${failed.runId}/${failed.stepId}/${failed.branch}#${attempt}`;
  workflowDatabase(ctx).query(
    `INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at, "trigger")
     VALUES (?, ?, ?, ?, NULL, 'running', NULL, NULL, ?, NULL, ?)`,
  ).run(failed.runId, failed.stepId, attempt, failed.branch, ctx.now, trigger);
  return { runId: failed.runId, stepId: failed.stepId, attempt, branch: failed.branch, status: "running", startedAt: ctx.now, trigger };
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
  if (patch.status !== undefined && patch.status !== row.status) {
    touchMeaningful(ctx, key.runId);
  }
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
  if (result.changes !== 1) return null;
  if (nextStatus !== row.status) touchMeaningful(ctx, key.runId);
  return stepFromRow({ ...row, status: nextStatus, result: nextResult, error: nextError, ended_at: nextEnded });
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
 *  when the row is not waiting (already answered, stopped, …).
 *  Optional `decision` is inserted in the same immediate transaction (R2-F6). */
export function claimStepAnswer(
  ctx: Ctx,
  key: StepKey,
  result: unknown,
  extras?: {
    decision?: {
      runId: string;
      stepId: string;
      attempt: number;
      actor: string;
      kind: string;
      choice: string;
      reason: string;
    };
  },
): StepRow | null {
  const db = workflowDatabase(ctx);
  const where = stepWhere(key);
  // M3: immediate so a concurrent writer cannot interleave between the claim and the decision.
  // A tip that moves between tip-read and claim makes publish refuse (fail-closed); the person re-approves.
  const claimed = db.transaction(() => {
    const row = db.query<StepDbRow, SQLQueryBindings[]>(`SELECT * FROM workflow_steps WHERE ${where.sql}`).get(...where.bindings);
    if (!row || row.status !== "waiting") return null;
    const done = db.query(`UPDATE workflow_steps SET status = 'done', result = ?, ended_at = ? WHERE ${where.sql} AND status = 'waiting'`)
      .run(JSON.stringify(result), ctx.now, ...where.bindings);
    if (done.changes !== 1) return null;
    if (extras?.decision) {
      const d = extras.decision;
      const id = newDecisionId();
      db.query(
        "INSERT INTO workflow_decisions(id, run_id, step_id, attempt, actor, kind, choice, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, d.runId, d.stepId, d.attempt, d.actor, d.kind, d.choice, d.reason, ctx.now);
    }
    return stepFromRow({ ...row, status: "done", result: JSON.stringify(result), ended_at: ctx.now });
  }).immediate();
  // Phase 6: stamp meaningful_at outside the claim txn (no rev bump).
  if (claimed) touchMeaningful(ctx, key.runId);
  return claimed;
}

/** Claims the verdict on a step that waits for review: the write lands only while
 *  the row is still `waiting` for the same task, so one caller advances the run. */
export function claimStepReview(ctx: Ctx, key: StepKey, taskId: string, patch: StepPatch & { status: "done" | "failed" }): StepRow | null {
  const db = workflowDatabase(ctx);
  const where = stepWhere(key);
  const claimed = db.transaction(() => {
    const row = db.query<StepDbRow, SQLQueryBindings[]>(`SELECT * FROM workflow_steps WHERE ${where.sql}`).get(...where.bindings);
    if (!row || row.status !== "waiting" || row.task_id !== taskId) return null;
    db.query(`UPDATE workflow_steps SET status = ?, error = ?, ended_at = ? WHERE ${where.sql} AND status = 'waiting'`)
      .run(patch.status, patch.error ?? null, patch.endedAt ?? null, ...where.bindings);
    return stepFromRow({ ...row, status: patch.status, error: patch.error ?? null, ended_at: patch.endedAt ?? null });
  }).immediate();
  if (claimed) touchMeaningful(ctx, key.runId);
  return claimed;
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
 * The step a task works for: its own step row, else the row of the task it
 * retried (a retry successor the engine has not adopted yet still carries that
 * step's code). Read-only; never creates the workflow schema.
 */
export function stepByTaskLineage(ctx: Ctx, taskId: string): StepRow | null {
  const seen = new Set<string>();
  for (let id: string | undefined = taskId; id && !seen.has(id); id = readTask(ctx, id)?.retryOf) {
    seen.add(id);
    const step = stepByTaskIfPresent(ctx, id);
    if (step) return step;
  }
  return null;
}

/**
 * Read-only: true when `taskId` is a workflow step of a run that already has a
 * branch (its own, or an ancestor's for a generated child). Uses sqlite_master only — never runs workflow DDL — so ordinary
 * accepts and the native review probe stay side-effect free on old DBs.
 * Missing tables / columns mean "no". Other errors propagate (M4: fail closed
 * for the probe only means "table/column missing", not "swallow everything").
 */
export function stepTaskNeedsRunBranchMerge(ctx: Ctx, taskId: string): boolean {
  const db = taskDatabase(ctx);
  let present: unknown;
  let runsPresent: unknown;
  try {
    present = db.query(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'workflow_steps'",
    ).get();
    runsPresent = db.query(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'",
    ).get();
  } catch {
    return false;
  }
  if (!present || !runsPresent) return false;
  try {
    const stepRunId = stepByTaskLineage(ctx, taskId)?.runId;
    if (stepRunId) {
      const row = db.query<{ ok: number }, [string]>(
        `WITH RECURSIVE up(id) AS (
           VALUES (?)
           UNION SELECT r.parent_run_id FROM workflow_runs r JOIN up ON r.id = up.id
             WHERE r.parent_run_id IS NOT NULL
         )
         SELECT 1 AS ok FROM workflow_runs r JOIN up ON r.id = up.id
         WHERE r.branch IS NOT NULL AND r.branch != '' LIMIT 1`,
      ).get(stepRunId);
      if (row) return true;
    }
    // Conflict-resolution tasks are not step-attached; they still merge into the run branch.
    const conflictCol = db.query(
      "SELECT 1 AS ok FROM pragma_table_info('workflow_runs') WHERE name = 'conflict'",
    ).get();
    if (!conflictCol) return false;
    // Support both legacy object markers and the R2-F3 list form.
    // F2: json_valid so one corrupt row cannot raise "malformed JSON" on every accept probe.
    const marker = db.query<{ conflict: string | null }, [string, string]>(
      `SELECT conflict FROM workflow_runs
       WHERE conflict IS NOT NULL
         AND json_valid(conflict)
         AND (
           json_extract(conflict, '$.resolutionTaskId') = ?
           OR EXISTS (
             SELECT 1 FROM json_each(conflict) AS j
             WHERE json_extract(j.value, '$.resolutionTaskId') = ?
           )
         )
       LIMIT 1`,
    ).get(taskId, taskId);
    return typeof marker?.conflict === "string" && marker.conflict.length > 0;
  } catch (error) {
    const msg = `${error instanceof Error ? error.message : error}`;
    // Only schema-absence is "no"; other errors must propagate so callers fail closed.
    if (/no such (table|column)/i.test(msg)) return false;
    throw error;
  }
}

/** True when workflow tables already exist — read-only, no DDL (R2-I4). */
export function workflowSchemaPresent(ctx: Ctx): boolean {
  return !!taskDatabase(ctx).query(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'workflow_steps'",
  ).get();
}

/** stepByTask without creating the workflow schema when the home has none. */
export function stepByTaskIfPresent(ctx: Ctx, taskId: string): StepRow | null {
  if (!workflowSchemaPresent(ctx)) return null;
  const row = taskDatabase(ctx).query<StepDbRow, [string]>("SELECT * FROM workflow_steps WHERE task_id = ?").get(taskId);
  return row ? stepFromRow(row) : null;
}

/** The run whose orchestrator_task_id is this task, without creating the schema. */
export function runByOrchestratorTaskIfPresent(ctx: Ctx, taskId: string): RunRow | null {
  if (!workflowSchemaPresent(ctx)) return null;
  const hasRuns = !!taskDatabase(ctx).query(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'",
  ).get();
  if (!hasRuns) return null;
  const row = taskDatabase(ctx).query<RunDbRow, [string]>(
    "SELECT * FROM workflow_runs WHERE orchestrator_task_id = ? LIMIT 1",
  ).get(taskId);
  return row ? runFromRow(row) : null;
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

// --- Phase 4: structured questions -------------------------------------------------

export type QuestionAskerKind = "executor" | "orchestrator" | "human_step";
export type QuestionAnswerer = "orchestrator" | "person";
export type QuestionStatus = "open" | "answered" | "withdrawn";
export type QuestionAnswerType = "single" | "multi" | "text" | "yes_no" | "approve_revise";
export type QuestionBlocks = "step" | "branch" | "nothing";

export interface QuestionOption {
  value: string;
  note?: string;
}

export interface QuestionRow {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  branch?: string;
  askerTaskId?: string;
  askerKind: QuestionAskerKind;
  text: string;
  answerType: QuestionAnswerType;
  options?: QuestionOption[];
  recommended?: string;
  blocks: QuestionBlocks;
  artifact?: string;
  answerer: QuestionAnswerer;
  chain: QuestionAnswerer[];
  suggested?: string;
  answer?: string;
  answeredBy?: string;
  status: QuestionStatus;
  rev: number;
  createdAt: number;
  answeredAt?: number;
}

export type NewQuestion = {
  runId: string;
  stepId: string;
  attempt: number;
  branch?: string;
  askerTaskId?: string;
  askerKind: QuestionAskerKind;
  text: string;
  answerType: QuestionAnswerType;
  options?: QuestionOption[];
  recommended?: string;
  blocks: QuestionBlocks;
  artifact?: string;
  answerer: QuestionAnswerer;
  chain?: QuestionAnswerer[];
  suggested?: string;
};

interface QuestionDbRow {
  id: string;
  run_id: string;
  step_id: string;
  attempt: number;
  branch: string | null;
  asker_task_id: string | null;
  asker_kind: string;
  text: string;
  answer_type: string;
  options: string | null;
  recommended: string | null;
  blocks: string;
  artifact: string | null;
  answerer: string;
  chain: string;
  suggested: string | null;
  answer: string | null;
  answered_by: string | null;
  status: string;
  rev: number;
  created_at: number;
  answered_at: number | null;
}

function newQuestionId(): string {
  const bytes = randomBytes(10);
  let id = "q_";
  for (const byte of bytes) id += BASE32[byte % 32];
  return id;
}

function parseOptions(raw: string | null): QuestionOption[] | undefined {
  if (raw == null || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed as QuestionOption[];
  } catch {
    return undefined;
  }
}

function parseChain(raw: string): QuestionAnswerer[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as QuestionAnswerer[];
  } catch {
    return [];
  }
}

function questionFromRow(row: QuestionDbRow): QuestionRow {
  const out: QuestionRow = {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    askerKind: row.asker_kind as QuestionAskerKind,
    text: row.text,
    answerType: row.answer_type as QuestionAnswerType,
    blocks: row.blocks as QuestionBlocks,
    answerer: row.answerer as QuestionAnswerer,
    chain: parseChain(row.chain),
    status: row.status as QuestionStatus,
    rev: row.rev,
    createdAt: row.created_at,
  };
  if (row.branch) out.branch = row.branch;
  if (row.asker_task_id) out.askerTaskId = row.asker_task_id;
  const options = parseOptions(row.options);
  if (options) out.options = options;
  if (row.recommended) out.recommended = row.recommended;
  if (row.artifact) out.artifact = row.artifact;
  if (row.suggested) out.suggested = row.suggested;
  if (row.answer != null) out.answer = row.answer;
  if (row.answered_by) out.answeredBy = row.answered_by;
  if (row.answered_at != null) out.answeredAt = row.answered_at;
  return out;
}

export function insertQuestion(ctx: Ctx, input: NewQuestion): QuestionRow {
  const chain = input.chain ?? [];
  const row: QuestionRow = {
    id: newQuestionId(),
    runId: input.runId,
    stepId: input.stepId,
    attempt: input.attempt,
    askerKind: input.askerKind,
    text: input.text,
    answerType: input.answerType,
    blocks: input.blocks,
    answerer: input.answerer,
    chain,
    status: "open",
    rev: 1,
    createdAt: ctx.now,
  };
  if (input.branch) row.branch = input.branch;
  if (input.askerTaskId) row.askerTaskId = input.askerTaskId;
  if (input.options) row.options = input.options;
  if (input.recommended) row.recommended = input.recommended;
  if (input.artifact) row.artifact = input.artifact;
  if (input.suggested) row.suggested = input.suggested;
  workflowDatabase(ctx).query(
    `INSERT INTO workflow_questions(
      id, run_id, step_id, attempt, branch, asker_task_id, asker_kind, text, answer_type,
      options, recommended, blocks, artifact, answerer, chain, suggested, answer, answered_by,
      status, rev, created_at, answered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
  ).run(
    row.id,
    row.runId,
    row.stepId,
    row.attempt,
    row.branch ?? null,
    row.askerTaskId ?? null,
    row.askerKind,
    row.text,
    row.answerType,
    row.options ? JSON.stringify(row.options) : null,
    row.recommended ?? null,
    row.blocks,
    row.artifact ?? null,
    row.answerer,
    JSON.stringify(row.chain),
    row.suggested ?? null,
    row.status,
    row.rev,
    row.createdAt,
  );
  touchMeaningful(ctx, row.runId);
  return row;
}

export function getQuestion(ctx: Ctx, id: string): QuestionRow | null {
  const row = workflowDatabase(ctx).query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE id = ?",
  ).get(id);
  return row ? questionFromRow(row) : null;
}

export function listQuestions(ctx: Ctx, runId: string, status?: QuestionStatus): QuestionRow[] {
  const db = workflowDatabase(ctx);
  if (status) {
    return db.query<QuestionDbRow, [string, string]>(
      "SELECT * FROM workflow_questions WHERE run_id = ? AND status = ? ORDER BY created_at, id",
    ).all(runId, status).map(questionFromRow);
  }
  return db.query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE run_id = ? ORDER BY created_at, id",
  ).all(runId).map(questionFromRow);
}

/** Open questions whose current answerer is the person (attention queue). Missing table → [].
 *  Only questions on live (running/waiting) runs are returned. */
export function listOpenPersonQuestions(ctx: Ctx): QuestionRow[] {
  try {
    return workflowDatabase(ctx).query<QuestionDbRow, []>(
      `SELECT q.* FROM workflow_questions q
       JOIN workflow_runs r ON r.id = q.run_id
       WHERE q.status = 'open' AND q.answerer = 'person'
         AND r.status IN ('running', 'waiting')
       ORDER BY q.created_at, q.id`,
    ).all().map(questionFromRow);
  } catch {
    return [];
  }
}

/** Mark every open question on a run (and optionally its tree) withdrawn. */
export function withdrawOpenQuestionsForRun(ctx: Ctx, runId: string): QuestionRow[] {
  const db = workflowDatabase(ctx);
  const open = db.query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE run_id = ? AND status = 'open'",
  ).all(runId);
  const out: QuestionRow[] = [];
  for (const row of open) {
    db.query(
      `UPDATE workflow_questions SET status = 'withdrawn', rev = rev + 1 WHERE id = ? AND status = 'open'`,
    ).run(row.id);
    const updated = db.query<QuestionDbRow, [string]>(
      "SELECT * FROM workflow_questions WHERE id = ?",
    ).get(row.id);
    if (updated) out.push(questionFromRow(updated));
  }
  if (out.length > 0) touchMeaningful(ctx, runId);
  return out;
}

/** Withdraws the open questions about one step attempt, which nobody waits for once a
 *  retry or skip took it. */
export function withdrawOpenQuestionsForStep(ctx: Ctx, key: StepKey): QuestionRow[] {
  const open = listQuestions(ctx, key.runId, "open").filter(q =>
    q.stepId === key.stepId && q.attempt === key.attempt && q.branch === key.branch);
  for (const question of open) {
    workflowDatabase(ctx).query(
      "UPDATE workflow_questions SET status = 'withdrawn', rev = rev + 1 WHERE id = ? AND status = 'open'",
    ).run(question.id);
  }
  if (open.length > 0) touchMeaningful(ctx, key.runId);
  return open.flatMap(question => getQuestion(ctx, question.id) ?? []);
}

/** Compare-and-set answer: requires the current rev and an open status. */
export function answerQuestionRecord(
  ctx: Ctx,
  id: string,
  input: { answer: string; note?: string; expectRev: number; answeredBy: string },
): QuestionRow {
  const db = workflowDatabase(ctx);
  const current = db.query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE id = ?",
  ).get(id);
  if (!current) throw new CoreError("not_found", `unknown question ${id}`);
  if (current.rev !== input.expectRev) {
    throw new CoreError("conflict", `conflict: question ${id} changed since rev ${input.expectRev}`);
  }
  if (current.status !== "open") {
    throw new CoreError("conflict", `conflict: question ${id} is ${current.status}`);
  }
  const answer = input.note !== undefined
    ? JSON.stringify({ answer: input.answer, note: input.note })
    : input.answer;
  const done = db.query(
    `UPDATE workflow_questions
     SET answer = ?, answered_by = ?, status = 'answered', rev = rev + 1, answered_at = ?
     WHERE id = ? AND rev = ? AND status = 'open'`,
  ).run(answer, input.answeredBy, ctx.now, id, input.expectRev);
  if (done.changes !== 1) {
    throw new CoreError("conflict", `conflict: question ${id} changed since rev ${input.expectRev}`);
  }
  const updated = db.query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE id = ?",
  ).get(id);
  if (!updated) throw new CoreError("not_found", `unknown question ${id}`);
  touchMeaningful(ctx, current.run_id);
  return questionFromRow(updated);
}

/** Compare-and-set escalate: answerer becomes person, chain grows, suggestion attached. */
export function escalateQuestionRecord(
  ctx: Ctx,
  id: string,
  input: { suggested: string; expectRev: number; by: QuestionAnswerer },
): QuestionRow {
  const db = workflowDatabase(ctx);
  const current = db.query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE id = ?",
  ).get(id);
  if (!current) throw new CoreError("not_found", `unknown question ${id}`);
  if (current.rev !== input.expectRev) {
    throw new CoreError("conflict", `conflict: question ${id} changed since rev ${input.expectRev}`);
  }
  if (current.status !== "open") {
    throw new CoreError("conflict", `conflict: question ${id} is ${current.status}`);
  }
  const chain = parseChain(current.chain);
  if (!chain.includes(input.by)) chain.push(input.by);
  const done = db.query(
    `UPDATE workflow_questions
     SET answerer = 'person', chain = ?, suggested = ?, rev = rev + 1
     WHERE id = ? AND rev = ? AND status = 'open'`,
  ).run(JSON.stringify(chain), input.suggested, id, input.expectRev);
  if (done.changes !== 1) {
    throw new CoreError("conflict", `conflict: question ${id} changed since rev ${input.expectRev}`);
  }
  const updated = db.query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE id = ?",
  ).get(id);
  if (!updated) throw new CoreError("not_found", `unknown question ${id}`);
  touchMeaningful(ctx, current.run_id);
  return questionFromRow(updated);
}

/** Patch open-question fields that routing updates (answerer only via escalate). */
export function updateQuestionRecord(
  ctx: Ctx,
  id: string,
  expectRev: number,
  patch: Partial<Pick<QuestionRow, "suggested" | "status">>,
): QuestionRow {
  const db = workflowDatabase(ctx);
  const current = db.query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE id = ?",
  ).get(id);
  if (!current) throw new CoreError("not_found", `unknown question ${id}`);
  if (current.rev !== expectRev) {
    throw new CoreError("conflict", `conflict: question ${id} changed since rev ${expectRev}`);
  }
  const status = patch.status ?? (current.status as QuestionStatus);
  const suggested = patch.suggested !== undefined ? patch.suggested : current.suggested;
  const done = db.query(
    `UPDATE workflow_questions SET suggested = ?, status = ?, rev = rev + 1 WHERE id = ? AND rev = ?`,
  ).run(suggested ?? null, status, id, expectRev);
  if (done.changes !== 1) {
    throw new CoreError("conflict", `conflict: question ${id} changed since rev ${expectRev}`);
  }
  const updated = db.query<QuestionDbRow, [string]>(
    "SELECT * FROM workflow_questions WHERE id = ?",
  ).get(id);
  if (!updated) throw new CoreError("not_found", `unknown question ${id}`);
  return questionFromRow(updated);
}
