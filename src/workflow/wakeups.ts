// Durable orchestrator wake-ups and turns (Phase 2): rows written with their
// causes, claimed by one live turn per run, and recreated by the needs-orchestrator
// scan when a wake-up is lost (spec "Wake-ups and turns are durable").
import type { Database } from "bun:sqlite";
import type { Ctx } from "../types";
import { canAutoDecide } from "./auto";
import {
  getDefinition, getRun, liveRuns, rootRunId, stepsOfRun, updateStep, workflowDatabase,
  type StepRow,
} from "./store";

export type WakeCause =
  | "step_settled"
  | "step_invalid"
  | "step_failed"
  | "question"
  | "replan"
  | "message"
  | "returned"
  | "orchestrator_step";

export interface Wakeup {
  runId: string;
  cause: WakeCause;
  ref: string;
  createdAt: number;
  turnId?: string;
  doneAt?: number;
  byPerson: boolean;
}

export type TurnStatus = "starting" | "running" | "done" | "failed" | "stopped";

export interface TurnRow {
  id: string;
  runId: string;
  planner: string;
  sessionId?: string;
  taskId?: string;
  status: TurnStatus;
  reason?: string;
  startedAt: number;
  deadline: number;
  endedAt?: number;
  failures: number;
}

export type NewTurn = {
  id: string;
  runId: string;
  planner: string;
  sessionId?: string;
  taskId?: string;
  status: TurnStatus;
  reason?: string;
  startedAt: number;
  deadline: number;
  failures?: number;
};

interface WakeDbRow {
  run_id: string;
  cause: string;
  ref: string;
  created_at: number;
  turn_id: string | null;
  done_at: number | null;
  by_person: number;
}

interface TurnDbRow {
  id: string;
  run_id: string;
  planner: string;
  session_id: string | null;
  task_id: string | null;
  status: string;
  reason: string | null;
  started_at: number;
  deadline: number;
  ended_at: number | null;
  failures: number;
  seq?: number | null;
}

function wakeupFromRow(row: WakeDbRow): Wakeup {
  const out: Wakeup = {
    runId: row.run_id,
    cause: row.cause as WakeCause,
    ref: row.ref,
    createdAt: row.created_at,
    byPerson: row.by_person === 1,
  };
  if (row.turn_id) out.turnId = row.turn_id;
  if (row.done_at !== null) out.doneAt = row.done_at;
  return out;
}

function turnFromRow(row: TurnDbRow): TurnRow {
  const out: TurnRow = {
    id: row.id,
    runId: row.run_id,
    planner: row.planner,
    status: row.status as TurnStatus,
    startedAt: row.started_at,
    deadline: row.deadline,
    failures: row.failures,
  };
  if (row.session_id) out.sessionId = row.session_id;
  if (row.task_id) out.taskId = row.task_id;
  if (row.reason) out.reason = row.reason;
  if (row.ended_at !== null) out.endedAt = row.ended_at;
  return out;
}

/** Inserts a wake-up; duplicates of (run, cause, ref) are ignored. Safe inside an
 *  existing transaction (takes the open Database, not a Ctx). Callers that have a
 *  Ctx should prefer {@link enqueueWakeup}, which normalises to the root run. */
export function addWakeup(
  db: Database,
  w: { runId: string; cause: WakeCause; ref: string; byPerson?: boolean; createdAt?: number },
): void {
  // Callers inside a service path pass createdAt from ctx.now; tests may omit it.
  const createdAt = w.createdAt ?? Math.floor(Date.now() / 1000);
  const inserted = db.query(
    "INSERT OR IGNORE INTO workflow_wakeups(run_id, cause, ref, created_at, turn_id, done_at, by_person) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
  ).run(w.runId, w.cause, w.ref, createdAt, w.byPerson ? 1 : 0);
  // A prior turn may have completed this key while the cause still holds (D2.6).
  // Re-open so needsOrchestrator / enqueueWakeup can wake again under the same key.
  if (inserted.changes === 0) {
    db.query(
      "UPDATE workflow_wakeups SET done_at = NULL, turn_id = NULL, created_at = ?, by_person = CASE WHEN ? = 1 THEN 1 ELSE by_person END WHERE run_id = ? AND cause = ? AND ref = ? AND done_at IS NOT NULL",
    ).run(createdAt, w.byPerson ? 1 : 0, w.runId, w.cause, w.ref);
  }
}

