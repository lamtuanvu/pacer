import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { DelegateInput } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { CoreError } from "../src/core/errors";
import { callOp, type OpDeps } from "../src/api/ops";
import { addDefinition, getRun, stepsOfRun, type RunRow } from "../src/workflow/store";
import { onTaskSettled } from "../src/workflow/engine";
import type { WorkflowError } from "../src/workflow/schema";

/** The same delegation stub the engine tests use: createTask with the input's
 *  brief and a request-id dedupe, so run.start works without a strategy. */
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

const GOOD = `
id: t/demo
version: 1
title: Demo
steps:
  draft: { type: agent, kind: research, prompt: "Draft: {{brief}}" }
  approve: { type: human, question: { text: "Approve?", kind: approve_revise } }
  done: { type: end }
edges:
  - [draft, approve]
  - [approve, done, "result.answer == 'approve'"]
`;

const BAD = `
id: t/broken
version: 1
steps:
  start: { type: agent, kind: research, prompt: "Go" }
edges:
  - [start, nowhere]
`;

/** Resolves with the error a call threw, or null when it succeeded. */
const fail = async (p: Promise<unknown>): Promise<CoreError> => {
  try { await p; return null as unknown as CoreError; }
  catch (e) { return e as CoreError; }
};

const executorCtx = (ctx: Ctx, taskId?: string): Ctx =>
  ({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", ...(taskId ? { PACER_TASK_ID: taskId } : {}) } });

test("workflow.validate accepts a good file and reports every error of a bad one", async () => {
  const ctx = fakeCtx();
  expect(await callOp(ctx, "workflow.validate", { source: GOOD })).toEqual({ ok: true, errors: [] });
  const bad = await callOp(ctx, "workflow.validate", { source: BAD }) as { ok: boolean; errors: WorkflowError[] };
  expect(bad.ok).toBe(false);
  expect(bad.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "edges[0].to", message: "unknown step 'nowhere'" }),
    expect.objectContaining({ path: "steps", message: expect.stringContaining("no end step is reachable") }),
  ]));
});

test("workflow.add installs a version once and conflicts on a different source", async () => {
  const ctx = fakeCtx();
  expect(await callOp(ctx, "workflow.add", { source: GOOD })).toEqual({ id: "t/demo", version: 1, created: true });
  expect(await callOp(ctx, "workflow.add", { source: GOOD })).toEqual({ id: "t/demo", version: 1, created: false });
  const conflict = await fail(callOp(ctx, "workflow.add", { source: GOOD.replace("Demo", "Other") }));
  expect(conflict?.code).toBe("conflict");
  const invalid = await fail(callOp(ctx, "workflow.add", { source: BAD }));
  expect(invalid?.code).toBe("invalid_input");
  expect((invalid?.data as { errors: WorkflowError[] }).errors.length).toBeGreaterThan(0);
});

test("workflow.list returns installed definitions", async () => {
  const ctx = fakeCtx();
  expect(await callOp(ctx, "workflow.list", {})).toEqual([]);
  await callOp(ctx, "workflow.add", { source: GOOD });
  expect(await callOp(ctx, "workflow.list", {})).toEqual([{ id: "t/demo", version: 1, title: "Demo", addedAt: ctx.now }]);
});

test("run.start delegates the entry step, run.get and run.list read it back", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  expect(run.workflow).toBe("t/demo");
  expect(run.status).toBe("running");
  expect(run.rev).toBe(1);
  expect(stepsOfRun(ctx, run.id)[0].status).toBe("running");
  const got = await callOp(ctx, "run.get", { id: run.id }) as { run: RunRow; steps: unknown[] };
  expect(got.run.id).toBe(run.id);
  expect(got.steps).toHaveLength(1);
  expect(await callOp(ctx, "run.list", {})).toEqual([run]);
  expect(await callOp(ctx, "run.list", { status: "running" })).toEqual([run]);
  expect(await callOp(ctx, "run.list", { status: "waiting" })).toEqual([]);
});

test("run.start with an unknown workflow is not_found", async () => {
  const ctx = fakeCtx();
  const e = await fail(callOp(ctx, "run.start", { workflow: "t/none", repo: tmpDir(), brief: "Do X" }, stubDeps()));
  expect(e?.code).toBe("not_found");
});

