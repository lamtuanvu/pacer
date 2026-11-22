import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { getWork, pendingDependencies, registerWork, setWorkDependencies, workOptionsSchema } from "../src/dispatch/work";
import { addDefinition, getRun, stepsOfRun } from "../src/workflow/store";
import { onTaskSettled, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { ensureRootWorkNode } from "../src/workflow/worknode";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import type { WorkflowDef } from "../src/workflow/schema";

function fakeDeps() {
  const inputs: DelegateInput[] = [];
  const byRequest = new Map<string, TaskRecord>();
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
    if (input.workParent) {
      registerWork(ctx, task.id, input.dispatch ?? {}, input.workParent, input.workGrant);
    }
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  const deps: EngineDeps = {
    delegate,
    stopTask: (ctx, id) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
  };
  return { deps, inputs };
}

const chain: WorkflowDef = {
  id: "t/wn-chain",
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

const withGenerate: WorkflowDef = {
  id: "t/wn-gen",
  version: 1,
  steps: {
    plan: {
      type: "generate",
      prompt: "Plan",
      limits: { step_types: ["agent", "human", "fanout"], max_steps: 40 },
    },
    done: { type: "end" },
  },
  edges: [{ from: "plan", to: "done" }],
  entry: "plan",
};

test("a new run gets step_mode work_node and step tasks are children of its root", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, chain, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/wn-chain", repo: tmpDir(), brief: "B" }, undefined, deps);
  const run = getRun(ctx, r.id)!;
  expect(run.stepMode).toBe("work_node");
  expect(run.rootTaskId).toBeTruthy();
  const root = getWork(ctx, run.rootTaskId!);
  expect(root).toBeTruthy();
  expect(root!.options.kind).toBe("workflow-root");
  expect(root!.parentId).toBeNull();

  const step = stepsOfRun(ctx, r.id).find(s => s.stepId === "one")!;
  expect(step.taskId).toBeTruthy();
  const child = getWork(ctx, step.taskId!);
  expect(child).toBeTruthy();
  expect(child!.parentId).toBe(run.rootTaskId);
  expect(child!.rootId).toBe(run.rootTaskId);
});

test("a dependency edge holds a step until its predecessor is accepted", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, chain, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/wn-chain", repo: tmpDir(), brief: "B" }, undefined, deps);
  const run = getRun(ctx, r.id)!;
  const one = stepsOfRun(ctx, r.id).find(s => s.stepId === "one")!;
  recordStepResult(ctx, one.taskId!, { ok: true });
  updateTask(ctx, one.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, one.taskId!, undefined, deps);

  const two = stepsOfRun(ctx, r.id).find(s => s.stepId === "two")!;
  expect(two.taskId).toBeTruthy();
  const work = getWork(ctx, two.taskId!)!;
  expect(work.dependencies).toContain(one.taskId!);
  expect(pendingDependencies(ctx, two.taskId!)).toEqual([one.taskId!]);

  // Accept the predecessor: the dependency clears.
  updateTask(ctx, one.taskId!, t => { t.review = { accepted: true, kind: null, note: null, at: ctx.now }; });
  // pendingDependencies re-reads review
  expect(pendingDependencies(ctx, two.taskId!)).toEqual([]);
});

test("the root's maxDescendants rises for a generate plan; ordinary dispatch roots stay at 20", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, withGenerate, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/wn-gen", repo: tmpDir(), brief: "B" }, undefined, deps);
  const run = getRun(ctx, r.id)!;
  const root = getWork(ctx, run.rootTaskId!)!;
  expect(root.options.maxDescendants).toBe(Math.max(20, 40 + 10));
  expect(root.options.maxConcurrent).toBe(4);

  const ordinary = createTask(ctx, { brief: { goal: "root", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const defaults = registerWork(ctx, ordinary.id, { allowDelegation: true });
  expect(defaults.options.maxDescendants).toBe(workOptionsSchema.parse({}).maxDescendants);
  expect(defaults.options.maxDescendants).toBe(20);
});

test("the orchestrator task is not a child of the root work node", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, withGenerate, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/wn-gen", repo: tmpDir(), brief: "B" }, undefined, deps);
  const run = getRun(ctx, r.id)!;
  expect(run.orchestratorTaskId).toBeTruthy();
  expect(run.rootTaskId).toBeTruthy();
  expect(run.orchestratorTaskId).not.toBe(run.rootTaskId);
  expect(getWork(ctx, run.orchestratorTaskId!)).toBeNull();
  const orchParent = getWork(ctx, run.rootTaskId!);
  expect(orchParent).toBeTruthy();
});

test("ensureRootWorkNode is idempotent for an existing root_task_id", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, chain, "source");
  const { deps } = fakeDeps();
  const r = await startRun(ctx, { workflow: "t/wn-chain", repo: tmpDir(), brief: "B" }, undefined, deps);
  const run = getRun(ctx, r.id)!;
  const first = ensureRootWorkNode(ctx, run);
  const second = ensureRootWorkNode(ctx, getRun(ctx, r.id)!);
  expect(first).toBe(run.rootTaskId);
  expect(second).toBe(first);
});