/** Writes a wake-up under the root run id (child runs share the root orchestrator). */
export function enqueueWakeup(
  ctx: Ctx,
  w: { runId: string; cause: WakeCause; ref: string; byPerson?: boolean; createdAt?: number },
): void {
  addWakeup(workflowDatabase(ctx), {
    ...w,
    runId: rootRunId(ctx, w.runId),
    createdAt: w.createdAt ?? ctx.now,
  });
}

/** Open wake-up already exists for this root key (claimed or unclaimed). */
function hasOpenWakeup(ctx: Ctx, runId: string, cause: WakeCause, ref: string): boolean {
  return !!workflowDatabase(ctx).query(
    "SELECT 1 FROM workflow_wakeups WHERE run_id = ? AND cause = ? AND ref = ? AND done_at IS NULL LIMIT 1",
  ).get(runId, cause, ref);
}

/** Open (unclaimed and not done) wake-ups for a run, oldest first. */
export function openWakeups(ctx: Ctx, runId: string): Wakeup[] {
  return workflowDatabase(ctx).query<WakeDbRow, [string]>(
    "SELECT * FROM workflow_wakeups WHERE run_id = ? AND done_at IS NULL AND turn_id IS NULL ORDER BY created_at, cause, ref",
  ).all(runId).map(wakeupFromRow);
}

/** Claims every open wake-up of the run for `turnId` and returns them. */
export function claimWakeups(ctx: Ctx, runId: string, turnId: string): Wakeup[] {
  const db = workflowDatabase(ctx);
  return db.transaction(() => {
    db.query(
      "UPDATE workflow_wakeups SET turn_id = ? WHERE run_id = ? AND done_at IS NULL AND turn_id IS NULL",
    ).run(turnId, runId);
    return db.query<WakeDbRow, [string, string]>(
      "SELECT * FROM workflow_wakeups WHERE run_id = ? AND turn_id = ? AND done_at IS NULL ORDER BY created_at, cause, ref",
    ).all(runId, turnId).map(wakeupFromRow);
  })();
}

/** Returns claimed-but-not-done wake-ups to the open pool (turn failure / release). */
export function releaseWakeups(ctx: Ctx, turnId: string): void {
  workflowDatabase(ctx).query(
    "UPDATE workflow_wakeups SET turn_id = NULL WHERE turn_id = ? AND done_at IS NULL",
  ).run(turnId);
}

/** Claimed-but-not-done wake-ups for a live turn (before complete/release). */
export function claimedWakeups(ctx: Ctx, turnId: string): Wakeup[] {
  return workflowDatabase(ctx).query<WakeDbRow, [string]>(
    "SELECT * FROM workflow_wakeups WHERE turn_id = ? AND done_at IS NULL ORDER BY created_at, cause, ref",
  ).all(turnId).map(wakeupFromRow);
}

/** Marks the turn's claimed wake-ups done. */
export function completeWakeups(ctx: Ctx, turnId: string): void {
  workflowDatabase(ctx).query(
    "UPDATE workflow_wakeups SET done_at = ? WHERE turn_id = ? AND done_at IS NULL",
  ).run(ctx.now, turnId);
}

/** Whether the underlying decision for a wake key is still open after a done turn. */
export function wakeCauseStillOpen(ctx: Ctx, runId: string, cause: WakeCause, ref: string): boolean {
  const parsed = parseWakeRef(ref);
  if (!parsed) return false;
  const { stepId, attempt, branch, runId: owningRunId } = parsed;
  // Prefer the owning runId from the ref (N4); fall back to root+children for legacy refs.
  const roots = [rootRunId(ctx, runId)];
  const childIds = workflowDatabase(ctx).query<{ id: string }, [string]>(
    "SELECT id FROM workflow_runs WHERE parent_run_id = ?",
  ).all(roots[0]!).map(r => r.id);
  const searchIds = owningRunId ? [owningRunId] : [...roots, ...childIds];
  for (const id of searchIds) {
    const steps = stepsOfRun(ctx, id);
    const step = steps.find(s =>
      s.stepId === stepId
      && s.attempt === attempt
      && (branch === undefined ? s.branch === undefined : s.branch === branch),
    );
    if (!step) continue;
    if (cause === "step_failed" || cause === "step_invalid") {
      if (step.status !== "failed" || step.advancedAt) return false;
      const later = steps.some(s =>
        s.stepId === stepId
        && (branch === undefined ? s.branch === undefined : s.branch === branch)
        && s.attempt > attempt,
      );
      return !later;
    }
    if (cause === "orchestrator_step") {
      const def = getDefinition(ctx, `${(getRun(ctx, id) ?? getRun(ctx, roots[0]!))!.workflow}@${(getRun(ctx, id) ?? getRun(ctx, roots[0]!))!.version}`)
        ?? getDefinition(ctx, (getRun(ctx, id) ?? getRun(ctx, roots[0]!))!.workflow);
      const stepDef = def?.steps[stepId];
      if (!stepDef) return false;
      if (stepDef.type === "choose_workflow") {
        // Waiting with a stamped childRunId means the choice already happened (N1).
        if (step.status !== "waiting") return false;
        return !chooseStepChildRunId(step.result);
      }
      if (stepDef.type === "agent" && stepDef.role === "orchestrator") {
        return step.status === "running" || step.status === "waiting";
      }
      return false;
    }
    if (cause === "question") {
      return step.status === "waiting";
    }
  }
  return false;
}

