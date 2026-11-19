import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { taskDatabase } from "../src/tasks/store";
import {
  addDefinition, fireEdge, getDefinition, insertJoinStep, listDefinitions, getCursor, setCursor, getRun, insertRun, insertStep,
  listRuns, liveRuns, stepByTask, stepsOfRun, updateRun, updateStep, workflowDatabase,
  type NewRun, type RunStatus, type StepRow,
} from "../src/workflow/store";
import type { WorkflowDef } from "../src/workflow/schema";

const defV1: WorkflowDef = {
  id: "t/demo",
  version: 1,
  title: "Demo",
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask about it" },
    done: { type: "end" },
  },
  edges: [{ from: "ask", to: "done" }],
  entry: "ask",
};
const srcA = "id: t/demo\nversion: 1\nsteps:\n  ask: { type: agent, kind: research, prompt: Ask about it }\n  done: { type: end }\nedges:\n  - [ask, done]\n";
const srcB = `${srcA}# a different source\n`;

const newRun = (): NewRun => ({ workflow: "t/demo", version: 1, repo: tmpDir(), brief: "Do X", title: "Demo run" });

test("definitions are immutable per version", () => {
  const ctx = fakeCtx();
  expect(addDefinition(ctx, defV1, srcA).created).toBe(true);
  expect(addDefinition(ctx, defV1, srcA).created).toBe(false);
  expect(() => addDefinition(ctx, defV1, srcB)).toThrow(/conflict/);
  expect(getDefinition(ctx, "t/demo")!.version).toBe(1);
});

test("definitions resolve by id@version and list with titles", () => {
  const ctx = fakeCtx();
  addDefinition(ctx, defV1, srcA);
  const defV2: WorkflowDef = { ...defV1, version: 2 };
  addDefinition(ctx, defV2, srcB);
  expect(getDefinition(ctx, "t/demo@1")!.version).toBe(1);
  expect(getDefinition(ctx, "t/demo")!.version).toBe(2);
  expect(getDefinition(ctx, "t/none")).toBeNull();
  expect(getDefinition(ctx, "t/demo@9")).toBeNull();
  const listed = listDefinitions(ctx);
  expect(listed).toHaveLength(2);
  expect(listed[0]).toMatchObject({ id: "t/demo", version: 1, title: "Demo" });
});

test("run updates need the current rev", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  expect(r.status).toBe("running");
  expect(r.rev).toBe(1);
  expect(r.id).toMatch(/^run_[a-z2-7]{10}$/);
  const updated = updateRun(ctx, r.id, r.rev, { status: "waiting" });
  expect(updated.rev).toBe(2);
  expect(updated.status).toBe("waiting");
  expect(() => updateRun(ctx, r.id, r.rev, { status: "done" })).toThrow(/conflict/);
  expect(() => updateRun(ctx, "run_missing0000", 1, { status: "done" })).toThrow(/unknown run/);
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
  expect(getRun(ctx, "run_missing0000")).toBeNull();
});

test("runs record loops and list by status", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  insertRun(ctx, { ...newRun(), workflow: "t/other" });
  updateRun(ctx, r.id, r.rev, { status: "failed", reason: "step ask failed", loops: { "check->ask": 1 } });
  const stored = getRun(ctx, r.id)!;
  expect(stored.loops).toEqual({ "check->ask": 1 });
  expect(stored.reason).toBe("step ask failed");
  const failed = listRuns(ctx, "failed" as RunStatus);
  expect(failed.map(run => run.id)).toEqual([r.id]);
  expect(listRuns(ctx)).toHaveLength(2);
});

test("a task id maps to at most one step", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  const first = insertStep(ctx, { runId: r.id, stepId: "ask", attempt: 1, taskId: "t-1", status: "running" });
  expect(first.status).toBe("running");
  expect(first.startedAt).toBeGreaterThan(0);
  expect(() => insertStep(ctx, { runId: r.id, stepId: "other", attempt: 1, taskId: "t-1", status: "running" })).toThrow();
  insertStep(ctx, { runId: r.id, stepId: "ask", attempt: 2, status: "running" }); // no task id, new attempt
  const steps = stepsOfRun(ctx, r.id);
  expect(steps).toHaveLength(2);
  expect(steps[0].taskId).toBe("t-1");
  expect(steps[1].branch).toBeUndefined();
  expect(stepByTask(ctx, "t-1")!.stepId).toBe("ask");
  expect(stepByTask(ctx, "t-none")).toBeNull();
});

