import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask, taskDatabase } from "../src/tasks/store";
import { getWork, registerWork, setWorkDependencies } from "../src/dispatch/work";
import {
  addDefinition, getRun, stepsOfRun, workflowDatabase,
} from "../src/workflow/store";
import { onTaskSettled, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { advanceRuns } from "../src/workflow/tick";
import type { TaskRecord } from "../src/tasks/types";
import type { WorkflowDef } from "../src/workflow/schema";
import type { Ctx } from "../src/types";

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(ctx, prior.id) ?? prior;
    const task = createTask(ctx, {
      brief: input.brief,
      kind: input.kind ?? null,
      requestedExecutor: null,
      timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.workParent) {
      registerWork(ctx, task.id, input.dispatch ?? {}, input.workParent, input.workGrant);
      if (input.dependencies?.length) {
        setWorkDependencies(ctx, task.id, input.dependencies, readTask(ctx, task.id)!.rev);
      }
    }
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx: Ctx, id: string) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
    } satisfies EngineDeps,
  };
}

const chainV1: WorkflowDef = {
  id: "t/pin-chain",
  version: 1,
  steps: {
    one: { type: "agent", kind: "research", prompt: "One" },
    two: { type: "agent", kind: "research", prompt: "Two" },
    done: { type: "end" },
  },
  edges: [
    { from: "one", to: "two" },
    { from: "two", to: "done" },
  ],
  entry: "one",
};

const chainV2WithGenerate: WorkflowDef = {
  id: "t/pin-chain",
  version: 2,
  steps: {
    plan: {
      type: "generate",
      prompt: "Plan",
      limits: { step_types: ["agent", "human", "fanout"], max_steps: 5 },
    },
    done: { type: "end" },
  },
  edges: [{ from: "plan", to: "done" }],
  entry: "plan",
};