/** Marks one wake-up key done (skip/retry resolved the cause). */
export function completeWakeupRef(ctx: Ctx, runId: string, cause: WakeCause, ref: string): void {
  workflowDatabase(ctx).query(
    "UPDATE workflow_wakeups SET done_at = ? WHERE run_id = ? AND cause = ? AND ref = ? AND done_at IS NULL",
  ).run(ctx.now, rootRunId(ctx, runId), cause, ref);
}

export function insertTurn(ctx: Ctx, t: NewTurn): TurnRow {
  const db = workflowDatabase(ctx);
  const failures = t.failures ?? 0;
  const seqRow = db.query<{ m: number | null }, []>(
    "SELECT MAX(seq) AS m FROM workflow_turns",
  ).get();
  const seq = (seqRow?.m ?? 0) + 1;
  db.query(
    "INSERT INTO workflow_turns(id, run_id, planner, session_id, task_id, status, reason, started_at, deadline, ended_at, failures, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
  ).run(
    t.id,
    t.runId,
    t.planner,
    t.sessionId ?? null,
    t.taskId ?? null,
    t.status,
    t.reason ?? null,
    t.startedAt,
    t.deadline,
    failures,
    seq,
  );
  return turnFromRow({
    id: t.id,
    run_id: t.runId,
    planner: t.planner,
    session_id: t.sessionId ?? null,
    task_id: t.taskId ?? null,
    status: t.status,
    reason: t.reason ?? null,
    started_at: t.startedAt,
    deadline: t.deadline,
    ended_at: null,
    failures,
    seq,
  });
}

export function getTurn(ctx: Ctx, id: string): TurnRow | null {
  const row = workflowDatabase(ctx).query<TurnDbRow, [string]>(
    "SELECT * FROM workflow_turns WHERE id = ?",
  ).get(id);
  return row ? turnFromRow(row) : null;
}

/** The live (starting/running) turn for a run, if any. */
export function liveTurn(ctx: Ctx, runId: string): TurnRow | null {
  const row = workflowDatabase(ctx).query<TurnDbRow, [string]>(
    "SELECT * FROM workflow_turns WHERE run_id = ? AND status IN ('starting', 'running') LIMIT 1",
  ).get(runId);
  return row ? turnFromRow(row) : null;
}

/** The live turn whose orchestrator task is `taskId`, if any. */
export function liveTurnForTask(ctx: Ctx, taskId: string): TurnRow | null {
  const row = workflowDatabase(ctx).query<TurnDbRow, [string]>(
    "SELECT * FROM workflow_turns WHERE task_id = ? AND status IN ('starting', 'running') LIMIT 1",
  ).get(taskId);
  return row ? turnFromRow(row) : null;
}

export type TurnPatch = {
  status?: TurnRow["status"];
  /** Pass `null` to clear. */
  reason?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  deadline?: number;
  endedAt?: number | null;
  failures?: number;
};

export function updateTurn(ctx: Ctx, id: string, patch: TurnPatch): TurnRow {
  const current = getTurn(ctx, id);
  if (!current) throw new Error(`unknown turn ${id}`);
  const next: TurnRow = {
    ...current,
    status: patch.status ?? current.status,
    reason: patch.reason === undefined ? current.reason : (patch.reason ?? undefined),
    sessionId: patch.sessionId === undefined ? current.sessionId : (patch.sessionId ?? undefined),
    taskId: patch.taskId === undefined ? current.taskId : (patch.taskId ?? undefined),
    deadline: patch.deadline ?? current.deadline,
    endedAt: patch.endedAt === undefined ? current.endedAt : (patch.endedAt ?? undefined),
    failures: patch.failures ?? current.failures,
  };
  if (next.reason === undefined) delete next.reason;
  if (next.sessionId === undefined) delete next.sessionId;
  if (next.taskId === undefined) delete next.taskId;
  if (next.endedAt === undefined) delete next.endedAt;
  workflowDatabase(ctx).query(
    "UPDATE workflow_turns SET status = ?, reason = ?, session_id = ?, task_id = ?, deadline = ?, ended_at = ?, failures = ? WHERE id = ?",
  ).run(
    next.status,
    next.reason ?? null,
    next.sessionId ?? null,
    next.taskId ?? null,
    next.deadline,
    next.endedAt ?? null,
    next.failures,
    id,
  );
  return next;
}