test("branch and attempt make the step key", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  insertStep(ctx, { runId: r.id, stepId: "review", attempt: 1, branch: "alpha", taskId: "t-a", status: "running" });
  insertStep(ctx, { runId: r.id, stepId: "review", attempt: 1, branch: "beta", taskId: "t-b", status: "running" });
  const done = updateStep(ctx, { runId: r.id, stepId: "review", attempt: 1, branch: "alpha" }, { status: "done", result: { verdict: "pass" }, endedAt: ctx.now + 5 });
  expect(done.status).toBe("done");
  expect(done.result).toEqual({ verdict: "pass" });
  expect(done.endedAt).toBe(ctx.now + 5);
  const untouched = stepsOfRun(ctx, r.id).find((s: StepRow) => s.branch === "beta")!;
  expect(untouched.status).toBe("running");
  expect(untouched.result).toBeUndefined();
  expect(() => updateStep(ctx, { runId: r.id, stepId: "review", attempt: 9, branch: "alpha" }, { status: "done" })).toThrow(/unknown step/);
});

test("tables live in the task store", () => {
  const ctx = fakeCtx();
  workflowDatabase(ctx);
  for (const name of ["workflow_defs", "workflow_runs", "workflow_steps", "workflow_cursor"]) {
    expect(taskDatabase(ctx).query("SELECT name FROM sqlite_master WHERE name = ?").get(name)).toBeTruthy();
  }
});

test("the cursor persists and defaults to zero", () => {
  const ctx = fakeCtx();
  expect(getCursor(ctx)).toBe(0);
  setCursor(ctx, 42);
  expect(getCursor(ctx)).toBe(42);
  setCursor(ctx, 43);
  expect(getCursor(ctx)).toBe(43);
});

test("firing an edge is exclusive and records the trigger on the successor", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  insertStep(ctx, { runId: r.id, stepId: "a", attempt: 1, status: "running" }); // an entry step: no trigger
  const fire = { runId: r.id, from: { stepId: "a", attempt: 1 }, edgeIndex: 3, stepId: "b", status: "running" as const };
  const fired = fireEdge(ctx, fire);
  expect(fired.kind).toBe("fired");
  const row = stepsOfRun(ctx, r.id).find(s => s.stepId === "b")!;
  expect(row.trigger).toBe(`${r.id}/a#1/@3`);
  expect(row.attempt).toBe(1);
  // A second firing of the same edge is skipped: the trigger already exists.
  expect(fireEdge(ctx, fire).kind).toBe("handled");
  expect(stepsOfRun(ctx, r.id).filter(s => s.stepId === "b")).toHaveLength(1);
  // A different edge of the same predecessor fires its own successor and attempt.
  const other = fireEdge(ctx, { ...fire, edgeIndex: 4 });
  expect(other.kind).toBe("fired");
  expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "b" && s.trigger === `${r.id}/a#1/@4`)!.attempt).toBe(2);
});

