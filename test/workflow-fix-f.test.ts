// Phase 3 fixF: I1 generate advanceFrom, I2 seed reachability, M1/M2/M4 capacity.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask, listTasksWhere, readTask, updateTask } from "../src/tasks/store";
import type { SpawnRunner, DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import { getWork, registerWork, setWorkDependencies } from "../src/dispatch/work";
import { loadStrategy } from "../src/config/strategy";
import { SLOT_STATES, slotBlock, slotUse } from "../src/engine/slots";
import {
  answerGenerateApproval, defaultEngineDeps, onTaskSettled, recordStepResult, startRun,
  type EngineDeps,
} from "../src/workflow/engine";
import { submitGraph } from "../src/workflow/generate";
import { addDefinition, getRun, stepsOfRun } from "../src/workflow/store";
import { rootCapacityFromGraph } from "../src/workflow/worknode";
import type { GenerateLimits, WorkflowDef } from "../src/workflow/schema";
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

function fakeDeps(): { deps: EngineDeps } {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
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
      if (input.dependencies?.length) {
        setWorkDependencies(ctx, task.id, input.dependencies, readTask(ctx, task.id)!.rev);
      }
    }
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx, id) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
    },
  };
}

async function settleAgent(ctx: ReturnType<typeof fakeCtx>, taskId: string, deps: EngineDeps, result: unknown = { ok: true }) {
  recordStepResult(ctx, taskId, result);
  updateTask(ctx, taskId, t => { t.state = "done"; });
  await onTaskSettled(ctx, taskId, undefined, deps);
}

const tinyLimits: GenerateLimits = {
  step_types: ["agent", "human", "fanout"],
  max_steps: 4,
  kinds: ["docs", "research", "feature", "tests"],
};

function tinyChild(): WorkflowDef {
  return {
    id: "gen/tiny-f",
    version: 1,
    steps: {
      work: { type: "agent", kind: "docs", prompt: "W" },
      done: { type: "end" },
    },
    edges: [{ from: "work", to: "done" }],
    entry: "work",
  };
}

describe("M4: workflow root maxDescendants is the schema cap", () => {
  test("rootCapacityFromGraph returns 1000 for any concrete graph", () => {
    const tiny: WorkflowDef = {
      id: "t/f-m4-tiny",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "done" }],
      entry: "a",
    };
    expect(rootCapacityFromGraph(tiny)).toBe(1000);
    expect(rootCapacityFromGraph(null)).toBe(1000);
  });
});

describe("M2: local_max_tasks bounds fanout width via slotBlock/slotUse", () => {
  /** High per-runner max_tasks so execution.local_max_tasks is the binding cap. */
  function writeSlotStrategy(ctx: ReturnType<typeof fakeCtx>, localMax: number) {
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), [
      "planner: claude-code",
      "accounts:",
      "  claude: { kind: claude }",
      "  codex: { kind: codex }",
      "runners:",
      "  claude-code: { agent: claude-code, account: claude, max_tasks: 8 }",
      "  codex: { agent: codex, account: codex, max_tasks: 8 }",
      "execution:",
      `  local_max_tasks: ${localMax}`,
      "",
    ].join("\n"));
  }

  async function startFanoutBranches(localMax: number) {
    const ctx = fakeCtx();
    writeSlotStrategy(ctx, localMax);
    const def: WorkflowDef = {
      id: `t/f-m2-fan-${localMax}`,
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
    expect(getWork(ctx, getRun(ctx, run.id)!.rootTaskId!)!.options.maxConcurrent).toBe(64);
    const branches = stepsOfRun(ctx, run.id).filter(s => s.stepId === "fan" && s.branch);
    expect(branches).toHaveLength(3);
    return { ctx, branches: branches.map(b => b.taskId!) };
  }

  function markLocalRunning(ctx: ReturnType<typeof fakeCtx>, taskId: string, executor = "codex") {
    updateTask(ctx, taskId, t => {
      t.state = "running";
      t.executor = executor;
    });
  }

  test("local_max_tasks 1: one running fanout branch fills the machine slot", async () => {
    const { ctx, branches } = await startFanoutBranches(1);
    markLocalRunning(ctx, branches[0]!);
    const strategy = loadStrategy(ctx);
    const use = slotUse(listTasksWhere(ctx, { states: SLOT_STATES }), ctx);
    expect(use.local).toBe(1);
    expect(slotBlock(strategy, "codex", use)).toBe("this machine busy (1/1)");
    expect(slotBlock(strategy, "claude-code", use)).toBe("this machine busy (1/1)");
  });

  test("local_max_tasks 2: two running branches leave the third blocked", async () => {
    const { ctx, branches } = await startFanoutBranches(2);
    markLocalRunning(ctx, branches[0]!, "codex");
    markLocalRunning(ctx, branches[1]!, "claude-code");
    const strategy = loadStrategy(ctx);
    const use = slotUse(listTasksWhere(ctx, { states: SLOT_STATES }), ctx);
    expect(use.local).toBe(2);
    expect(slotBlock(strategy, "codex", use)).toBe("this machine busy (2/2)");
    // Root stays at schema max — width is from slots, not a pinned root maxConcurrent.
    const root = listTasksWhere(ctx, { states: ["running"] }).find(t => t.kind === "workflow-root")!;
    expect(getWork(ctx, root.id)!.options.maxConcurrent).toBe(64);
  });
});