/** Phase 1 base tables only — no step_mode / root_task_id / Phase 2 columns. */
function installPhase1Schema(ctx: Ctx): void {
  const db = taskDatabase(ctx);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_defs(id TEXT, version INTEGER, source TEXT, def TEXT, added_at REAL, PRIMARY KEY(id, version));
    CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT, status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL);
    CREATE TABLE IF NOT EXISTS workflow_steps(run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT, task_id TEXT UNIQUE, status TEXT, result TEXT, error TEXT, started_at REAL, ended_at REAL, PRIMARY KEY(run_id, step_id, attempt, branch));
    CREATE TABLE IF NOT EXISTS workflow_cursor(id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER);
  `);
}

test("Phase 1 live run upgraded in place finishes as plain; a new run gets work_node", async () => {
  const ctx = fakeCtx();
  installPhase1Schema(ctx);
  const repo = tmpDir();
  const now = ctx.now;
  const defJson = JSON.stringify(chainV1);
  const db = taskDatabase(ctx);
  db.query(
    "INSERT INTO workflow_defs(id, version, source, def, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(chainV1.id, 1, "phase1", defJson, now);
  const runId = "run_phase1plain";
  db.query(
    "INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, chainV1.id, 1, repo, "B", chainV1.id, "running", null, "{}", 1, now, now);

  // Mid-step: entry step running with a plain task (no work node).
  const task = createTask(ctx, {
    brief: { goal: "One", repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
    requestId: `wf:${runId}:one:1:`,
  });
  db.query(
    "INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, "one", 1, "", task.id, "running", null, null, now, null);

  // Upgrade through the atomic schema path (one immediate transaction): Phase 3
  // columns + workflow_graphs land together; pre-existing rows read as plain.
  workflowDatabase(ctx);
  const dbUp = workflowDatabase(ctx);
  const cols = dbUp.query<{ name: string }, []>("PRAGMA table_info(workflow_runs)").all().map(c => c.name);
  expect(cols).toContain("step_mode");
  expect(cols).toContain("root_task_id");
  expect(dbUp.query<{ name: string }, []>("PRAGMA table_info(workflow_graphs)").all().map(c => c.name)).toContain("def");
  expect(getRun(ctx, runId)!.stepMode).toBe("plain");
  expect(getRun(ctx, runId)!.rootTaskId).toBeUndefined();

  const { deps } = fakeDeps();
  recordStepResult(ctx, task.id, { ok: true });
  updateTask(ctx, task.id, t => { t.state = "done"; });
  await onTaskSettled(ctx, task.id, undefined, deps);

  const two = stepsOfRun(ctx, runId).find(s => s.stepId === "two");
  expect(two).toBeTruthy();
  expect(two!.taskId).toBeTruthy();
  expect(getWork(ctx, two!.taskId!)).toBeNull(); // plain: no work node
  expect(getRun(ctx, runId)!.stepMode).toBe("plain");
  expect(getRun(ctx, runId)!.rootTaskId).toBeUndefined();

  recordStepResult(ctx, two!.taskId!, { ok: true });
  updateTask(ctx, two!.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, two!.taskId!, undefined, deps);
  expect(getRun(ctx, runId)!.status).toBe("done");

  // Same home: a new run pins work_node.
  addDefinition(ctx, chainV1, "phase1"); // idempotent same source may conflict — use get
  const { deps: deps2 } = fakeDeps();
  // Definition already present; startRun looks it up.
  const neu = await startRun(ctx, { workflow: "t/pin-chain", repo: tmpDir(), brief: "new" }, undefined, deps2);
  expect(getRun(ctx, neu.id)!.stepMode).toBe("work_node");
  expect(getRun(ctx, neu.id)!.rootTaskId).toBeTruthy();
  const entry = stepsOfRun(ctx, neu.id)[0]!;
  expect(getWork(ctx, entry.taskId!)).toBeTruthy();
});

test("a plain run stays pinned to its started definition version when a generate version is added", async () => {
  const ctx = fakeCtx();
  installPhase1Schema(ctx);
  const repo = tmpDir();
  const now = ctx.now;
  const db = taskDatabase(ctx);
  db.query(
    "INSERT INTO workflow_defs(id, version, source, def, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(chainV1.id, 1, "v1", JSON.stringify(chainV1), now);
  const runId = "run_pinned_def";
  db.query(
    "INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, chainV1.id, 1, repo, "B", chainV1.id, "running", null, "{}", 1, now, now);
  const task = createTask(ctx, {
    brief: { goal: "One", repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
    requestId: `wf:${runId}:one:1:`,
  });
  db.query(
    "INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, "one", 1, "", task.id, "running", null, null, now, null);

  workflowDatabase(ctx);
  addDefinition(ctx, chainV2WithGenerate, "v2");
  expect(getRun(ctx, runId)!.version).toBe(1);
  expect(getRun(ctx, runId)!.stepMode).toBe("plain");

  const { deps } = fakeDeps();
  recordStepResult(ctx, task.id, { ok: true });
  updateTask(ctx, task.id, t => { t.state = "done"; });
  await onTaskSettled(ctx, task.id, undefined, deps);
  const two = stepsOfRun(ctx, runId).find(s => s.stepId === "two");
  expect(two?.stepId).toBe("two");
  expect(stepsOfRun(ctx, runId).some(s => s.stepId === "plan")).toBe(false);
});

test("the tick settles both plain and work_node runs", async () => {
  const ctx = fakeCtx();
  // Plain upgraded run
  installPhase1Schema(ctx);
  const repo = tmpDir();
  const now = ctx.now;
  const db = taskDatabase(ctx);
  db.query(
    "INSERT INTO workflow_defs(id, version, source, def, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(chainV1.id, 1, "tick", JSON.stringify(chainV1), now);
  const plainId = "run_tick_plain";
  db.query(
    "INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(plainId, chainV1.id, 1, repo, "P", chainV1.id, "running", null, "{}", 1, now, now);
  const plainTask = createTask(ctx, {
    brief: { goal: "One", repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
    requestId: `wf:${plainId}:one:1:`,
  });
  db.query(
    "INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(plainId, "one", 1, "", plainTask.id, "running", null, null, now, null);
  workflowDatabase(ctx);

  const { deps } = fakeDeps();
  const wn = await startRun(ctx, { workflow: "t/pin-chain", repo: tmpDir(), brief: "W" }, undefined, deps);
  expect(getRun(ctx, wn.id)!.stepMode).toBe("work_node");
  const wnOne = stepsOfRun(ctx, wn.id).find(s => s.stepId === "one")!;

  recordStepResult(ctx, plainTask.id, { ok: true });
  updateTask(ctx, plainTask.id, t => { t.state = "done"; });
  recordStepResult(ctx, wnOne.taskId!, { ok: true });
  updateTask(ctx, wnOne.taskId!, t => { t.state = "done"; });

  // Drive both through the change-log tick (same path as serve).
  await advanceRuns(ctx, undefined, deps);

  expect(stepsOfRun(ctx, plainId).some(s => s.stepId === "two")).toBe(true);
  expect(stepsOfRun(ctx, wn.id).some(s => s.stepId === "two")).toBe(true);
  expect(getWork(ctx, stepsOfRun(ctx, plainId).find(s => s.stepId === "two")!.taskId!)).toBeNull();
  expect(getWork(ctx, stepsOfRun(ctx, wn.id).find(s => s.stepId === "two")!.taskId!)).toBeTruthy();
});