test("a back-edge loop patch is written inside the trigger transaction, without a rev check", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  insertStep(ctx, { runId: r.id, stepId: "a", attempt: 1, status: "running" });
  updateRun(ctx, r.id, r.rev, { status: "waiting" }); // the rev moves on, like a concurrent run.answer
  const stale = getRun(ctx, r.id)!.rev - 1; // a rev the caller read before the patch above
  const fired = fireEdge(ctx, {
    runId: r.id,
    from: { stepId: "a", attempt: 1 },
    edgeIndex: 0,
    stepId: "w",
    status: "waiting",
    back: { key: "a->w", maxLoops: 2 },
  });
  if (fired.kind !== "fired") throw new Error(`expected fired, got ${fired.kind}`);
  expect(fired.loops).toEqual({ "a->w": 1 }); // a healthy loop never fails over a stale rev
  expect(getRun(ctx, r.id)!.loops).toEqual({ "a->w": 1 });
  const secondLoop = fireEdge(ctx, { runId: r.id, from: { stepId: "a", attempt: 2 }, edgeIndex: 0, stepId: "w", status: "waiting", back: { key: "a->w", maxLoops: 2 } });
  const thirdLoop = fireEdge(ctx, { runId: r.id, from: { stepId: "a", attempt: 3 }, edgeIndex: 0, stepId: "w", status: "waiting", back: { key: "a->w", maxLoops: 2 } });
  expect(thirdLoop.kind).toBe("loop-limit"); // 3 > maxLoops 2: no successor, the run fails
  if (thirdLoop.kind !== "loop-limit") throw new Error(`expected loop-limit, got ${thirdLoop.kind}`);
  expect(thirdLoop.loops).toEqual({ "a->w": 3 });
  if (secondLoop.kind !== "fired") throw new Error(`expected fired, got ${secondLoop.kind}`);
  expect(secondLoop.loops).toEqual({ "a->w": 2 });
  expect(stepsOfRun(ctx, r.id).filter(s => s.stepId === "w")).toHaveLength(2); // only the two fired loops started w
  expect(stale).toBeLessThan(getRun(ctx, r.id)!.rev); // the loop patches bumped the rev past the stale one
});

test("the join row insert is atomic: the loser of two concurrent joins returns null", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  insertStep(ctx, { runId: r.id, stepId: "check", attempt: 1, branch: "x", status: "done" });
  insertStep(ctx, { runId: r.id, stepId: "check", attempt: 1, branch: "y", status: "done" });
  const result = { branches: { x: { v: 1 }, y: { v: 2 } }, done: 2, failed: 0 };
  const winner = insertJoinStep(ctx, r.id, "check", 1, "done", result);
  expect(winner?.status).toBe("done");
  expect(winner?.result).toEqual(result);
  // The concurrent loser's insert lands on the same attempt key: it is ignored and
  // returns null instead of failing a healthy run on the PRIMARY KEY
  // (round 4 review).
  expect(insertJoinStep(ctx, r.id, "check", 1, "done", result)).toBeNull();
  expect(stepsOfRun(ctx, r.id).filter(s => s.branch === undefined)).toHaveLength(1);
});

test("fireEdge refuses to start a successor in a run that is no longer live", () => {
  const ctx = fakeCtx();
  const r = insertRun(ctx, newRun());
  insertStep(ctx, { runId: r.id, stepId: "a", attempt: 1, status: "running" });
  // The stop lands between the caller's terminal check and the fire: inside the
  // trigger transaction the run is re-checked, nothing is inserted and the fire
  // reports terminal (round 4 review).
  updateRun(ctx, r.id, r.rev, { status: "stopped" });
  const outcome = fireEdge(ctx, { runId: r.id, from: { stepId: "a", attempt: 1 }, edgeIndex: 0, stepId: "b", status: "running" });
  expect(outcome.kind).toBe("terminal");
  expect(stepsOfRun(ctx, r.id)).toHaveLength(1); // no running successor row in the stopped run
  // A vanished run behaves the same.
  workflowDatabase(ctx).query("DELETE FROM workflow_runs WHERE id = ?").run(r.id);
  expect(fireEdge(ctx, { runId: r.id, from: { stepId: "a", attempt: 1 }, edgeIndex: 1, stepId: "b", status: "running" }).kind).toBe("terminal");
});

test("liveRuns filters by status in SQL and the per-second step queries have partial indexes", () => {
  const ctx = fakeCtx();
  const live = insertRun(ctx, newRun());
  const done = insertRun(ctx, { ...newRun(), workflow: "t/other" });
  const stopped = insertRun(ctx, { ...newRun(), workflow: "t/third" });
  updateRun(ctx, done.id, done.rev, { status: "done" });
  updateRun(ctx, stopped.id, stopped.rev, { status: "stopped" });
  expect(liveRuns(ctx).map(run => run.id)).toEqual([live.id]); // terminal runs are filtered out in SQL
  const indexSql = (name: string): string =>
    (workflowDatabase(ctx).query<{ sql: string | null }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?").get(name)?.sql ?? "");
  expect(indexSql("workflow_steps_live")).toContain("WHERE status IN ('running', 'waiting')");
  expect(indexSql("workflow_steps_unadvanced")).toContain("status = 'done' AND advanced_at IS NULL");
});
