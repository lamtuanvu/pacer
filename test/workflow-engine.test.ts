import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskState } from "../src/tasks/types";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { CoreError } from "../src/core/errors";
import { addDefinition, getDefinition, getRun, stepByTask, stepsOfRun } from "../src/workflow/store";
import { answerHumanStep, onTaskSettled, recordStepResult, startRun, startStep, stopRun, type EngineDeps } from "../src/workflow/engine";
import type { FanoutStep, WorkflowDef } from "../src/workflow/schema";

/** Delegation stubbed like the real one: createTask with the input's brief and a
 *  request-id dedupe, so tests settle tasks with updateTask instead of runners. */
function fakeDeps() {
  const inputs: DelegateInput[] = [];
  const stopped: string[] = [];
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
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  const deps: EngineDeps = {
    delegate,
    stopTask: (ctx, id) => {
      stopped.push(id);
      updateTask(ctx, id, t => { t.state = "stopped"; });
    },
  };
  return { deps, inputs, stopped };
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

const reviseLoop: WorkflowDef = {
  id: "t/revise",
  version: 1,
  steps: {
    draft: { type: "agent", kind: "research", prompt: "Draft" },
    review: { type: "agent", kind: "review", prompt: "Review", result: { required: ["verdict"] } },
    done: { type: "end" },
  },
  edges: [
    { from: "draft", to: "review" },
    { from: "review", to: "done", when: "result.verdict == 'pass'" },
    { from: "review", to: "draft", when: "result.verdict == 'revise'", maxLoops: 2 },
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

const gate: WorkflowDef = {
  id: "t/gate",
  version: 1,
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask" },
    done: { type: "end" },
  },
  edges: [{ from: "ask", to: "done", when: "result.go == 'yes'" }],
  entry: "ask",
};

const fanoutDef = (join: FanoutStep["join"]): WorkflowDef => ({
  id: "t/fanout",
  version: 1,
  steps: {
    check: { type: "fanout", branches: ["a", "b", "c"], each: { type: "agent", kind: "review", prompt: "Check {{branch}}" }, join },
    done: { type: "end" },
  },
  edges: [{ from: "check", to: "done" }],
  entry: "check",
});

const branchRow = (ctx: Ctx, runId: string, branch: string) =>
  stepsOfRun(ctx, runId).find(s => s.stepId === "check" && s.branch === branch)!;

async function driveBranch(ctx: Ctx, runId: string, branch: string, deps: EngineDeps, state: TaskState = "done", result?: unknown) {
  const row = branchRow(ctx, runId, branch);
  if (result !== undefined) recordStepResult(ctx, row.taskId!, result);
  settle(ctx, row.taskId!, state);
  await onTaskSettled(ctx, row.taskId!, undefined, deps);
}

const start = (ctx: Ctx, workflow: string, deps: EngineDeps, brief = "B") =>
  startRun(ctx, { workflow, repo: tmpDir(), brief }, undefined, deps);

test("agent → human → end: result drives the edge", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/demo", deps, "Do X");
  const s1 = stepsOfRun(ctx, r.id)[0];
  expect(s1.stepId).toBe("draft");
  expect(s1.status).toBe("running");
  expect(s1.taskId).toBeDefined();
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  await onTaskSettled(ctx, s1.taskId!, undefined, deps);
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("waiting");
  const waiting = stepsOfRun(ctx, r.id).find(s => s.stepId === "approve")!;
  expect(waiting.status).toBe("waiting");
  await answerHumanStep(ctx, r.id, "approve", "approve", run.rev);
  expect(getRun(ctx, r.id)!.status).toBe("done");
});

test("the rendered prompt carries the brief and the result instruction", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps, inputs } = fakeDeps();
  const repo = tmpDir();
  const r = await startRun(ctx, { workflow: "t/demo", repo, brief: "Do X" }, undefined, deps);
  const goal = readTask(ctx, stepsOfRun(ctx, r.id)[0].taskId!)!.brief.goal;
  expect(goal).toContain("Draft: Do X");
  expect(goal).toContain("pacer step result --json");
  expect(goal).toContain(`This step is draft of run ${r.id}`);
  expect(inputs[0].requestId).toBe(`wf:${r.id}:draft:1:`);
  expect(inputs[0].kind).toBe("research");
  expect(inputs[0].brief.repo).toBe(repo);
});

test("settled without a result fails the step and the run", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/demo", deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  settle(ctx, s1.taskId!);
  await onTaskSettled(ctx, s1.taskId!, undefined, deps);
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("failed");
  expect(run.reason).toBe("step draft no step result");
  const row = stepByTask(ctx, s1.taskId!)!;
  expect(row.status).toBe("failed");
  expect(row.error).toBe("no step result");
  expect(() => recordStepResult(ctx, s1.taskId!, { ok: true })).toThrow(/conflict/);
});