/** childRunId stamped on a waiting choose_workflow step until the child settles. */
export function chooseStepChildRunId(result: unknown): string | undefined {
  if (result == null || typeof result !== "object") return undefined;
  const id = (result as { childRunId?: unknown }).childRunId;
  return typeof id === "string" ? id : undefined;
}

/** Seconds after which a choose claim without childRunId is reconciled by the tick. */
export const CHOOSING_STALE_S = 60;

/** True when result is a live choose claim (choosing:true, no childRunId). */
export function chooseStepChoosing(result: unknown): { choosingAt: number } | null {
  if (result == null || typeof result !== "object") return null;
  if ((result as { choosing?: unknown }).choosing !== true) return null;
  if (chooseStepChildRunId(result)) return null;
  const at = (result as { choosingAt?: unknown }).choosingAt;
  return { choosingAt: typeof at === "number" ? at : 0 };
}

/** Stale choose claims: stamp an existing child or clear the marker (H1). */
export function reconcileStaleChooseClaims(ctx: Ctx): number {
  let handled = 0;
  for (const run of liveRuns(ctx)) {
    const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
    if (!def) continue;
    for (const step of stepsOfRun(ctx, run.id)) {
      if (step.status !== "waiting") continue;
      if (def.steps[step.stepId]?.type !== "choose_workflow") continue;
      const claim = chooseStepChoosing(step.result);
      if (!claim) continue;
      if (ctx.now - claim.choosingAt < CHOOSING_STALE_S) continue;
      // Only children created at/after this claim (A-M2 / S-M6) — never stamp a
      // finished child from an earlier choose attempt.
      const child = workflowDatabase(ctx).query<{ id: string }, [string, string, number]>(
        "SELECT id FROM workflow_runs WHERE parent_run_id = ? AND parent_step = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
      ).get(run.id, step.stepId, claim.choosingAt);
      const key = {
        runId: step.runId, stepId: step.stepId, attempt: step.attempt,
        ...(step.branch !== undefined ? { branch: step.branch } : {}),
      };
      if (child) {
        const prior = step.result as { workflow?: string; reason?: string };
        updateStep(ctx, key, {
          result: {
            workflow: typeof prior.workflow === "string" ? prior.workflow : "",
            reason: typeof prior.reason === "string" ? prior.reason : "",
            childRunId: child.id,
          },
        });
      } else {
        // No child at/after choosingAt: clear the stale claim. A second identical
        // query here cannot differ (no await between) — do not re-check (S-M5).
        updateStep(ctx, key, { result: null });
      }
      handled++;
    }
  }
  return handled;
}

