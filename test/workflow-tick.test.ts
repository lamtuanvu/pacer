import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskState } from "../src/tasks/types";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { addDefinition, getCursor, getRun, setCursor, stepsOfRun } from "../src/workflow/store";
import { answerHumanStep, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { advanceRuns } from "../src/workflow/tick";
import type { WorkflowDef } from "../src/workflow/schema";

/** The same delegation stub the engine tests use: createTask with the input's
 *  brief and a request-id dedupe, so tasks settle through updateTask. */
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
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  const deps: EngineDeps = {
    delegate,
    stopTask: (ctx, id) => updateTask(ctx, id, t => { t.state = "stopped"; }),
  };
  return { deps };
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
