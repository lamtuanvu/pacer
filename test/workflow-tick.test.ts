import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskState } from "../src/tasks/types";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { addDefinition, claimStepSettlement, getCursor, getRun, insertRun, insertStep, setCursor, stepsOfRun, updateStep, workflowDatabase } from "../src/workflow/store";
import { answerHumanStep, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { advanceRuns } from "../src/workflow/tick";
import { taskChangesSince } from "../src/tasks/changes";
import type { WorkflowDef } from "../src/workflow/schema";

/** The same delegation stub the engine tests use: createTask with the input's
 *  brief and a request-id dedupe, so tasks settle through updateTask. */
function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const inputs: Parameters<EngineDeps["delegate"]>[1][] = [];
  const delegate: EngineDeps["delegate"] = async (ctx, input) => {
    inputs.push(input);
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
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  const deps: EngineDeps = {
    delegate,
    stopTask: (ctx, id) => updateTask(ctx, id, t => { t.state = "stopped"; }),
  };
  return { deps, inputs };
}

const settle = (ctx: Ctx, taskId: string, state: TaskState = "done") => updateTask(ctx, taskId, t => { t.state = state; });

const demo: WorkflowDef = {
  id: "t/demo",
  version: 1,
  steps: {
    draft: { type: "agent", kind: "research", prompt: "Draft: {{brief}}" },
    approve: { type: "human", question: { text: "Approve the draft?", kind: "approve_revise" } },
    done: { type: "end" },
  },
  edges: [
    { from: "draft", to: "approve" },
    { from: "approve", to: "done", when: "result.answer == 'approve'" },
  ],
  entry: "draft",
};

const chain: WorkflowDef = {
  id: "t/chain",
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

test("settling a step task advances its run once", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  const first = await advanceRuns(ctx, undefined, deps);
  expect(first.rescanned).toBe(false);
  expect(first.handled).toBe(1);
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
  expect(stepsOfRun(ctx, r.id)).toHaveLength(2);
  const second = await advanceRuns(ctx, undefined, deps);
  expect(second.handled).toBe(0);
  expect(second.rescanned).toBe(false);
  expect(stepsOfRun(ctx, r.id)).toHaveLength(2);
  await answerHumanStep(ctx, r.id, "approve", "approve", getRun(ctx, r.id)!.rev);
  expect(getRun(ctx, r.id)!.status).toBe("done");
});

test("a gap triggers a rescan and still advances", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  setCursor(ctx, 10_000_000);
  const out = await advanceRuns(ctx, undefined, deps);
  expect(out.rescanned).toBe(true);
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
  expect(stepsOfRun(ctx, r.id)).toHaveLength(2);
});

test("restart: a fresh ctx on the same home resumes from the stored cursor", async () => {
  const home = tmpDir();
  const ctx1 = fakeCtx({ home });
  addDefinition(ctx1, chain, "source");
  const { deps: deps1 } = fakeDeps();
  const r = await startRun(ctx1, { workflow: "t/chain", repo: tmpDir(), brief: "B" }, undefined, deps1);
  const s1 = stepsOfRun(ctx1, r.id)[0];
  recordStepResult(ctx1, s1.taskId!, { n: 1 });
  settle(ctx1, s1.taskId!);
  await advanceRuns(ctx1, undefined, deps1);
  expect(getRun(ctx1, r.id)!.status).toBe("running");
  expect(stepsOfRun(ctx1, r.id)).toHaveLength(2);
  const cursor = getCursor(ctx1);

  const ctx2 = fakeCtx({ home, now: ctx1.now + 5 });
  expect(getCursor(ctx2)).toBe(cursor); // the cursor survived the restart
  const { deps: deps2 } = fakeDeps();
  const s2 = stepsOfRun(ctx2, r.id).find(s => s.stepId === "two")!;
  expect(s2.status).toBe("running");
  recordStepResult(ctx2, s2.taskId!, { n: 2 });
  settle(ctx2, s2.taskId!);
  const out = await advanceRuns(ctx2, undefined, deps2);
  expect(out.handled).toBe(1); // only the new settlement, not the replayed history
  expect(getRun(ctx2, r.id)!.status).toBe("done");
  expect(stepsOfRun(ctx2, r.id)).toHaveLength(2);
});

