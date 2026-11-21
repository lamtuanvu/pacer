// Phase 2 Task 1: durable wake-up and turn tables, claim/release, and the
// needs-orchestrator scan that recreates a lost wake-up (spec Review Focus 1).
import { expect, test } from "bun:test";
import { createTask } from "../src/tasks/store";
import {
  addWakeup,
  claimWakeups,
  completeWakeups,
  insertTurn,
  needsOrchestrator,
  openWakeups,
  releaseWakeups,
  type WakeCause,
} from "../src/workflow/wakeups";
import { insertRun, insertStep, workflowDatabase } from "../src/workflow/store";
import { fakeCtx, tmpDir } from "./helpers";

const NOW = 1_700_000_000;

test("duplicate (run, cause, ref) wake-ups are ignored", () => {
  const ctx = fakeCtx({ now: NOW });
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
  const db = workflowDatabase(ctx);
  addWakeup(db, { runId: run.id, cause: "step_failed", ref: "ask#1" });
  addWakeup(db, { runId: run.id, cause: "step_failed", ref: "ask#1" });
  addWakeup(db, { runId: run.id, cause: "step_failed", ref: "ask#1", byPerson: true });
  const open = openWakeups(ctx, run.id);
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({
    runId: run.id,
    cause: "step_failed" satisfies WakeCause,
    ref: "ask#1",
    byPerson: false,
  });
  expect(open[0]!.turnId).toBeUndefined();
  expect(open[0]!.doneAt).toBeUndefined();
});

test("claim takes every open wake-up; release returns them; complete closes them", () => {
  const ctx = fakeCtx({ now: NOW });
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
  const db = workflowDatabase(ctx);
  addWakeup(db, { runId: run.id, cause: "step_settled", ref: "a#1" });
  addWakeup(db, { runId: run.id, cause: "question", ref: "q-1", byPerson: true });
  const turn = insertTurn(ctx, {
    id: "turn_1",
    runId: run.id,
    planner: "claude-code",
    status: "starting",
    startedAt: NOW,
    deadline: NOW + 1200,
  });
  const claimed = claimWakeups(ctx, run.id, turn.id);
  expect(claimed.map(w => w.ref).sort()).toEqual(["a#1", "q-1"]);
  expect(openWakeups(ctx, run.id)).toHaveLength(0);
  expect(claimed.every(w => w.turnId === turn.id)).toBe(true);

  releaseWakeups(ctx, turn.id);
  const reopened = openWakeups(ctx, run.id);
  expect(reopened).toHaveLength(2);
  expect(reopened.every(w => w.turnId === undefined)).toBe(true);

  const again = claimWakeups(ctx, run.id, turn.id);
  expect(again).toHaveLength(2);
  completeWakeups(ctx, turn.id);
  expect(openWakeups(ctx, run.id)).toHaveLength(0);
  const done = workflowDatabase(ctx).query<{ done_at: number | null }, [string]>(
    "SELECT done_at FROM workflow_wakeups WHERE turn_id = ?",
  ).all(turn.id);
  expect(done).toHaveLength(2);
  expect(done.every(r => r.done_at === NOW)).toBe(true);
});

test("the partial unique index refuses a second live turn for one run", () => {
  const ctx = fakeCtx({ now: NOW });
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
  insertTurn(ctx, {
    id: "turn_live",
    runId: run.id,
    planner: "claude-code",
    status: "running",
    startedAt: NOW,
    deadline: NOW + 1200,
  });
  expect(() => insertTurn(ctx, {
    id: "turn_other",
    runId: run.id,
    planner: "claude-code",
    status: "starting",
    startedAt: NOW,
    deadline: NOW + 1200,
  })).toThrow(/UNIQUE/);
  // A finished turn does not block a new live one.
  workflowDatabase(ctx).query(
    "UPDATE workflow_turns SET status = 'done', ended_at = ? WHERE id = ?",
  ).run(NOW, "turn_live");
  const next = insertTurn(ctx, {
    id: "turn_next",
    runId: run.id,
    planner: "claude-code",
    status: "starting",
    startedAt: NOW,
    deadline: NOW + 1200,
  });
  expect(next.id).toBe("turn_next");
});

test("needsOrchestrator finds a failed step whose wake-up was deleted and ignores live turns", () => {
  const ctx = fakeCtx({ now: NOW });
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, status: "failed", taskId: "t-ask" });
  // No wake-up yet: the scan reports the missing one.
  expect(needsOrchestrator(ctx)).toEqual([
    expect.objectContaining({ runId: run.id, cause: "step_failed", ref: `${run.id}/ask#1` }),
  ]);

  const db = workflowDatabase(ctx);
  addWakeup(db, { runId: run.id, cause: "step_failed", ref: `${run.id}/ask#1` });
  expect(needsOrchestrator(ctx)).toEqual([]);

  // A deleted wake-up is found again.
  db.query("DELETE FROM workflow_wakeups WHERE run_id = ?").run(run.id);
  expect(needsOrchestrator(ctx)).toEqual([
    expect.objectContaining({ runId: run.id, cause: "step_failed", ref: `${run.id}/ask#1` }),
  ]);

  // A live turn suppresses the scan for that run.
  insertTurn(ctx, {
    id: "turn_hold",
    runId: run.id,
    planner: "claude-code",
    status: "running",
    startedAt: NOW,
    deadline: NOW + 1200,
  });
  expect(needsOrchestrator(ctx)).toEqual([]);
});

test("ordinary task rows are untouched by the wake-up tables", () => {
  const ctx = fakeCtx({ now: NOW });
  const task = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const before = workflowDatabase(ctx).query<{ n: number }, []>(
    "SELECT count(*) AS n FROM workflow_wakeups",
  ).get()!.n;
  expect(before).toBe(0);
  // Touching the schema does not invent wake-ups for ordinary tasks.
  expect(openWakeups(ctx, "run_notareal")).toEqual([]);
  expect(needsOrchestrator(ctx)).toEqual([]);
  expect(workflowDatabase(ctx).query<{ n: number }, []>(
    "SELECT count(*) AS n FROM workflow_wakeups",
  ).get()!.n).toBe(0);
  // The ordinary task still loads.
  expect(task.id).toBeTruthy();
});

test("workflow_runs gains the orchestrator columns in place", () => {
  const ctx = fakeCtx({ now: NOW });
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "b" });
  const cols = workflowDatabase(ctx).query<{ name: string }, []>("PRAGMA table_info(workflow_runs)").all().map(c => c.name);
  for (const name of ["auto", "planner", "orchestrator_task_id", "session_id", "budget", "spent"]) {
    expect(cols).toContain(name);
  }
  const row = workflowDatabase(ctx).query<Record<string, unknown>, [string]>(
    "SELECT auto, planner, orchestrator_task_id, session_id, budget, spent FROM workflow_runs WHERE id = ?",
  ).get(run.id)!;
  expect(row.auto).toBe(0);
  expect(row.planner).toBeNull();
});
