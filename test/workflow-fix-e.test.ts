import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWork } from "../src/dispatch/work";
import { reserveDispatch } from "../src/dispatch/runtime";
import { runDecision, ladderEngine } from "../src/dispatch/engines";
import { candidate, request } from "./fixtures/dispatch";
import { readTask, updateTask } from "../src/tasks/store";
import type { SpawnRunner } from "../src/tasks/api";
import { defaultEngineDeps, startRun } from "../src/workflow/engine";
import { addDefinition, getRun, stepsOfRun } from "../src/workflow/store";
import type { WorkflowDef } from "../src/workflow/schema";
import { fakeCtx, tmpDir } from "./helpers";

function writeStrategy(ctx: ReturnType<typeof fakeCtx>, localMaxTasks: number | "unlimited") {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), [
    "planner: claude-code",
    "providers:",
    "  claude-code: {}",
    "  codex: {}",
    "execution:",
    `  local_max_tasks: ${localMaxTasks}`,
    "",
  ].join("\n"));
}

describe("F1: reserveDispatch excludes workflow-root from concurrency", () => {
  test("real reserveDispatch admits the first step when local_max_tasks is 1", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx, 1);
    const def: WorkflowDef = {
      id: "t/e-cap1",
      version: 1,
      steps: {
        a: { type: "agent", kind: "research", prompt: "A" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "done" }],
      entry: "a",
    };
    addDefinition(ctx, def, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;
    expect(readTask(ctx, rootId)!.state).toBe("running");
    expect(readTask(ctx, rootId)!.kind).toBe("workflow-root");
    expect(getWork(ctx, rootId)!.options.maxConcurrent).toBe(1);

    const step = stepsOfRun(ctx, run.id).find(s => s.stepId === "a")!;
    expect(step.taskId).toBeTruthy();
    const taskId = step.taskId!;
    expect(["queued", "running"]).toContain(readTask(ctx, taskId)!.state);

    const c = candidate("runner", 50);
    const preview = await runDecision(request([c]), ladderEngine);
    // Real runner reservation path — not a fake spawn assertion on maxConcurrent alone.
    expect(reserveDispatch(ctx, taskId, c, preview)).toBe(true);
  });

  test("real reserveDispatch admits fanout width equal to local_max_tasks (2 of 3)", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx, 2);
    const def: WorkflowDef = {
      id: "t/e-fan2",
      version: 1,
      steps: {
        fan: {
          type: "fanout",
          branches: ["x", "y", "z"],
          each: { type: "agent", kind: "tests", prompt: "T {{branch}}" },
          join: "all",
        },
        done: { type: "end" },
      },
      edges: [{ from: "fan", to: "done" }],
      entry: "fan",
    };
    addDefinition(ctx, def, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;
    expect(getWork(ctx, rootId)!.options.maxConcurrent).toBe(2);

    const branches = stepsOfRun(ctx, run.id).filter(s => s.stepId === "fan" && s.branch);
    expect(branches).toHaveLength(3);
    const ids = branches.map(b => b.taskId!);
    const c = candidate("runner", 50);
    const preview = await runDecision(request([c]), ladderEngine);

    expect(reserveDispatch(ctx, ids[0]!, c, preview)).toBe(true);
    updateTask(ctx, ids[0]!, t => { t.state = "running"; });
    expect(reserveDispatch(ctx, ids[1]!, c, preview)).toBe(true);
    updateTask(ctx, ids[1]!, t => { t.state = "running"; });
    expect(reserveDispatch(ctx, ids[2]!, c, preview)).toBe(false);
  });
});