test("run.start from an executor session is refused", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const e = await fail(callOp(executorCtx(ctx), "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()));
  expect(e?.code).toBe("not_allowed");
  expect(e?.message).toContain("step.result");
});

test("step.result records the calling executor's result; a second one conflicts", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const step = stepsOfRun(ctx, run.id)[0];
  const exec = executorCtx(ctx, step.taskId);
  const recorded = await callOp(exec, "step.result", { result: { ok: true } }) as { result: unknown };
  expect(recorded.result).toEqual({ ok: true });
  const again = await fail(callOp(exec, "step.result", { result: { ok: true } }));
  expect(again?.code).toBe("conflict");
});

test("step.result outside a delegated task is refused", async () => {
  const ctx = fakeCtx();
  const e = await fail(callOp(ctx, "step.result", { result: { ok: true } }));
  expect(e?.code).toBe("not_allowed");
  const noTask = await fail(callOp(executorCtx(ctx), "step.result", { result: { ok: true } }));
  expect(noTask?.code).toBe("not_allowed");
});

test("run.answer settles the waiting human step; a stale rev conflicts", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const step = stepsOfRun(ctx, run.id)[0];
  await callOp(executorCtx(ctx, step.taskId), "step.result", { result: { ok: true } });
  updateTask(ctx, step.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, step.taskId!);
  const waiting = getRun(ctx, run.id)!;
  expect(waiting.status).toBe("waiting");

  const stale = await fail(callOp(ctx, "run.answer", { id: run.id, step: "approve", answer: "approve", expect_rev: waiting.rev - 1 }));
  expect(stale?.code).toBe("conflict");
  const answered = await callOp(ctx, "run.answer", { id: run.id, step: "approve", answer: "approve", expect_rev: waiting.rev }) as RunRow;
  expect(answered.status).toBe("done");
  expect(stepsOfRun(ctx, run.id).find(s => s.stepId === "approve")!.result).toEqual({ answer: "approve" });
});

test("run.stop stops running step tasks and marks the run stopped", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const step = stepsOfRun(ctx, run.id)[0];
  const stopped = await callOp(ctx, "run.stop", { id: run.id, expect_rev: run.rev }) as RunRow;
  expect(stopped.status).toBe("stopped");
  expect(readTask(ctx, step.taskId!)!.state).toBe("stopped");
  const stale = await fail(callOp(ctx, "run.stop", { id: run.id, expect_rev: run.rev }));
  expect(stale?.code).toBe("conflict");
});

test("every run change publishes a run entity event", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const step = stepsOfRun(ctx, run.id)[0];
  updateTask(ctx, step.taskId!, t => { t.state = "stopped"; });
  await onTaskSettled(ctx, step.taskId!);
  const failed = getRun(ctx, run.id)!;
  await callOp(ctx, "run.stop", { id: run.id, expect_rev: failed.rev });
  // The outbox holds one run entity per published change: start and the op stop.
  const outbox = (await import("../src/link/store")).readOutboxSince(ctx, 0);
  const runs = outbox.filter(e => e.envelope.type === "entity" && (e.envelope.data as { kind: string }).kind === "run");
  expect(runs.map(e => (e.envelope.data as { id: string }).id)).toEqual([run.id, run.id]);
  const started = JSON.parse(JSON.stringify((runs[0]!.envelope.data as { value: RunRow }).value));
  expect(started.status).toBe("running");
});

test("addDefinition through the ops keeps the store's conflict rules", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  expect(addDefinition(ctx, JSON.parse(JSON.stringify({
    id: "t/demo", version: 1,
    steps: { draft: { type: "agent", kind: "research", prompt: "Draft: {{brief}}" }, approve: { type: "human", question: { text: "Approve?", kind: "approve_revise" } }, done: { type: "end" } },
    edges: [{ from: "draft", to: "approve" }, { from: "approve", to: "done", when: "result.answer == 'approve'" }],
    entry: "draft", title: "Demo",
  })), GOOD)).toEqual({ id: "t/demo", version: 1, created: false });
});
