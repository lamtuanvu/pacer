import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWork, pendingDependencies } from "../src/dispatch/work";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { SpawnRunner } from "../src/tasks/api";
import {
  answerGenerateApproval, defaultEngineDeps, failRun, onTaskSettled, recordStepResult, startRun,
} from "../src/workflow/engine";
import { submitGraph, validateGenerated } from "../src/workflow/generate";
import { addDefinition, getRun, listDecisions, stepsOfRun } from "../src/workflow/store";
import { rootCapacityFromGraph } from "../src/workflow/worknode";
import type { GenerateLimits, WorkflowDef } from "../src/workflow/schema";
import { fakeCtx, tmpDir } from "./helpers";

function writeStrategy(ctx: ReturnType<typeof fakeCtx>, extra = "") {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), [
    "planner: claude-code",
    "providers:",
    "  claude-code: {}",
    "  codex: {}",
    "execution:",
    "  local_max_tasks: 8",
    extra,
    "",
  ].join("\n"));
}

async function settleStep(
  ctx: ReturnType<typeof fakeCtx>,
  taskId: string,
  spawn: SpawnRunner,
  result: unknown = { ok: true },
) {
  recordStepResult(ctx, taskId, result);
  updateTask(ctx, taskId, t => { t.state = "done"; });
  await onTaskSettled(ctx, taskId, spawn, defaultEngineDeps);
}

describe("B-1: engine-created steps advance on done without accept", () => {
  test("A->B->end reaches done with real delegate; no accept; both steps spawn", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const chain: WorkflowDef = {
      id: "t/d-chain",
      version: 1,
      steps: {
        a: { type: "agent", kind: "research", prompt: "A" },
        b: { type: "agent", kind: "research", prompt: "B" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "b" }, { from: "b", to: "done" }],
      entry: "a",
    };
    addDefinition(ctx, chain, "source");
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const a = stepsOfRun(ctx, run.id).find(s => s.stepId === "a")!;
    expect(a.taskId).toBeTruthy();
    expect(launches).toContain(a.taskId!);

    await settleStep(ctx, a.taskId!, spawn);

    const b = stepsOfRun(ctx, run.id).find(s => s.stepId === "b")!;
    expect(b.taskId).toBeTruthy();
    expect(getWork(ctx, b.taskId!)!.parentId).toBe(getRun(ctx, run.id)!.rootTaskId!);
    // No dispatcher dependency hold: successor launches without review.accepted.
    expect(getWork(ctx, b.taskId!)!.dependencies).toEqual([]);
    expect(pendingDependencies(ctx, b.taskId!)).toEqual([]);
    // Real spawn was handed the successor (not held for deps / accept).
    expect(launches).toContain(b.taskId!);
    expect(readTask(ctx, b.taskId!)!.queue?.reason).not.toBe("waiting_retry");

    await settleStep(ctx, b.taskId!, spawn);
    expect(getRun(ctx, run.id)!.status).toBe("done");
  });

  test("fanout join successor launches without accept", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const def: WorkflowDef = {
      id: "t/d-fan",
      version: 1,
      steps: {
        fan: {
          type: "fanout",
          branches: ["x", "y"],
          each: { type: "agent", kind: "tests", prompt: "T {{branch}}" },
          join: "all",
        },
        after: { type: "agent", kind: "docs", prompt: "After" },
        done: { type: "end" },
      },
      edges: [{ from: "fan", to: "after" }, { from: "after", to: "done" }],
      entry: "fan",
    };
    addDefinition(ctx, def, "source");
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const branches = stepsOfRun(ctx, run.id).filter(s => s.stepId === "fan" && s.branch);
    expect(branches).toHaveLength(2);
    for (const br of branches) {
      expect(br.taskId).toBeTruthy();
      await settleStep(ctx, br.taskId!, spawn, { branch: br.branch });
    }
    const after = stepsOfRun(ctx, run.id).find(s => s.stepId === "after")!;
    expect(after.taskId).toBeTruthy();
    expect(pendingDependencies(ctx, after.taskId!)).toEqual([]);
    expect(launches).toContain(after.taskId!);
    expect(readTask(ctx, after.taskId!)!.review).toBeUndefined();
  });

  test("loop back-edge runs two iterations without accept", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const def: WorkflowDef = {
      id: "t/d-loop",
      version: 1,
      steps: {
        build: { type: "agent", kind: "feature", prompt: "Build", result: { required: ["n"] } },
        review: { type: "agent", kind: "research", prompt: "Review", result: { required: ["verdict"] } },
        done: { type: "end" },
      },
      edges: [
        { from: "build", to: "review" },
        { from: "review", to: "build", when: "result.verdict == 'revise'", maxLoops: 2 },
        { from: "review", to: "done", when: "result.verdict == 'ok'" },
      ],
      entry: "build",
    };
    addDefinition(ctx, def, "source");
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);

    const build1 = stepsOfRun(ctx, run.id).find(s => s.stepId === "build")!;
    await settleStep(ctx, build1.taskId!, spawn, { n: 1 });
    const review1 = stepsOfRun(ctx, run.id).find(s => s.stepId === "review" && s.status === "running")!;
    expect(review1.taskId).toBeTruthy();
    expect(launches).toContain(review1.taskId!);
    await settleStep(ctx, review1.taskId!, spawn, { verdict: "revise" });

    const build2 = stepsOfRun(ctx, run.id).filter(s => s.stepId === "build").at(-1)!;
    expect(build2.attempt).toBeGreaterThan(build1.attempt);
    expect(build2.taskId).toBeTruthy();
    expect(pendingDependencies(ctx, build2.taskId!)).toEqual([]);
    expect(launches).toContain(build2.taskId!);
    await settleStep(ctx, build2.taskId!, spawn, { n: 2 });

    const review2 = stepsOfRun(ctx, run.id).filter(s => s.stepId === "review").at(-1)!;
    await settleStep(ctx, review2.taskId!, spawn, { verdict: "ok" });
    expect(getRun(ctx, run.id)!.status).toBe("done");
  });

  test("step after an orchestrator step launches without accept", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const def: WorkflowDef = {
      id: "t/d-orch",
      version: 1,
      steps: {
        plan: { type: "agent", role: "orchestrator", prompt: "Plan" },
        work: { type: "agent", kind: "feature", prompt: "Work" },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "work" }, { from: "work", to: "done" }],
      entry: "plan",
    };
    addDefinition(ctx, def, "source");
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const plan = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
    expect(plan.status).toBe("running"); // orchestrator-role step; no work-node predecessor
    const { updateStep } = await import("../src/workflow/store");
    const done = updateStep(ctx, { runId: run.id, stepId: "plan", attempt: plan.attempt }, {
      status: "done", result: { ok: true }, endedAt: ctx.now,
    });
    // Tick re-advance waits 5s; call readvanceStep directly for the real engine path.
    const { readvanceStep } = await import("../src/workflow/engine");
    expect(await readvanceStep(ctx, done, spawn, defaultEngineDeps)).toBe(true);

    const work = stepsOfRun(ctx, run.id).find(s => s.stepId === "work");
    expect(work?.taskId).toBeTruthy();
    expect(pendingDependencies(ctx, work!.taskId!)).toEqual([]);
    expect(launches).toContain(work!.taskId!);
  });
});

