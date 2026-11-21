// Round-5 H1: choose claim release must clear, and stale choosing markers reconcile via tick.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { SpawnRunner } from "../src/tasks/api";
import { createTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, insertRun, stepsOfRun, updateStep, workflowDatabase,
} from "../src/workflow/store";
import { chooseWorkflow, startRun, type EngineDeps } from "../src/workflow/engine";
import { advanceRuns } from "../src/workflow/tick";
import { CHOOSING_STALE_S, chooseStepChildRunId } from "../src/workflow/wakeups";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
const READY = NOW + COALESCE_WINDOW_S;

function writePlanner(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return prior;
    const task = createTask(ctx, {
      brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx: Ctx, id: string) => updateTask(ctx, id, t => { t.state = "stopped"; }),
    } as EngineDeps,
  };
}

const childWf: WorkflowDef = {
  id: "t/h1-child", version: 1,
  steps: { work: { type: "agent", kind: "research", prompt: "W" }, done: { type: "end" } },
  edges: [{ from: "work", to: "done" }], entry: "work",
};
const chooseWf: WorkflowDef = {
  id: "t/h1-choose", version: 1,
  steps: { pick: { type: "choose_workflow", from: ["t/h1-child"] }, done: { type: "end" } },
  edges: [{ from: "pick", to: "done" }], entry: "pick",
};

describe("round-5 H1: choose claim release and stale reconcile", () => {
  test("failure after claim then a second chooseWorkflow succeeds", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "s");
    addDefinition(ctx, childWf, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/h1-choose", repo: tmpDir(), brief: "B" }, spawn, deps);
    // Empty brief so startRun throws after the choose claim and before insertRun —
    // the parent step stays waiting and the catch must release the marker.
    workflowDatabase(ctx).query("UPDATE workflow_runs SET brief = '' WHERE id = ?").run(r.id);

    await expect(chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/h1-child", reason: "first",
    }, spawn, deps)).rejects.toThrow(/brief/i);

    const afterFail = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick" && s.status === "waiting")!;
    expect(afterFail.result).toBeUndefined();
    expect((afterFail.result as { choosing?: unknown } | undefined)?.choosing).not.toBe(true);

    workflowDatabase(ctx).query("UPDATE workflow_runs SET brief = ? WHERE id = ?").run("B", r.id);
    const child = await chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/h1-child", reason: "retry",
    }, spawn, deps);
    expect(child.parentRunId).toBe(r.id);
    expect(chooseStepChildRunId(
      stepsOfRun(ctx, r.id).find(s => s.stepId === "pick" && s.status === "waiting")!.result,
    )).toBe(child.id);
  });

  test("stale choosing marker with an existing child is stamped through the tick", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "s");
    addDefinition(ctx, childWf, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/h1-choose", repo: tmpDir(), brief: "B" }, spawn, deps);
    const pick = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!;
    updateStep(ctx, { runId: r.id, stepId: "pick", attempt: pick.attempt }, {
      result: { workflow: "t/h1-child", reason: "mid", choosing: true, choosingAt: NOW - CHOOSING_STALE_S - 1 },
    });
    const orphan = insertRun(ctx, {
      workflow: "t/h1-child", version: 1, repo: r.repo, brief: "B",
      parentRunId: r.id, parentStep: "pick",
    });

    await advanceRuns({ ...ctx, now: READY }, spawn, deps, {
      spawn, plannerEligible: () => true,
    });

    const stamped = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick" && s.status === "waiting")!;
    expect(chooseStepChildRunId(stamped.result)).toBe(orphan.id);
    expect((stamped.result as { choosing?: unknown }).choosing).not.toBe(true);
  });

  test("stale choosing marker without a child is cleared through the tick", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "s");
    addDefinition(ctx, childWf, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/h1-choose", repo: tmpDir(), brief: "B" }, spawn, deps);
    const pick = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!;
    updateStep(ctx, { runId: r.id, stepId: "pick", attempt: pick.attempt }, {
      result: { workflow: "t/h1-child", reason: "mid", choosing: true, choosingAt: NOW - CHOOSING_STALE_S - 1 },
    });

    await advanceRuns({ ...ctx, now: READY }, spawn, deps, {
      spawn, plannerEligible: () => true,
    });

    const cleared = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick" && s.status === "waiting")!;
    expect(cleared.result).toBeUndefined();
    expect(chooseStepChildRunId(cleared.result)).toBeUndefined();
    // A fresh choose must succeed after the tick cleared the marker.
    const child = await chooseWorkflow({ ...ctx, now: READY }, {
      runId: r.id, stepId: "pick", workflow: "t/h1-child", reason: "after-clear",
    }, spawn, deps);
    expect(chooseStepChildRunId(
      stepsOfRun(ctx, r.id).find(s => s.stepId === "pick" && s.status === "waiting")!.result,
    )).toBe(child.id);
  });
});
