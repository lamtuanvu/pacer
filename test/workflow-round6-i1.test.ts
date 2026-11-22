// Round-6 I1: step.result lands on the task-owning orch step; orphan never delegates orch role.
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
  addDefinition, getRun, insertStep, stepsOfRun, updateRun, workflowDatabase,
} from "../src/workflow/store";
import {
  chooseWorkflow, recordStepResult, reconcileOrphanStep, startRun, type EngineDeps,
} from "../src/workflow/engine";
import { buildTurnPrompt } from "../src/workflow/orchestrator";
import { stepsOfRootTree } from "../src/workflow/wakeups";
import { advanceRuns } from "../src/workflow/tick";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;

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

describe("round-6 I1: task-owning orch step is first-listed; orphan never delegates", () => {
  test("recordStepResult writes to task-owning child orch; orphaned root orch is not redelegated", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const childWf: WorkflowDef = {
      id: "t/i1-child", version: 1,
      steps: {
        orch: { type: "agent", role: "orchestrator", prompt: "CHILD-ORCH" },
        done: { type: "end" },
      },
      edges: [{ from: "orch", to: "done" }],
      entry: "orch",
    };
    // Root entry is orch; pick is also present so we can open a child while root orch stays running.
    const rootWf: WorkflowDef = {
      id: "t/i1-root", version: 1,
      steps: {
        orch: { type: "agent", role: "orchestrator", prompt: "ROOT-ORCH" },
        pick: { type: "choose_workflow", from: ["t/i1-child"] },
        done: { type: "end" },
      },
      edges: [{ from: "orch", to: "pick" }, { from: "pick", to: "done" }],
      entry: "orch",
    };
    addDefinition(ctx, rootWf, "s");
    addDefinition(ctx, childWf, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;

    const root = await startRun(ctx, { workflow: "t/i1-root", repo: tmpDir(), brief: "B" }, spawn, deps);
    const rootOrchBefore = stepsOfRun(ctx, root.id).find(s => s.stepId === "orch")!;
    expect(rootOrchBefore.taskId).toBeTruthy();
    const orchTaskId = rootOrchBefore.taskId!;

    // Open choose while root orch is still running; child orch steals the shared task_id.
    insertStep(ctx, { runId: root.id, stepId: "pick", attempt: 1, status: "waiting" });
    updateRun(ctx, root.id, getRun(ctx, root.id)!.rev, { status: "waiting" });
    const child = await chooseWorkflow(ctx, {
      runId: root.id, stepId: "pick", workflow: "t/i1-child", reason: "child",
    }, spawn, deps);

    const rootOrch = stepsOfRun(ctx, root.id).find(s => s.stepId === "orch")!;
    const childOrch = stepsOfRun(ctx, child.id).find(s => s.stepId === "orch")!;
    expect(rootOrch.status).toBe("running");
    expect(rootOrch.taskId).toBeUndefined(); // UNIQUE cleared by startOrchestratorRoleStep
    expect(childOrch.taskId).toBe(orchTaskId);
    // Make root clearly older so a startedAt-first order would wrongly list it ahead of the task owner.
    workflowDatabase(ctx).query(
      "UPDATE workflow_steps SET started_at = ? WHERE run_id = ? AND step_id = ?",
    ).run(NOW - 30, root.id, "orch");
    workflowDatabase(ctx).query(
      "UPDATE workflow_steps SET started_at = ? WHERE run_id = ? AND step_id = ?",
    ).run(NOW - 5, child.id, "orch");

    const tree = stepsOfRootTree(ctx, root.id);
    const prompt = buildTurnPrompt(ctx, getRun(ctx, root.id)!, [], rootWf, tree);
    expect(prompt).toMatch(/report the step shown as task=/i);
    // Task-owning child must list before the orphaned older root orch.
    expect(prompt.indexOf("CHILD-ORCH")).toBeLessThan(prompt.indexOf("ROOT-ORCH"));
    expect(prompt.indexOf("CHILD-ORCH")).toBeGreaterThanOrEqual(0);

    // Production path: recordStepResult through the shared orch task.
    recordStepResult(ctx, orchTaskId, { text: "from-grant" });
    expect(stepsOfRun(ctx, child.id).find(s => s.stepId === "orch")!.result).toEqual({ text: "from-grant" });
    expect(stepsOfRun(ctx, root.id).find(s => s.stepId === "orch")!.result).toBeUndefined();

    // After 60s, orphan reconcile must never startAgentStep for an orchestrator-role orphan.
    const late = { ...ctx, now: NOW + 61 };
    const orphan = stepsOfRun(late, root.id).find(s => s.stepId === "orch")!;
    expect(await reconcileOrphanStep(late, orphan, spawn, deps)).toBe("skipped");
    expect(stepsOfRun(late, root.id).find(s => s.stepId === "orch")!.taskId).toBeUndefined();

    await advanceRuns({ ...late, now: NOW + COALESCE_WINDOW_S + 61 }, spawn, deps, {
      spawn, plannerEligible: () => true,
    });
    expect(stepsOfRun(late, root.id).find(s => s.stepId === "orch")!.taskId).toBeUndefined();
    expect(stepsOfRun(late, root.id).find(s => s.stepId === "orch")!.status).toBe("running");
  });
});