describe("I-1 / I-2: root capacity and concurrency", () => {
  test("looped fanout root capacity covers iterations; maxConcurrent follows local_max_tasks", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const def: WorkflowDef = {
      id: "t/d-cap",
      version: 1,
      steps: {
        build: { type: "agent", kind: "feature", prompt: "Build" },
        fan: {
          type: "fanout",
          branches: ["a", "b", "c", "d", "e"],
          each: { type: "agent", kind: "tests", prompt: "T" },
          join: "all",
        },
        review: { type: "agent", kind: "research", prompt: "R", result: { required: ["verdict"] } },
        done: { type: "end" },
      },
      edges: [
        { from: "build", to: "fan" },
        { from: "fan", to: "review" },
        { from: "review", to: "build", when: "result.verdict == 'revise'", maxLoops: 3 },
        { from: "review", to: "done", when: "result.verdict == 'ok'" },
      ],
      entry: "build",
    };
    // Old formula: max(20, 1+5+1+3)=20; real need ~28+.
    expect(rootCapacityFromGraph(def)).toBeGreaterThanOrEqual(28);
    expect(rootCapacityFromGraph(def)).toBeLessThanOrEqual(1000);

    addDefinition(ctx, def, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const root = getWork(ctx, getRun(ctx, run.id)!.rootTaskId!)!;
    expect(root.options.maxDescendants).toBeGreaterThanOrEqual(28);
    expect(root.options.maxConcurrent).toBe(8); // from strategy local_max_tasks

    // Drive one full loop iteration of the fanout without hitting descendant limit.
    const build = stepsOfRun(ctx, run.id).find(s => s.stepId === "build")!;
    await settleStep(ctx, build.taskId!, spawn);
    const branches = stepsOfRun(ctx, run.id).filter(s => s.stepId === "fan" && s.branch);
    expect(branches).toHaveLength(5);
    for (const br of branches) await settleStep(ctx, br.taskId!, spawn, { ok: true });
    const review = stepsOfRun(ctx, run.id).find(s => s.stepId === "review")!;
    expect(review.taskId).toBeTruthy();
    await settleStep(ctx, review.taskId!, spawn, { verdict: "revise" });
    const build2 = stepsOfRun(ctx, run.id).filter(s => s.stepId === "build").at(-1)!;
    expect(build2.taskId).toBeTruthy();
    expect(getRun(ctx, run.id)!.status).not.toBe("failed");
    expect(getRun(ctx, run.id)!.reason ?? "").not.toMatch(/Descendant limit/i);
  });
});