describe("M1: child admission excludes workflow-root like reserveDispatch", () => {
  test("delegateChild under a maxConcurrent:1 workflow-root is not blocked by the root itself", async () => {
    const { gitRepo, realRun } = await import("./helpers");
    const { issueWorkGrant } = await import("../src/dispatch/work");
    const { delegateChild } = await import("../src/core/work");
    const { boundedJson, dispatchDatabase } = await import("../src/dispatch/store");

    const ctx = fakeCtx({ now: Date.now() / 1000, run: realRun });
    writeStrategy(ctx, 8);
    const repo = gitRepo();
    const root = createTask(ctx, {
      brief: { goal: "workflow-root", repo },
      kind: "workflow-root",
      requestedExecutor: null,
      timeoutS: 600,
    });
    registerWork(ctx, root.id, {
      allowDelegation: true,
      delegationEnforcement: "strict",
      kind: "workflow-root",
      maxConcurrent: 1,
      maxDescendants: 1000,
    });
    updateTask(ctx, root.id, t => { t.state = "running"; });
    // Pin maxConcurrent 1 after registerWork defaults.
    const work = getWork(ctx, root.id)!;
    dispatchDatabase(ctx).query("UPDATE work_nodes SET options=? WHERE task_id=?")
      .run(boundedJson({ ...work.options, maxConcurrent: 1 }), root.id);
    expect(getWork(ctx, root.id)!.options.maxConcurrent).toBe(1);
    expect(readTask(ctx, root.id)!.kind).toBe("workflow-root");

    const grant = issueWorkGrant(ctx, root.id, 1);
    const scoped = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_WORK_GRANT: grant } };
    // Without the kind filter, the running root alone occupies maxConcurrent 1.
    const child = await delegateChild(scoped, { goal: "first child", requestId: "m1-child" }, () => 1);
    expect(child.id).toMatch(/^t-/);
    expect(getWork(ctx, child.id)?.rootId).toBe(root.id);
  });
});

describe("I2: replan seeding fires only entry-reachable finished steps", () => {
  test("unreachable seeded b->c stays inert while a->d starts", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx, 8);
    const parentDef: WorkflowDef = {
      id: "t/f-i2-parent",
      version: 1,
      steps: {
        plan: { type: "generate", prompt: "P", limits: tinyLimits },
        done: { type: "end" },
      },
      edges: [{ from: "plan", to: "done" }],
      entry: "plan",
    };
    // New graph: a->d->end plus unreachable b->c (stale from old a->b->c->end).
    const def: WorkflowDef = {
      id: "t/f-i2-stale",
      version: 1,
      steps: {
        a: { type: "agent", kind: "feature", prompt: "A" },
        b: { type: "agent", kind: "feature", prompt: "B" },
        c: { type: "agent", kind: "tests", prompt: "C" },
        d: { type: "agent", kind: "research", prompt: "D" },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "d" },
        { from: "d", to: "done" },
        { from: "b", to: "c" },
        { from: "c", to: "done" },
      ],
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
      seedFinished: {
        finishedIds: ["a", "b"],
        results: { a: { ok: true }, b: { ok: true } },
      },
    });

    const rows = stepsOfRun(ctx, child.id);
    const seededB = rows.find(s => s.stepId === "b")!;
    expect(seededB.status).toBe("done");
    expect(seededB.advancedAt).toBeDefined();

    const c = rows.find(s => s.stepId === "c");
    expect(c).toBeUndefined();

    const d = rows.find(s => s.stepId === "d");
    expect(d?.taskId).toBeTruthy();
    expect(launches).toContain(d!.taskId!);
    expect(getRun(ctx, child.id)!.status).not.toBe("failed");
  });
});