test("one run's start failure does not block another run in the same batch", async () => {  const ctx = fakeCtx();
  addDefinition(ctx, chain, "source");
  addDefinition(ctx, demo, "source");
  const { deps: base } = fakeDeps();
  const deps: EngineDeps = {
    delegate: (c, input, spawn) => input.brief.goal.includes("Two")
      ? Promise.reject(new Error("no executor available"))
      : base.delegate(c, input, spawn),
    stopTask: base.stopTask,
  };
  const r1 = await startRun(ctx, { workflow: "t/chain", repo: tmpDir(), brief: "B" }, undefined, deps);
  const r2 = await startRun(ctx, { workflow: "t/demo", repo: tmpDir(), brief: "B" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r1.id)[0];
  recordStepResult(ctx, s1.taskId!, { n: 1 });
  settle(ctx, s1.taskId!);
  const s2 = stepsOfRun(ctx, r2.id)[0];
  recordStepResult(ctx, s2.taskId!, { n: 2 });
  settle(ctx, s2.taskId!);
  const head = taskChangesSince(ctx, getCursor(ctx)).head;

  const out = await advanceRuns(ctx, undefined, deps); // one call handles both changes
  const failed = getRun(ctx, r1.id)!;
  expect(failed.status).toBe("failed");
  expect(failed.reason).toBe("start failed: two: no executor available");
  expect(getRun(ctx, r2.id)!.status).toBe("waiting"); // run 2 still advanced
  expect(stepsOfRun(ctx, r2.id)).toHaveLength(2);
  expect(getCursor(ctx)).toBe(head); // the cursor reached head despite run 1's error
});

test("a backlog longer than one change page still settles steps after row 500", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/demo", repo: tmpDir(), brief: "B" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  // 260 tasks write two changes each, so the step settlement lands past the first
  // 500-row page of task_changes.
  for (let i = 0; i < 260; i++) {
    const plain = createTask(ctx, { brief: { goal: `noise ${i}`, repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, plain.id, t => { t.state = "done"; });
  }
  expect(taskChangesSince(ctx, 0).changes.length).toBe(500); // the page really is full
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  const head = taskChangesSince(ctx, getCursor(ctx)).head;
  const out = await advanceRuns(ctx, undefined, deps);
  expect(out.handled).toBe(1); // only the step settlement, not the page of noise
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
  expect(getCursor(ctx)).toBe(head); // the cursor drained the whole backlog
});

test("an orphan step row is reconciled on every tick, without a gap", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "B" });
  const task = createTask(ctx, {
    brief: { goal: "Draft", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600,
    requestId: `wf:${run.id}:draft:1:`,
  });
  // The crash: the step row exists with no task id, the task already settled.
  insertStep(ctx, { runId: run.id, stepId: "draft", attempt: 1, status: "running" });
  updateStep(ctx, { runId: run.id, stepId: "draft", attempt: 1 }, { result: { ok: true } });
  updateTask(ctx, task.id, t => { t.state = "done"; });
  // No cursor gap: the cursor sits at head, so reconciliation must happen anyway.
  const head = taskChangesSince(ctx, getCursor(ctx)).head;
  setCursor(ctx, head);
  const out = await advanceRuns(ctx, undefined, deps);
  expect(out.rescanned).toBe(false);
  const row = stepsOfRun(ctx, run.id).find(s => s.stepId === "draft")!;
  expect(row.taskId).toBe(task.id);
  expect(row.status).toBe("done");
  expect(getRun(ctx, run.id)!.status).toBe("waiting"); // the recovered step advanced the run
});