describe("I-4: replan seeds finished steps and does not re-delegate them", () => {
  test("replacement child keeps finished step done; only unfinished is delegated", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const limits: GenerateLimits = {
      step_types: ["agent", "human", "fanout"],
      max_steps: 8,
      kinds: ["feature", "tests", "docs", "research"],
    };
    const parent: WorkflowDef = {
      id: "t/d-replan",
      version: 1,
      policy: { replan: { auto: 1, then: "ask" } },
      steps: {
        plan: { type: "generate", prompt: "P", limits, approval: "must" },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    addDefinition(ctx, parent, "source");
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const run = await startRun(ctx, { workflow: parent.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const v1: WorkflowDef = {
      id: "gen/tmp",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A" },
        b: { type: "agent", kind: "tests", prompt: "B" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "b" }, { from: "b", to: "done" }],
      entry: "a",
    };
    await submitGraph(ctx, { runId: run.id, stepId: "plan", source: v1 }, defaultEngineDeps, spawn);
    await answerGenerateApproval(ctx, {
      runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
    }, defaultEngineDeps, spawn);
    const childId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
    const a = stepsOfRun(ctx, childId).find(s => s.stepId === "a")!;
    await settleStep(ctx, a.taskId!, spawn, { from: "a" });
    // Fail b to trigger replan.
    const b = stepsOfRun(ctx, childId).find(s => s.stepId === "b")!;
    updateTask(ctx, b.taskId!, t => { t.state = "failed"; });
    await onTaskSettled(ctx, b.taskId!, spawn, defaultEngineDeps);

    const v2: WorkflowDef = {
      id: "gen/tmp2",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A" },
        b2: { type: "agent", kind: "tests", prompt: "B2" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "b2" }, { from: "b2", to: "done" }],
      entry: "a",
    };
    const before = launches.length;
    const submitted = await submitGraph(ctx, { runId: run.id, stepId: "plan", source: v2 }, defaultEngineDeps, spawn);
    expect(submitted.ok).toBe(true);
    await answerGenerateApproval(ctx, {
      runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
    }, defaultEngineDeps, spawn);
    const child2 = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
    expect(child2).not.toBe(childId);

    const seededA = stepsOfRun(ctx, child2).find(s => s.stepId === "a")!;
    expect(seededA.status).toBe("done");
    expect(seededA.result).toEqual({ from: "a" });
    expect(seededA.taskId).toBeUndefined();

    const b2 = stepsOfRun(ctx, child2).find(s => s.stepId === "b2")!;
    expect(b2.taskId).toBeTruthy();
    // Finished step a must not have been re-delegated on the new child.
    const newLaunches = launches.slice(before);
    const aRequest = `wf:${child2}:a:`;
    expect(newLaunches.every(id => {
      const t = readTask(ctx, id);
      return !t?.requestId?.startsWith(aRequest);
    })).toBe(true);
    expect(newLaunches).toContain(b2.taskId!);
  });
});

describe("M1 / M3: registerWork rejection and unknown kinds", () => {
  test("unknown kind is refused in validateGenerated when limits.kinds is unset", () => {
    const graph: WorkflowDef = {
      id: "gen/x",
      version: 1,
      steps: {
        a: { type: "agent", kind: "not-a-real-kind", prompt: "A" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "done" }],
      entry: "a",
    };
    const errs = validateGenerated(graph, { step_types: ["agent", "human", "fanout"], max_steps: 4 }, 1);
    expect(errs.some(e => /kind|unknown/i.test(e.message) && e.path.includes("kind"))).toBe(true);
  });
});

describe("M5: submit_graph records the step attempt", () => {
  test("decision attempt matches the waiting generate row", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const limits: GenerateLimits = {
      step_types: ["agent"],
      max_steps: 4,
      kinds: ["feature"],
    };
    const parent: WorkflowDef = {
      id: "t/d-attempt",
      version: 1,
      steps: {
        plan: { type: "generate", prompt: "P", limits },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    addDefinition(ctx, parent, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: parent.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const row = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!;
    expect(row.attempt).toBeGreaterThanOrEqual(1);
    const { callOp } = await import("../src/api/ops");
    const { issueRunGrant } = await import("../src/workflow/run-grant");
    const grant = issueRunGrant(ctx, { runId: run.id, turnId: "turn-test", deadline: ctx.now + 60 });
    const child: WorkflowDef = {
      id: "gen/a",
      version: 1,
      steps: {
        x: { type: "agent", kind: "feature", prompt: "X" },
        done: { type: "end" },
      },
      edges: [{ from: "x", to: "done" }],
      entry: "x",
    };
    await callOp({ ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant } }, "run.submit_graph", {
      id: run.id,
      step: "plan",
      source: child,
    });
    const decisions = listDecisions(ctx, run.id).filter(d => d.kind === "submit_graph");
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions.at(-1)!.attempt).toBe(row.attempt);
  });
});

describe("M4: failRun cascade does not wake a dying parent", () => {
  test("failing parent with live generate child does not enqueue step_failed on parent", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const limits: GenerateLimits = {
      step_types: ["agent"],
      max_steps: 4,
      kinds: ["feature"],
    };
    const parent: WorkflowDef = {
      id: "t/d-fail",
      version: 1,
      steps: {
        plan: { type: "generate", prompt: "P", limits },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    addDefinition(ctx, parent, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: parent.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    await submitGraph(ctx, {
      runId: run.id,
      stepId: "plan",
      source: {
        id: "gen/c",
        version: 1,
        steps: {
          x: { type: "agent", kind: "feature", prompt: "X" },
          done: { type: "end" },
        },
        edges: [{ from: "x", to: "done" }],
        entry: "x",
      },
    }, defaultEngineDeps, spawn);
    const { openWakeups } = await import("../src/workflow/wakeups");
    await failRun(ctx, run.id, "parent stopped", undefined, defaultEngineDeps);
    expect(getRun(ctx, run.id)!.status).toBe("failed");
    expect(openWakeups(ctx, run.id).filter(w => w.cause === "step_failed")).toHaveLength(0);
  });
});

describe("I-3: orphan root sweep is selective", () => {
  test("reconcileOrphanWorkflowRoots stops only live wfroot orphans", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const chain: WorkflowDef = {
      id: "t/d-orphan",
      version: 1,
      steps: {
        a: { type: "agent", kind: "research", prompt: "A" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "done" }],
      entry: "a",
    };
    addDefinition(ctx, chain, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const liveRoot = getRun(ctx, run.id)!.rootTaskId!;

    const orphan = createTask(ctx, {
      brief: { goal: "orphan", repo: tmpDir() },
      kind: "workflow-root",
      requestedExecutor: null,
      timeoutS: 60,
      requestId: "wfroot:missing",
    });
    updateTask(ctx, orphan.id, t => { t.state = "running"; });
    const { registerWork } = await import("../src/dispatch/work");
    registerWork(ctx, orphan.id, {
      allowDelegation: true,
      delegationEnforcement: "strict",
      kind: "workflow-root",
      maxDescendants: 20,
      maxConcurrent: 4,
    });

    // Noise: many ordinary tasks must not be required for the sweep to find the orphan.
    for (let i = 0; i < 5; i++) {
      createTask(ctx, {
        brief: { goal: `noise ${i}`, repo: tmpDir() },
        kind: "feature",
        requestedExecutor: null,
        timeoutS: 60,
      });
    }

    const { reconcileOrphanWorkflowRoots } = await import("../src/workflow/worknode");
    const swept = reconcileOrphanWorkflowRoots(ctx);
    expect(swept).toContain(orphan.id);
    expect(readTask(ctx, liveRoot)!.state).toBe("running");
    expect(["stopped", "done", "failed"]).toContain(readTask(ctx, orphan.id)!.state);
  });
});