describe("I1: generate successor starts from advanceFrom", () => {
  test("agent -> generate -> end: settle research starts plan; submit+approve+child done finishes parent", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx, 8);
    const def: WorkflowDef = {
      id: "t/f-i1-chain",
      version: 1,
      steps: {
        research: { type: "agent", kind: "research", prompt: "R" },
        plan: { type: "generate", prompt: "P", limits: tinyLimits, approval: "must" },
        done: { type: "end" },
      },
      edges: [
        { from: "research", to: "plan" },
        { from: "plan", to: "done" },
      ],
      entry: "research",
    };
    addDefinition(ctx, def, "source");
    const { deps } = fakeDeps();
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
    const research = stepsOfRun(ctx, run.id).find(s => s.stepId === "research")!;
    expect(research.taskId).toBeTruthy();
    await settleAgent(ctx, research.taskId!, deps);

    const plan = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan");
    expect(plan?.status).toBe("waiting");
    expect(getRun(ctx, run.id)!.status).toBe("waiting");
    expect(getRun(ctx, run.id)!.status).not.toBe("failed");
    expect(getRun(ctx, run.id)!.reason ?? "").not.toMatch(/not started as a task/i);

    await submitGraph(ctx, { runId: run.id, stepId: "plan", source: tinyChild() }, deps);
    await answerGenerateApproval(ctx, {
      runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(ctx, run.id)!.rev,
    }, deps);
    const childId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.result as { childRunId: string }).childRunId;
    const childWork = stepsOfRun(ctx, childId).find(s => s.stepId === "work")!;
    await settleAgent(ctx, childWork.taskId!, deps);

    expect(stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")!.status).toBe("done");
    expect(getRun(ctx, run.id)!.status).toBe("done");
  });

  test("generate after fanout join starts waiting", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx, 8);
    const def: WorkflowDef = {
      id: "t/f-i1-fan",
      version: 1,
      steps: {
        fan: {
          type: "fanout",
          branches: ["a", "b"],
          each: { type: "agent", kind: "tests", prompt: "T {{branch}}" },
          join: "all",
        },
        plan: { type: "generate", prompt: "P", limits: tinyLimits, approval: "must" },
        done: { type: "end" },
      },
      edges: [
        { from: "fan", to: "plan" },
        { from: "plan", to: "done" },
      ],
      entry: "fan",
    };
    addDefinition(ctx, def, "source");
    const { deps } = fakeDeps();
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
    const branches = stepsOfRun(ctx, run.id).filter(s => s.stepId === "fan" && s.branch);
    expect(branches).toHaveLength(2);
    for (const br of branches) await settleAgent(ctx, br.taskId!, deps, { v: br.branch });

    const plan = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan");
    expect(plan?.status).toBe("waiting");
    expect(getRun(ctx, run.id)!.status).toBe("waiting");
    expect(getRun(ctx, run.id)!.reason ?? "").not.toMatch(/not started as a task/i);
  });

  test("generate on a loop back-edge starts waiting again", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx, 8);
    const def: WorkflowDef = {
      id: "t/f-i1-loop",
      version: 1,
      steps: {
        research: { type: "agent", kind: "research", prompt: "R", result: { required: ["v"] } },
        plan: { type: "generate", prompt: "P", limits: tinyLimits, approval: "must" },
        done: { type: "end" },
      },
      edges: [
        { from: "research", to: "plan" },
        { from: "plan", to: "research", when: "result.again == true", maxLoops: 2 },
        { from: "plan", to: "done", when: "result.again != true" },
      ],
      entry: "research",
    };
    addDefinition(ctx, def, "source");
    const { deps } = fakeDeps();
    const { readvanceStep } = await import("../src/workflow/engine");
    const { updateStep } = await import("../src/workflow/store");
    const run = await startRun(ctx, { workflow: def.id, repo: tmpDir(), brief: "B" }, undefined, deps);
    await settleAgent(ctx, stepsOfRun(ctx, run.id).find(s => s.stepId === "research")!.taskId!, deps, { v: 1 });

    const plan1 = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan" && s.attempt === 1)!;
    expect(plan1.status).toBe("waiting");

    // Finish the waiting generate with a loop result (no child needed for this edge case).
    updateStep(ctx, { runId: run.id, stepId: "plan", attempt: 1 }, {
      status: "done", result: { again: true }, endedAt: ctx.now,
    });
    const donePlan = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan" && s.attempt === 1)!;
    expect(donePlan.advancedAt).toBeUndefined();
    await readvanceStep(ctx, donePlan, undefined, deps);

    const research2 = stepsOfRun(ctx, run.id).filter(s => s.stepId === "research").at(-1)!;
    expect(research2.attempt).toBeGreaterThan(1);
    expect(research2.taskId).toBeTruthy();
    await settleAgent(ctx, research2.taskId!, deps, { v: 2 });

    const plan2 = stepsOfRun(ctx, run.id).find(s => s.stepId === "plan" && s.attempt === 2);
    expect(plan2?.status).toBe("waiting");
    expect(getRun(ctx, run.id)!.status).toBe("waiting");
    expect(getRun(ctx, run.id)!.reason ?? "").not.toMatch(/not started as a task/i);
  });
});
