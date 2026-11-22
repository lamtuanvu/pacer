import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWork } from "../src/dispatch/work";
import { boundedJson, dispatchDatabase } from "../src/dispatch/store";
import { reserveDispatch } from "../src/dispatch/runtime";
import { runDecision, ladderEngine } from "../src/dispatch/engines";
import { candidate, request } from "./fixtures/dispatch";
import { readTask, updateTask } from "../src/tasks/store";
import type { SpawnRunner } from "../src/tasks/api";
import { defaultEngineDeps, startRun } from "../src/workflow/engine";
import { addDefinition, getRun, stepsOfRun } from "../src/workflow/store";
import { estimateDescendantBudget, estimateWorkUnits, validateWorkflow } from "../src/workflow/validate";
import { rootCapacityFromGraph, rootMaxConcurrent } from "../src/workflow/worknode";
import type { WorkflowDef } from "../src/workflow/schema";
import { fakeCtx, tmpDir } from "./helpers";

/** Pin root maxConcurrent for reserveDispatch width tests (roots no longer copy local_max_tasks). */
function setRootMaxConcurrent(ctx: ReturnType<typeof fakeCtx>, rootId: string, n: number) {
  const work = getWork(ctx, rootId)!;
  dispatchDatabase(ctx).query("UPDATE work_nodes SET options=? WHERE task_id=?")
    .run(boundedJson({ ...work.options, maxConcurrent: n }), rootId);
}

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
    // Roots use schema max; pin to 1 so this exercises root exclusion under a tight cap.
    expect(rootMaxConcurrent(ctx)).toBe(64);
    setRootMaxConcurrent(ctx, rootId, 1);
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

  test("real reserveDispatch admits fanout width 2 of 3 when root maxConcurrent is 2", async () => {
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
    setRootMaxConcurrent(ctx, rootId, 2);
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

describe("F2: frontier-based replan seeding", () => {
  function writeStrategyDefault(ctx: ReturnType<typeof fakeCtx>) {
    writeStrategy(ctx, 8);
  }

  test("diamond A->B,A->C seeds A+B and starts C2 (not mark done via B's end)", async () => {
    const ctx = fakeCtx();
    writeStrategyDefault(ctx);
    const parentDef: WorkflowDef = {
      id: "t/e-seed-parent",
      version: 1,
      steps: {
        plan: { type: "generate", prompt: "P", limits: { step_types: ["agent"], max_steps: 8, kinds: ["feature", "tests"] } },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    const diamond: WorkflowDef = {
      id: "t/e-diamond",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A" },
        b: { type: "agent", kind: "tests", prompt: "B" },
        c2: { type: "agent", kind: "tests", prompt: "C2" },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c2" },
        { from: "b", to: "done" },
        { from: "c2", to: "done" },
      ],
      entry: "a",
    };
    addDefinition(ctx, parentDef, "source");
    addDefinition(ctx, diamond, "source");
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const parent = await startRun(ctx, { workflow: parentDef.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);

    const child = await startRun(ctx, {
      workflow: diamond.id, repo: parent.repo, brief: parent.brief,
    }, spawn, defaultEngineDeps, {
      parentRunId: parent.id,
      parentStep: "plan",
      seedFinished: {
        finishedIds: ["a", "b"],
        results: { a: { ok: true }, b: { ok: true } },
      },
    });

    const rows = stepsOfRun(ctx, child.id);
    const seededA = rows.find(s => s.stepId === "a")!;
    const seededB = rows.find(s => s.stepId === "b")!;
    expect(seededA.status).toBe("done");
    expect(seededB.status).toBe("done");
    expect(seededA.advancedAt).toBeDefined();
    expect(seededB.advancedAt).toBeDefined();

    const c2 = rows.find(s => s.stepId === "c2");
    expect(c2?.taskId).toBeTruthy();
    expect(launches).toContain(c2!.taskId!);
    expect(getRun(ctx, child.id)!.status).not.toBe("done");
  });

  test("off-path seeded row stamps advancedAt so tick will not re-fire it", async () => {
    const ctx = fakeCtx();
    writeStrategyDefault(ctx);
    const parentDef: WorkflowDef = {
      id: "t/e-off-parent",
      version: 1,
      steps: {
        plan: { type: "generate", prompt: "P", limits: { step_types: ["agent"], max_steps: 8, kinds: ["feature"] } },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    // Linear a->b->done but seed a and also an off-path "x" that is in the new def as a dead finished id
    // Keep x in the graph with edge from a so it is a real step; seed a+x, resume b.
    const def: WorkflowDef = {
      id: "t/e-offpath",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A" },
        x: { type: "agent", kind: "feature", prompt: "X" },
        b: { type: "agent", kind: "feature", prompt: "B" },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "x" },
        { from: "x", to: "done" },
        { from: "b", to: "done" },
      ],
      entry: "a",
    };
    addDefinition(ctx, parentDef, "source");
    addDefinition(ctx, def, "source");
    const spawn: SpawnRunner = () => 1;
    const parent = await startRun(ctx, { workflow: parentDef.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const child = await startRun(ctx, {
      workflow: def.id, repo: parent.repo, brief: parent.brief,
    }, spawn, defaultEngineDeps, {
      parentRunId: parent.id,
      parentStep: "plan",
      seedFinished: {
        finishedIds: ["a", "x"],
        results: { a: { ok: 1 }, x: { ok: 1 } },
      },
    });
    const x = stepsOfRun(ctx, child.id).find(s => s.stepId === "x")!;
    expect(x.status).toBe("done");
    expect(x.advancedAt).toBeDefined();
    const b = stepsOfRun(ctx, child.id).find(s => s.stepId === "b");
    expect(b?.taskId || b?.status === "running").toBeTruthy();
  });

  test("fully finished seeded graph marks the run done", async () => {
    const ctx = fakeCtx();
    writeStrategyDefault(ctx);
    const parentDef: WorkflowDef = {
      id: "t/e-full-parent",
      version: 1,
      steps: {
        plan: { type: "generate", prompt: "P", limits: { step_types: ["agent"], max_steps: 4, kinds: ["feature"] } },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    const def: WorkflowDef = {
      id: "t/e-full",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "done" }],
      entry: "a",
    };
    addDefinition(ctx, parentDef, "source");
    addDefinition(ctx, def, "source");
    const spawn: SpawnRunner = () => 1;
    const parent = await startRun(ctx, { workflow: parentDef.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const child = await startRun(ctx, {
      workflow: def.id, repo: parent.repo, brief: parent.brief,
    }, spawn, defaultEngineDeps, {
      parentRunId: parent.id,
      parentStep: "plan",
      seedFinished: { finishedIds: ["a"], results: { a: { ok: true } } },
    });
    expect(getRun(ctx, child.id)!.status).toBe("done");
    expect(stepsOfRun(ctx, child.id).find(s => s.stepId === "a")!.advancedAt).toBeDefined();
  });

  test("replan that changes an edge starts the new target from seeded predecessor", async () => {
    const ctx = fakeCtx();
    writeStrategyDefault(ctx);
    const parentDef: WorkflowDef = {
      id: "t/e-edge-parent",
      version: 1,
      steps: {
        plan: { type: "generate", prompt: "P", limits: { step_types: ["agent"], max_steps: 8, kinds: ["feature", "tests"] } },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    // Old edge a->b; new graph keeps a finished and routes a->c instead.
    const def: WorkflowDef = {
      id: "t/e-edge-change",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A" },
        c: { type: "agent", kind: "tests", prompt: "C" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "c" }, { from: "c", to: "done" }],
      entry: "a",
    };
    addDefinition(ctx, parentDef, "source");
    addDefinition(ctx, def, "source");
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const parent = await startRun(ctx, { workflow: parentDef.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const child = await startRun(ctx, {
      workflow: def.id, repo: parent.repo, brief: parent.brief,
    }, spawn, defaultEngineDeps, {
      parentRunId: parent.id,
      parentStep: "plan",
      seedFinished: { finishedIds: ["a"], results: { a: { kept: true } } },
    });
    const c = stepsOfRun(ctx, child.id).find(s => s.stepId === "c");
    expect(c?.taskId).toBeTruthy();
    expect(launches).toContain(c!.taskId!);
    expect(stepsOfRun(ctx, child.id).find(s => s.stepId === "a")!.advancedAt).toBeDefined();
  });
});

describe("F3: root maxConcurrent is schema max", () => {
  test("rootMaxConcurrent ignores local_max_tasks", () => {
    const ctx = fakeCtx();
    writeStrategy(ctx, 1);
    expect(rootMaxConcurrent(ctx)).toBe(64);
    writeStrategy(ctx, "unlimited");
    expect(rootMaxConcurrent(ctx)).toBe(64);
  });
});

describe("F4 / F5: descendant budget estimate", () => {
  test("validateWorkflow rejects when uncapped estimate exceeds 1000", () => {
    const steps: WorkflowDef["steps"] = { done: { type: "end" } };
    const edges: WorkflowDef["edges"] = [];
    // Many parallel agents with a large loop covering them.
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `s${i}`;
      ids.push(id);
      steps[id] = { type: "agent", kind: "feature", prompt: id };
      edges.push({ from: id, to: i === 39 ? "s0" : `s${i + 1}`, ...(i === 39 ? { maxLoops: 30 } : {}) });
    }
    edges.push({ from: "s0", to: "done", when: "result.ok == true" });
    const def: WorkflowDef = { id: "t/e-huge", version: 1, steps, edges, entry: "s0" };
    expect(estimateDescendantBudget(def)).toBeGreaterThan(1000);
    const errs = validateWorkflow(def);
    expect(errs.some(e => /descendant budget|exceeds cap 1000/i.test(e.message))).toBe(true);
  });

  test("capacity uses sum(maxLoops × cycle) not max(maxLoops)+1 over all steps", () => {
    // Two separate loops: each maxLoops 3 over 2 steps. Old formula used maxLoops=3 → factor 4 × 4 steps = 16.
    // Per-cycle: each cycle contributes 3*2=6, base 4 → 4+12=16 work units (+slack).
    const def: WorkflowDef = {
      id: "t/e-twoloop",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A", result: { required: ["v"] } },
        b: { type: "agent", kind: "feature", prompt: "B", result: { required: ["v"] } },
        c: { type: "agent", kind: "feature", prompt: "C", result: { required: ["v"] } },
        d: { type: "agent", kind: "feature", prompt: "D", result: { required: ["v"] } },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a", when: "result.v == 'loop'", maxLoops: 3 },
        { from: "b", to: "c", when: "result.v == 'next'" },
        { from: "c", to: "d" },
        { from: "d", to: "c", when: "result.v == 'loop'", maxLoops: 5 },
        { from: "d", to: "done", when: "result.v == 'ok'" },
      ],
      entry: "a",
    };
    // base 4 + 3*2 + 5*2 = 4+6+10 = 20
    expect(estimateWorkUnits(def)).toBe(20);
    expect(rootCapacityFromGraph(def)).toBe(Math.max(20, estimateDescendantBudget(def)));
    expect(rootCapacityFromGraph(def)).toBeLessThanOrEqual(1000);
  });
});