test("a second result is a conflict", () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  return (async () => {
    const r = await start(ctx, "t/demo", deps);
    const s1 = stepsOfRun(ctx, r.id)[0];
    recordStepResult(ctx, s1.taskId!, { ok: true });
    try { recordStepResult(ctx, s1.taskId!, { ok: true }); throw new Error("no throw"); }
    catch (e) { expect((e as CoreError).code).toBe("conflict"); }
  })();
});

test("recordStepResult validates the declared schema", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, reviseLoop, "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/revise", deps);
  const draft = stepsOfRun(ctx, r.id).find(s => s.stepId === "draft")!;
  recordStepResult(ctx, draft.taskId!, { ok: true });
  settle(ctx, draft.taskId!);
  await onTaskSettled(ctx, draft.taskId!, undefined, deps);
  const review = stepsOfRun(ctx, r.id).find(s => s.stepId === "review")!;
  try { recordStepResult(ctx, review.taskId!, {}); throw new Error("no throw"); }
  catch (e) {
    expect((e as CoreError).code).toBe("invalid_input");
    expect((e as CoreError).message).toContain("missing required key 'verdict'");
  }
  try { recordStepResult(ctx, review.taskId!, "nope"); throw new Error("no throw"); }
  catch (e) { expect((e as CoreError).message).toContain("result must be a JSON object"); }
  recordStepResult(ctx, review.taskId!, { verdict: "revise" });
});

test("recordStepResult refuses tasks without a step", async () => {
  const ctx = fakeCtx();
  const plain = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  try { recordStepResult(ctx, plain.id, {}); throw new Error("no throw"); }
  catch (e) { expect((e as CoreError).code).toBe("not_found"); }
});

test("a back edge stops at max_loops", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, reviseLoop, "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/revise", deps);
  let guard = 0;
  while (getRun(ctx, r.id)!.status === "running" && guard++ < 10) {
    const row = stepsOfRun(ctx, r.id).find(s => s.status === "running" && s.taskId)!;
    recordStepResult(ctx, row.taskId!, row.stepId === "draft" ? { ok: true } : { verdict: "revise" });
    settle(ctx, row.taskId!);
    await onTaskSettled(ctx, row.taskId!, undefined, deps);
  }
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("failed");
  expect(run.reason).toBe("loop limit review->draft");
  expect(run.loops["review->draft"]).toBe(3);
});

test("no edge matched fails the run", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, gate, "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/gate", deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { go: "no" });
  settle(ctx, s1.taskId!);
  await onTaskSettled(ctx, s1.taskId!, undefined, deps);
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("failed");
  expect(run.reason).toBe("no edge matched after ask");
});

test("fanout all joins when every branch is done", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, fanoutDef("all"), "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/fanout", deps);
  const branches = stepsOfRun(ctx, r.id).filter(s => s.branch);
  expect(branches.map(s => s.branch)).toEqual(["a", "b", "c"]);
  expect(branchRow(ctx, r.id, "a").taskId).not.toBe(branchRow(ctx, r.id, "b").taskId);
  expect(readTask(ctx, branchRow(ctx, r.id, "a").taskId!)!.brief.goal).toContain("Check a");
  await driveBranch(ctx, r.id, "a", deps, "done", { v: "va" });
  expect(getRun(ctx, r.id)!.status).toBe("running");
  await driveBranch(ctx, r.id, "b", deps, "done", { v: "vb" });
  expect(getRun(ctx, r.id)!.status).toBe("running");
  await driveBranch(ctx, r.id, "c", deps, "done", { v: "vc" });
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("done");
  const join = stepsOfRun(ctx, r.id).find(s => s.stepId === "check" && s.branch === undefined)!;
  expect(join.status).toBe("done");
  expect(join.result).toEqual({ branches: { a: { v: "va" }, b: { v: "vb" }, c: { v: "vc" } }, done: 3, failed: 0 });
});

test("fanout all fails as soon as one branch fails", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, fanoutDef("all"), "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/fanout", deps);
  await driveBranch(ctx, r.id, "a", deps, "failed");
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("failed");
  expect(run.reason).toBe("step check failed");
});

test("fanout any stops the remaining branches", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, fanoutDef("any"), "source");
  const { deps, stopped } = fakeDeps();
  const r = await start(ctx, "t/fanout", deps);
  await driveBranch(ctx, r.id, "b", deps, "done", { v: "vb" });
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("done");
  expect(stopped).toEqual([branchRow(ctx, r.id, "a").taskId!, branchRow(ctx, r.id, "c").taskId!]);
  const join = stepsOfRun(ctx, r.id).find(s => s.stepId === "check" && s.branch === undefined)!;
  expect(join.result).toEqual({ branches: { a: null, b: { v: "vb" }, c: null }, done: 1, failed: 0 });
});

