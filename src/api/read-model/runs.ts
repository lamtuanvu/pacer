import type { Ctx } from "../../types";
import { isEngineOwnedKind } from "../../tasks/engine-owned";
import { readTasksByIds } from "../../tasks/store";
import { resolveRunLetters } from "../../workflow/letters";
import {
  liveRuns,
  listOpenPersonQuestions,
  runEntityValue,
  workflowDatabase,
  workflowSchemaPresent,
  type RunRow,
  type StepRow,
} from "../../workflow/store";
import type { RunAttentionPriority } from "../../attention/types";

export type SnapshotWaitsOn = "you" | "planner" | "executors" | "nothing";

export interface SnapshotRunSteps {
  running: number;
  waiting: number;
  done: number;
  failed: number;
}

export interface SnapshotRun {
  id: string;
  letter: string;
  title: string;
  workflow: string;
  /** Notification owner: `human`, `external:<kind>[:<session>]`, or absent. */
  origin?: string;
  status: "running" | "waiting";
  priority: RunAttentionPriority;
  paused_reason?: string;
  waits_on: SnapshotWaitsOn;
  steps: SnapshotRunSteps;
  orchestrator: { state: string; planner?: string; reason?: string; next_wake_at?: number };
}

const priorityRank: Record<RunAttentionPriority, number> = { urgent: 0, normal: 1, background: 2 };
const unblocksRank: Record<string, number> = { run: 0, branch: 1, step: 0, nothing: 2 };

function asPriority(p: string | undefined): RunAttentionPriority {
  return p === "urgent" || p === "background" ? p : "normal";
}

/** Latest attempt per (step_id, branch). */
export function latestSteps(steps: StepRow[]): StepRow[] {
  const best = new Map<string, StepRow>();
  for (const s of steps) {
    const key = `${s.stepId}\0${s.branch ?? ""}`;
    const prev = best.get(key);
    if (!prev || s.attempt > prev.attempt || (s.attempt === prev.attempt && s.startedAt >= prev.startedAt)) {
      best.set(key, s);
    }
  }
  return [...best.values()];
}

function isCountedStep(step: StepRow, kinds: Map<string, string | null>): boolean {
  if (!step.taskId) return true;
  if (!kinds.has(step.taskId)) return true;
  return !isEngineOwnedKind(kinds.get(step.taskId));
}

export function countRunSteps(steps: StepRow[], kinds: Map<string, string | null>): SnapshotRunSteps {
  const out: SnapshotRunSteps = { running: 0, waiting: 0, done: 0, failed: 0 };
  for (const s of latestSteps(steps)) {
    if (!isCountedStep(s, kinds)) continue;
    if (s.status === "running") out.running++;
    else if (s.status === "waiting") out.waiting++;
    else if (s.status === "done") out.done++;
    else if (s.status === "failed") out.failed++;
  }
  return out;
}

export function waitsOn(
  run: RunRow,
  steps: StepRow[],
  openPerson: boolean,
  openOrch: boolean,
  kinds: Map<string, string | null>,
): SnapshotWaitsOn {
  if (openPerson) return "you";
  const latest = latestSteps(steps);
  const waitingNoTask = latest.some(s => s.status === "waiting" && !s.taskId);
  const orch = run.orchestratorState;
  if (openOrch || orch === "turn" || orch === "retrying" || orch === "blocked" || waitingNoTask) {
    return "planner";
  }
  if (latest.some(s => (s.status === "running" || s.status === "waiting") && s.taskId && isCountedStep(s, kinds))) {
    return "executors";
  }
  return "nothing";
}

function bestUnblocksRank(blocks: string[]): number {
  let best = 2;
  for (const b of blocks) {
    const r = unblocksRank[b] ?? 2;
    if (r < best) best = r;
  }
  return best;
}

interface StepDbRow {
  run_id: string; step_id: string; attempt: number; branch: string | null; task_id: string | null;
  status: string; result: string | null; error: string | null; started_at: number; ended_at: number | null;
  advanced_at: number | null; trigger: string | null;
}