/** Parse `owningRunId/stepId#attempt[/branch]` or legacy `stepId#attempt[/branch]`. */
export function parseWakeRef(ref: string): {
  runId?: string; stepId: string; attempt: number; branch?: string;
} | null {
  const hash = ref.indexOf("#");
  const slash = ref.indexOf("/");
  // New form: runId appears before the first '#' (branch '/' is always after '#').
  if (slash >= 0 && (hash < 0 || slash < hash)) {
    const owning = ref.slice(0, slash);
    const rest = ref.slice(slash + 1);
    const m = /^([^#]+)#(\d+)(?:\/(.+))?$/.exec(rest);
    if (!m) return null;
    return {
      runId: owning,
      stepId: m[1]!,
      attempt: Number(m[2]),
      ...(m[3] !== undefined ? { branch: m[3] } : {}),
    };
  }
  const m = /^([^#]+)#(\d+)(?:\/(.+))?$/.exec(ref);
  if (!m) return null;
  return {
    stepId: m[1]!,
    attempt: Number(m[2]),
    ...(m[3] !== undefined ? { branch: m[3] } : {}),
  };
}

/** Stable wake-up ref: `owningRunId/stepId#attempt` or `.../stepId#attempt/branch` (N4). */
export function stepWakeRef(owningRunId: string, stepId: string, attempt: number, branch?: string): string {
  const local = branch ? `${stepId}#${attempt}/${branch}` : `${stepId}#${attempt}`;
  return `${owningRunId}/${local}`;
}

/** Root run plus choose_workflow descendants (children and grandchildren) for prompts. */
export function stepsOfRootTree(ctx: Ctx, runId: string): StepRow[] {
  const root = rootRunId(ctx, runId);
  const db = workflowDatabase(ctx);
  const ids: string[] = [root];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const kids = db.query<{ id: string }, [string]>(
      "SELECT id FROM workflow_runs WHERE parent_run_id = ?",
    ).all(parent).map(r => r.id);
    for (const id of kids) {
      if (ids.includes(id)) continue;
      ids.push(id);
      queue.push(id);
    }
  }
  return ids.flatMap(id => stepsOfRun(ctx, id));
}

export type NeedsOrchestrator = {
  runId: string;
  cause: WakeCause;
  ref: string;
  /** Prefer the step's startedAt so a recreated wake-up is already past coalesce. */
  createdAt?: number;
};

/** Live runs that have an open decision (failed/invalid step, auto human question,
 *  or waiting orchestrator/choose step) with no open wake-up and no live turn on the
 *  root — the scan recreates the missing wake-up under the root run id. */
export function needsOrchestrator(ctx: Ctx): NeedsOrchestrator[] {
  const db = workflowDatabase(ctx);
  const out: NeedsOrchestrator[] = [];
  const seen = new Set<string>();
  const push = (runId: string, cause: WakeCause, ref: string, createdAt?: number) => {
    const key = `${runId}\0${cause}\0${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ runId, cause, ref, ...(createdAt !== undefined ? { createdAt } : {}) });
  };

  // A failed row is open only when it is not yet advanced/resolved and no later
  // attempt of the same step/branch exists (round-2 B4: step.retry livelock).
  const failed = db.query<{
    run_id: string; step_id: string; attempt: number; branch: string | null;
    error: string | null; started_at: number;
  }, []>(`
    SELECT s.run_id, s.step_id, s.attempt, s.branch, s.error, s.started_at
    FROM workflow_steps s
    JOIN workflow_runs r ON r.id = s.run_id
    WHERE r.status IN ('running', 'waiting')
      AND s.status = 'failed'
      AND s.advanced_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM workflow_steps later
        WHERE later.run_id = s.run_id
          AND later.step_id = s.step_id
          AND COALESCE(later.branch, '') = COALESCE(s.branch, '')
          AND later.attempt > s.attempt
      )
    ORDER BY s.started_at, s.step_id, s.attempt, s.branch
  `).all();
  for (const row of failed) {
    const root = rootRunId(ctx, row.run_id);
    if (liveTurn(ctx, root)) continue;
    const ref = stepWakeRef(row.run_id, row.step_id, row.attempt, row.branch ?? undefined);
    const cause: WakeCause = row.error === "no step result" ? "step_invalid" : "step_failed";
    if (hasOpenWakeup(ctx, root, cause, ref)) continue;
    push(root, cause, ref, row.started_at);
  }

  for (const run of liveRuns(ctx)) {
    const root = rootRunId(ctx, run.id);
    if (liveTurn(ctx, root)) continue;
    const rootRun = getRun(ctx, root) ?? run;
    const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
    if (!def) continue;
    for (const step of stepsOfRun(ctx, run.id)) {
      const stepDef = def.steps[step.stepId];
      if (!stepDef) continue;
      if (step.status === "waiting" && stepDef.type === "human") {
        if (!canAutoDecide(rootRun, step.stepId, stepDef)) continue;
        const ref = stepWakeRef(run.id, step.stepId, step.attempt, step.branch);
        if (hasOpenWakeup(ctx, root, "question", ref)) continue;
        push(root, "question", ref, step.startedAt);
        continue;
      }
      if (step.status === "waiting" && stepDef.type === "choose_workflow") {
        // Already chose: result.childRunId is stamped until the child settles (N1).
        if (chooseStepChildRunId(step.result)) continue;
        const ref = stepWakeRef(run.id, step.stepId, step.attempt, step.branch);
        if (hasOpenWakeup(ctx, root, "orchestrator_step", ref)) continue;
        push(root, "orchestrator_step", ref, step.startedAt);
        continue;
      }
      if (step.status === "running" && stepDef.type === "agent" && stepDef.role === "orchestrator") {
        const ref = stepWakeRef(run.id, step.stepId, step.attempt, step.branch);
        if (hasOpenWakeup(ctx, root, "orchestrator_step", ref)) continue;
        push(root, "orchestrator_step", ref, step.startedAt);
      }
    }
  }
  return out;
}
