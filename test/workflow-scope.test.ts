// Scope regression (plan Task 10, spec "Scope", Review Focus 4): ordinary
// delegated and dispatched tasks keep today's behaviour while runs exist. The
// marker for run work is a workflow_steps row; nothing else enters the engine.
import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { DelegateInput } from "../src/tasks/api";
import { createTask, readTask, taskDatabase, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { callOp, type OpDeps } from "../src/api/ops";
import { registerWork, getWork, workTree } from "../src/dispatch/work";
import { addDefinition, getCursor, stepsOfRun } from "../src/workflow/store";
import { advanceRuns } from "../src/workflow/tick";
import type { WorkflowDef } from "../src/workflow/schema";

function stubDeps(): OpDeps {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: OpDeps["delegate"] = async (ctx, input: DelegateInput) => {
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
  return { delegate };
}

const demo: WorkflowDef = {
  id: "t/demo",
  version: 1,
  steps: {
    draft: { type: "agent", kind: "research", prompt: "Draft: {{brief}}" },
    done: { type: "end" },
  },
  edges: [{ from: "draft", to: "done", when: "result.ok == true" }],
  entry: "draft",
};

/** Every row of the four workflow tables, for whole-state comparisons. */
function snapshotWorkflowTables(ctx: Ctx) {
  const db = taskDatabase(ctx);
  const rows = (table: string) => db.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`).all();
  return { defs: rows("workflow_defs"), runs: rows("workflow_runs"), steps: rows("workflow_steps"), cursor: getCursor(ctx) };
}

/** A run whose entry step is in flight, so the workflow tables are non-empty. */
async function runInProgress(ctx: Ctx): Promise<{ runId: string; draftTaskId: string }> {
  await callOp(ctx, "workflow.add", { source: `
id: t/demo
version: 1
steps:
  draft: { type: agent, kind: research, prompt: "Draft: {{brief}}" }
  done: { type: end }
edges:
  - [draft, done, "result.ok == true"]
` });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as { id: string };
  const step = stepsOfRun(ctx, run.id)[0];
  return { runId: run.id, draftTaskId: step.taskId! };
}

test("an ordinary delegated task settling leaves workflow state alone", async () => {
  const ctx = fakeCtx();
  const { runId } = await runInProgress(ctx);
  const beforeRows = snapshotWorkflowTables(ctx);
  const beforeRun = JSON.parse(JSON.stringify(await callOp(ctx, "run.get", { id: runId })));

  const plain = createTask(ctx, { brief: { goal: "plain work", repo: tmpDir() }, kind: "docs", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, plain.id, t => { t.state = "running"; });
  const beforePlain = readTask(ctx, plain.id);
  updateTask(ctx, plain.id, t => { t.state = "done"; });
  await advanceRuns(ctx);

  // Workflow state is untouched; only the change cursor moved.
  const afterRows = snapshotWorkflowTables(ctx);
  expect(afterRows).toEqual({ ...beforeRows, cursor: expect.any(Number) });
  expect(afterRows.cursor).toBeGreaterThanOrEqual(beforeRows.cursor);
  expect(JSON.parse(JSON.stringify(await callOp(ctx, "run.get", { id: runId })))).toEqual(beforeRun);
  // The task itself changed only by its own settlement.
  const after = readTask(ctx, plain.id)!;
  const { state: _s, rev: _r, settledAt: _sa, ...rest } = after;
  const { state: _bs, rev: _br, settledAt: _bsa, ...beforeRest } = beforePlain!;
  expect(rest).toEqual(beforeRest);
  // The plain task is not a step, so a second pass changes nothing either.
  const cursorAfterFirstPass = getCursor(ctx);
  await advanceRuns(ctx);
  expect(getCursor(ctx)).toBeGreaterThanOrEqual(cursorAfterFirstPass);
  expect(snapshotWorkflowTables(ctx)).toEqual({ ...afterRows });
});

test("dispatch work nodes are untouched by advanceRuns", async () => {
  const ctx = fakeCtx();
  const { runId } = await runInProgress(ctx);
  const root = createTask(ctx, { brief: { goal: "managed root", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, root.id, { allowDelegation: true });
  updateTask(ctx, root.id, t => { t.state = "running"; });
  const child = createTask(ctx, { brief: { goal: "managed child", repo: root.brief.repo }, kind: "debug", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, child.id, {}, root.id);

  updateTask(ctx, root.id, t => { t.state = "done"; });
  updateTask(ctx, child.id, t => { t.state = "done"; });
  await advanceRuns(ctx);

  // The managed tree settled as usual: both nodes present, no workflow link.
  expect(workTree(ctx, root.id).nodes.map(n => n.taskId).sort()).toEqual([child.id, root.id].sort());
  expect(getWork(ctx, child.id)).toBeDefined();
  expect(stepsOfRun(ctx, runId)).toHaveLength(1); // only the run's own entry step
  expect(readTask(ctx, child.id)!.state).toBe("done");
  expect(readTask(ctx, root.id)!.state).toBe("done");
  // And a workflow_steps row exists only for the run's entry step.
  const rows = snapshotWorkflowTables(ctx);
  expect(rows.steps.map(s => s.task_id)).toEqual(expect.arrayContaining([stepsOfRun(ctx, runId)[0].taskId]));
  expect(rows.steps.every(s => s.task_id !== root.id && s.task_id !== child.id)).toBe(true);
});

test("step.result from an ordinary task's executor is not_found", async () => {
  const ctx = fakeCtx();
  const plain = createTask(ctx, { brief: { goal: "plain work", repo: tmpDir() }, kind: "docs", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, plain.id, t => { t.state = "running"; });
  const exec = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: plain.id } };
  let error: { code: string; message: string } | null = null;
  try { await callOp(exec, "step.result", { result: { ok: true } }); }
  catch (e) { error = e as { code: string; message: string }; }
  expect(error?.code).toBe("not_found");
  expect(error?.message).toContain("is not a workflow step");
  expect(readTask(ctx, plain.id)!.state).toBe("running");
});

test("plain task.ask still works for ordinary tasks", async () => {
  const ctx = fakeCtx();
  const { runId, draftTaskId } = await runInProgress(ctx);
  updateTask(ctx, draftTaskId, t => { t.state = "running"; });
  const plain = createTask(ctx, { brief: { goal: "plain work", repo: tmpDir() }, kind: "docs", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, plain.id, t => { t.state = "running"; });
  const exec = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: plain.id } };
  const answered = await callOp(exec, "task.ask", { id: plain.id, text: "Which branch?" }) as { question?: { text: string } };
  expect(answered.question?.text).toBe("Which branch?");
  // The run's step task asks through the same op and the run is untouched.
  const stepExec = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: draftTaskId } };
  await callOp(stepExec, "task.ask", { id: draftTaskId, text: "Nothing useful" });
  expect(readTask(ctx, draftTaskId)!.question?.text).toBe("Nothing useful");
  expect((await callOp(ctx, "run.get", { id: runId }) as { steps: { status: string }[] }).steps[0].status).toBe("running");
});

test("a settled run step still reaches done while ordinary tasks settle around it", async () => {
  const ctx = fakeCtx();
  const { runId, draftTaskId } = await runInProgress(ctx);
  const plain = createTask(ctx, { brief: { goal: "plain work", repo: tmpDir() }, kind: "docs", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, plain.id, t => { t.state = "done"; });
  // The run's step reports its result and settles; the engine advances it.
  await callOp({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: draftTaskId } }, "step.result", { result: { ok: true } });
  updateTask(ctx, draftTaskId, t => { t.state = "done"; });
  updateTask(ctx, plain.id, t => { t.state = "failed"; });
  await advanceRuns(ctx);
  expect(readTask(ctx, plain.id)!.state).toBe("failed");
  expect((await callOp(ctx, "run.get", { id: runId }) as { run: { status: string } }).run.status).toBe("done");
});