test("fanout quorum joins at n done branches without stopping the rest", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, fanoutDef({ quorum: 2 }), "source");
  const { deps, stopped } = fakeDeps();
  const r = await start(ctx, "t/fanout", deps);
  await driveBranch(ctx, r.id, "a", deps, "done", { v: "va" });
  expect(getRun(ctx, r.id)!.status).toBe("running");
  await driveBranch(ctx, r.id, "b", deps, "done", { v: "vb" });
  expect(getRun(ctx, r.id)!.status).toBe("done");
  expect(stopped).toEqual([]);
  const join = stepsOfRun(ctx, r.id).find(s => s.stepId === "check" && s.branch === undefined)!;
  expect(join.result).toEqual({ branches: { a: { v: "va" }, b: { v: "vb" }, c: null }, done: 2, failed: 0 });
});

test("fanout quorum fails when n can no longer be reached", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, fanoutDef({ quorum: 2 }), "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/fanout", deps);
  await driveBranch(ctx, r.id, "a", deps, "failed");
  expect(getRun(ctx, r.id)!.status).toBe("running"); // b and c can still reach the quorum
  await driveBranch(ctx, r.id, "b", deps, "failed");
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("failed");
  expect(run.reason).toBe("step check failed");
});

test("startStep is idempotent per step instance", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps, inputs } = fakeDeps();
  const r = await start(ctx, "t/demo", deps);
  const def = getDefinition(ctx, "t/demo")!;
  const again = await startStep(ctx, getRun(ctx, r.id)!, def, "draft", undefined, { deps });
  expect(again.taskId).toBe(stepsOfRun(ctx, r.id)[0].taskId);
  expect(inputs).toHaveLength(1);
  expect(inputs[0].requestId).toBe(`wf:${r.id}:draft:1:`);
  expect(stepsOfRun(ctx, r.id)).toHaveLength(1);
});

test("stopRun stops the running step tasks and needs the current rev", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps, stopped } = fakeDeps();
  const r = await start(ctx, "t/demo", deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  const stoppedRun = stopRun(ctx, r.id, r.rev, deps);
  expect(stoppedRun.status).toBe("stopped");
  expect(stopped).toEqual([s1.taskId!]);
  expect(readTask(ctx, s1.taskId!)!.state).toBe("stopped");
  try { stopRun(ctx, r.id, r.rev, deps); throw new Error("no throw"); }
  catch (e) { expect((e as CoreError).code).toBe("conflict"); }
  expect(getRun(ctx, r.id)!.rev).toBe(stoppedRun.rev);
});

test("answerHumanStep needs a waiting human step and the current rev", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/demo", deps);
  try { await answerHumanStep(ctx, r.id, "approve", "approve", 1); throw new Error("no throw"); }
  catch (e) { expect((e as CoreError).code).toBe("conflict"); }
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  await onTaskSettled(ctx, s1.taskId!, undefined, deps);
  const run = getRun(ctx, r.id)!;
  try { await answerHumanStep(ctx, r.id, "approve", "approve", run.rev - 1); throw new Error("no throw"); }
  catch (e) { expect((e as CoreError).code).toBe("conflict"); }
});

test("startRun refuses unknown workflows", async () => {
  const ctx = fakeCtx();
  try { await start(ctx, "t/none", fakeDeps().deps); throw new Error("no throw"); }
  catch (e) { expect((e as CoreError).code).toBe("not_found"); }
});

test("onTaskSettled ignores tasks without a step, unsettled tasks and double settlements", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, demo, "source");
  const { deps } = fakeDeps();
  const r = await start(ctx, "t/demo", deps);
  const plain = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  settle(ctx, plain.id);
  await onTaskSettled(ctx, plain.id, undefined, deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  await onTaskSettled(ctx, s1.taskId!, undefined, deps); // the task is still queued
  expect(getRun(ctx, r.id)!.status).toBe("running");
  expect(stepsOfRun(ctx, r.id)).toHaveLength(1);
  expect(stepByTask(ctx, s1.taskId!)!.status).toBe("running");
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  await onTaskSettled(ctx, s1.taskId!, undefined, deps);
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
  await onTaskSettled(ctx, s1.taskId!, undefined, deps); // the step already settled
  expect(getRun(ctx, r.id)!.status).toBe("waiting");
  expect(stepsOfRun(ctx, r.id)).toHaveLength(2);
});

test("a next-step start failure fails the run instead of throwing", async () => {
  const ctx = fakeCtx();
  addDefinition(ctx, chain, "source");
  const { deps: base } = fakeDeps();
  const deps: EngineDeps = {
    delegate: (c, input, spawn) => input.brief.goal.includes("Two")
      ? Promise.reject(new Error("no executor available"))
      : base.delegate(c, input, spawn),
    stopTask: base.stopTask,
  };
  const r = await start(ctx, "t/chain", deps);
  const s1 = stepsOfRun(ctx, r.id)[0];
  recordStepResult(ctx, s1.taskId!, { ok: true });
  settle(ctx, s1.taskId!);
  await onTaskSettled(ctx, s1.taskId!, undefined, deps); // resolves, never throws
  const run = getRun(ctx, r.id)!;
  expect(run.status).toBe("failed");
  expect(run.reason).toBe("start failed: two: no executor available");
  expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "two")).toBeUndefined();
});