test("an orphan without a task is re-delegated after 60 seconds, and not before", async () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home });
  addDefinition(ctx, demo, "source");
  const { deps, inputs } = fakeDeps();
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "B" });
  insertStep(ctx, { runId: run.id, stepId: "draft", attempt: 1, status: "running" });
  await advanceRuns(ctx, undefined, deps);
  expect(inputs).toHaveLength(0); // the delegation may still be in flight: nothing happens
  const young = stepsOfRun(ctx, run.id).find(s => s.stepId === "draft")!;
  expect(young.status).toBe("running");
  expect(young.taskId).toBeUndefined();

  const ctx2 = fakeCtx({ home, now: ctx.now + 61 });
  await advanceRuns(ctx2, undefined, deps);
  expect(inputs).toHaveLength(1); // delegated again, once
  const row = stepsOfRun(ctx2, run.id).find(s => s.stepId === "draft")!;
  expect(row.taskId).toBeDefined();
  expect(row.attempt).toBe(1); // the same attempt, so the request id stays consistent
  expect(readTask(ctx2, row.taskId!)!.requestId).toBe(`wf:${run.id}:draft:1:`);
});

test("a step marked done but never advanced is re-advanced by the next tick", async () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home });
  addDefinition(ctx, chain, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/chain", repo: tmpDir(), brief: "B" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { n: 1 });
  settle(ctx, s1.taskId!);
  // The crash: the settlement was claimed (the row is done) but advanceFrom never
  // ran, so the successor never started and the row has no advanced_at.
  const claimed = claimStepSettlement(ctx, { runId: r.id, stepId: "one", attempt: 1 }, { status: "done", endedAt: ctx.now });
  expect(claimed?.status).toBe("done");
  // A tick right away is too early: the row is younger than 5 seconds, so its own
  // caller may still be advancing it.
  await advanceRuns(ctx, undefined, deps);
  expect(getRun(ctx, r.id)!.status).toBe("running");
  expect(stepsOfRun(ctx, r.id)).toHaveLength(1);

  const ctx2 = fakeCtx({ home, now: ctx.now + 6 });
  await advanceRuns(ctx2, undefined, deps);
  expect(getRun(ctx2, r.id)!.status).toBe("running"); // advanced to step two
  const rows = stepsOfRun(ctx2, r.id);
  expect(rows).toHaveLength(2);
  expect(rows.find(s => s.stepId === "one")!.advancedAt).toBeDefined(); // the replay recorded itself
  const two = rows.find(s => s.stepId === "two")!;
  expect(two.status).toBe("running");
  // The recovered chain finishes normally.
  recordStepResult(ctx2, two.taskId!, { n: 2 });
  settle(ctx2, two.taskId!);
  await advanceRuns(ctx2, undefined, deps);
  expect(getRun(ctx2, r.id)!.status).toBe("done");
});

test("a run answer whose run patch conflicted still ends with the run advanced after a tick", async () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home });
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  await advanceRuns(ctx, undefined, deps);
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
  // The crash on the answer path: the human step was marked done with its answer,
  // but the run patch (and the advance) conflicted, so the run is still waiting and
  // the row has no advanced_at.
  updateStep(ctx, { runId: r.id, stepId: "approve", attempt: 1 }, { status: "done", result: { answer: "approve" }, endedAt: ctx.now });
  expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "approve")!.advancedAt).toBeUndefined();

  const ctx2 = fakeCtx({ home, now: ctx.now + 6 });
  await advanceRuns(ctx2, undefined, deps);
  expect(getRun(ctx2, r.id)!.status).toBe("done"); // the answer was recovered, not lost
  expect(stepsOfRun(ctx2, r.id).find(s => s.stepId === "approve")!.advancedAt).toBeDefined();
});