function stepFromRow(row: StepDbRow): StepRow {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    branch: row.branch ? row.branch : undefined,
    taskId: row.task_id ?? undefined,
    status: row.status as StepRow["status"],
    result: row.result === null ? undefined : JSON.parse(row.result),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    advancedAt: row.advanced_at ?? undefined,
    trigger: row.trigger ?? undefined,
  };
}

/** One query for all steps of the given live run ids. */
function stepsOfLiveRuns(ctx: Ctx, runIds: string[]): Map<string, StepRow[]> {
  const out = new Map<string, StepRow[]>();
  for (const id of runIds) out.set(id, []);
  if (runIds.length === 0) return out;
  const db = workflowDatabase(ctx);
  const ph = runIds.map(() => "?").join(",");
  const rows = db.query<StepDbRow, string[]>(
    `SELECT * FROM workflow_steps WHERE run_id IN (${ph}) ORDER BY started_at, step_id, attempt, branch`,
  ).all(...runIds);
  for (const row of rows) {
    const list = out.get(row.run_id) ?? [];
    list.push(stepFromRow(row));
    out.set(row.run_id, list);
  }
  return out;
}

/** Compose the v3 snapshot `runs` array (live only). Missing workflow tables → []. */
export function composeSnapshotRuns(ctx: Ctx): SnapshotRun[] {
  if (!workflowSchemaPresent(ctx)) return [];
  // Letters: persist only on insert / schema migration; resolve letterless in memory.
  const live = liveRuns(ctx);
  const letters = resolveRunLetters(live);

  const personByRun = new Map<string, string[]>();
  const orchByRun = new Set<string>();
  try {
    for (const q of listOpenPersonQuestions(ctx)) {
      const list = personByRun.get(q.runId) ?? [];
      list.push(q.blocks);
      personByRun.set(q.runId, list);
    }
  } catch { /* missing tables */ }
  try {
    const db = workflowDatabase(ctx);
    const rows = db.query<{ run_id: string }, []>(
      "SELECT DISTINCT run_id FROM workflow_questions WHERE status = 'open' AND answerer = 'orchestrator'",
    ).all();
    for (const r of rows) orchByRun.add(r.run_id);
  } catch { /* missing */ }

  const stepsByRun = stepsOfLiveRuns(ctx, live.map(r => r.id));
  const taskIds: string[] = [];
  for (const steps of stepsByRun.values()) {
    for (const s of steps) if (s.taskId) taskIds.push(s.taskId);
  }
  const kinds = new Map<string, string | null>();
  for (const t of readTasksByIds(ctx, taskIds)) kinds.set(t.id, t.kind);

  const composed: Array<SnapshotRun & { _prio: number; _unblocks: number; _age: number }> = [];
  for (const run of live) {
    if (run.status !== "running" && run.status !== "waiting") continue;
    const steps = stepsByRun.get(run.id) ?? [];
    const entity = runEntityValue(run);
    const priority = asPriority(run.priority);
    const openPerson = personByRun.has(run.id);
    const row: SnapshotRun = {
      id: run.id,
      letter: letters.get(run.id) ?? "A",
      title: run.title,
      workflow: run.workflow,
      ...(run.origin ? { origin: run.origin } : {}),
      status: run.status,
      priority,
      ...(run.pausedReason ? { paused_reason: run.pausedReason } : {}),
      waits_on: waitsOn(run, steps, openPerson, orchByRun.has(run.id), kinds),
      steps: countRunSteps(steps, kinds),
      orchestrator: entity.orchestrator,
    };
    composed.push({
      ...row,
      _prio: priorityRank[priority],
      _unblocks: bestUnblocksRank(personByRun.get(run.id) ?? []),
      _age: run.createdAt,
    });
  }

  composed.sort((a, b) =>
    a._prio - b._prio
    || a._unblocks - b._unblocks
    || a._age - b._age
    || a.id.localeCompare(b.id));

  return composed.map(({ _prio: _p, _unblocks: _u, _age: _a, ...row }) => row);
}