test("a change whose settlement keeps failing transiently is given up after 5 retries; the healthy run after it still advances", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, chain, "source");
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r1 = await startRun(ctx, { workflow: "t/chain", repo: tmpDir(), brief: "A" }, undefined, deps);
  const r2 = await startRun(ctx, { workflow: "t/demo", repo: tmpDir(), brief: "B" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r1.id)[0];
  recordStepResult(ctx, s1.taskId!, { n: 1 });
  settle(ctx, s1.taskId!);
  const s2 = stepsOfRun(ctx, r2.id)[0];
  recordStepResult(ctx, s2.taskId!, { n: 2 });
  settle(ctx, s2.taskId!);
  // A persistent transient error on run 1's settlement only: every write to its step
  // rows aborts with a lock message (a real SQLite RAISE, the error isTransientError
  // recognises), while run 2 stays writable.
  workflowDatabase(ctx).exec(
    `CREATE TRIGGER wf_lock_test BEFORE UPDATE ON workflow_steps WHEN OLD.run_id = '${r1.id}' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
  // Ticks 1–5: the transient error is retried; run 1 stays healthy and the healthy
  // change after it is never reached.
  for (let i = 0; i < 5; i++) {
    const out = await advanceRuns(ctx, undefined, deps);
    expect(out.handled).toBe(0);
    expect(getRun(ctx, r1.id)!.status).toBe("running");
    expect(getRun(ctx, r2.id)!.status).toBe("running");
  }
  // Tick 6: the retry budget is spent; run 1's change is treated as a deterministic
  // failure (the run is failed) and the cursor moves on to the healthy change.
  await advanceRuns(ctx, undefined, deps);
  expect(getRun(ctx, r1.id)!.status).toBe("failed");
  expect(getRun(ctx, r1.id)!.reason).toBe("engine error: database is locked");
  expect(getRun(ctx, r2.id)!.status).toBe("waiting"); // the healthy run advanced
  expect(stepsOfRun(ctx, r2.id)).toHaveLength(2);
});

test("a step row written before its delegation attaches its task during a gap rescan", async () => {  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const run = insertRun(ctx, { workflow: "t/demo", version: 1, repo: tmpDir(), brief: "B" });
  const task = createTask(ctx, {
    brief: { goal: "Draft", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600,
    requestId: `wf:${run.id}:draft:1:`,
  });
  // The crash: the step row exists with no task id, the task already settled.
  insertStep(ctx, { runId: run.id, stepId: "draft", attempt: 1, status: "running" });
  updateStep(ctx, { runId: run.id, stepId: "draft", attempt: 1 }, { result: { ok: true } });
  updateTask(ctx, task.id, t => { t.state = "done"; });
  setCursor(ctx, 10_000_000);
  const out = await advanceRuns(ctx, undefined, deps);
  expect(out.rescanned).toBe(true);
  const row = stepsOfRun(ctx, run.id).find(s => s.stepId === "draft")!;
  expect(row.taskId).toBe(task.id);
  expect(row.status).toBe("done");
  expect(getRun(ctx, run.id)!.status).toBe("waiting"); // the recovered step advanced the run
});

test("a transient lock error stops the tick without failing the run; the next tick advances", async () => {
  const ctx = fakeCtx();  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/demo", repo: tmpDir(), brief: "B" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  const cursorBefore = getCursor(ctx);
  // A second connection holds the write lock: the settlement write hits SQLITE_BUSY.
  const blocker = new Database(join(ctx.pacerHome, "state", "tasks.db"));
  blocker.exec("BEGIN IMMEDIATE");
  try {
    const out = await advanceRuns(ctx, undefined, deps);
    expect(out.handled).toBe(0);
    expect(getRun(ctx, r.id)!.status).toBe("running"); // the run is healthy, not failed
    expect(getCursor(ctx)).toBe(cursorBefore); // nothing was advanced past the locked change
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  const out = await advanceRuns(ctx, undefined, deps);
  expect(out.handled).toBe(1);
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
}, 20000);

test("a tick settlement publishes the run entity", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/demo", repo: tmpDir(), brief: "B" }, undefined, deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  await advanceRuns(ctx, undefined, deps);
  const outbox = (await import("../src/link/store")).readOutboxSince(ctx, 0);
  const runs = outbox.filter(e => e.envelope.type === "entity" && (e.envelope.data as { kind: string }).kind === "run");
  expect(runs.length).toBeGreaterThanOrEqual(2); // the start and the settlement
  const last = JSON.parse(JSON.stringify((runs.at(-1)!.envelope.data as { value: { status: string } }).value));
  expect(last.status).toBe("waiting");
});
