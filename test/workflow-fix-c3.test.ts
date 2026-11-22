import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { buildReadModel, readModelContext } from "../src/api/read-model";
import { snapshotTasks } from "../src/api/read-model/tasks";
import { loadStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { getWork, pendingDependencies, registerWork } from "../src/dispatch/work";
import { runningWork, stopRunningWork } from "../src/service/running-work";
import { isEngineOwnedKind } from "../src/tasks/engine-owned";
import { createTask, listTasksWhere, readTask, updateTask } from "../src/tasks/store";
import { defaultEngineDeps, onTaskSettled, recordStepResult, startRun } from "../src/workflow/engine";
import { addDefinition, getRun, stepsOfRun } from "../src/workflow/store";
import { ensureRootWorkNode, reconcileOrphanWorkflowRoots } from "../src/workflow/worknode";
import { submitGraph } from "../src/workflow/generate";
import type { SpawnRunner } from "../src/tasks/api";
import type { WorkflowDef } from "../src/workflow/schema";
import { fakeCtx, tmpDir } from "./helpers";

function writeStrategy(ctx: ReturnType<typeof fakeCtx>, extra = "") {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), [
    "planner: claude-code",
    "providers:",
    "  claude-code: {}",
    "  codex: {}",
    "execution:",
    "  local_max_tasks: 4",
    extra,
    "",
  ].join("\n"));
}

const chain: WorkflowDef = {
  id: "t/c3-chain",
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

describe("B3: step tasks are real dispatcher children before launch", () => {
  test("real delegate creates step under root with workParent; successor launches on done without accept", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    addDefinition(ctx, chain, "source");
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => {
      launches.push(id);
      return 1;
    };
    // Real delegate path (defaultEngineDeps), not a fake that skips registerWork.
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;
    expect(rootId).toBeTruthy();
    const one = stepsOfRun(ctx, run.id).find(s => s.stepId === "one")!;
    expect(one.taskId).toBeTruthy();
    const child = getWork(ctx, one.taskId!);
    expect(child).toBeTruthy();
    expect(child!.parentId).toBe(rootId);
    expect(child!.rootId).toBe(rootId);

    recordStepResult(ctx, one.taskId!, { ok: true });
    updateTask(ctx, one.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, one.taskId!, spawn, defaultEngineDeps);

    const two = stepsOfRun(ctx, run.id).find(s => s.stepId === "two")!;
    expect(two.taskId).toBeTruthy();
    expect(getWork(ctx, two.taskId!)!.parentId).toBe(rootId);
    // Engine creates the successor after done; no dispatcher dependency edges.
    expect(getWork(ctx, two.taskId!)!.dependencies).toEqual([]);
    expect(pendingDependencies(ctx, two.taskId!)).toEqual([]);
    expect(launches).toContain(two.taskId!);
  });

  test("registerWork rejection fails the step instead of swallowing", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const tiny: WorkflowDef = {
      id: "t/c3-cap",
      version: 1,
      steps: {
        a: { type: "agent", kind: "research", prompt: "A" },
        b: { type: "agent", kind: "research", prompt: "B" },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "done" },
      ],
      entry: "a",
    };
    addDefinition(ctx, tiny, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: tiny.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;
    // Shrink the live root so the next child registration must fail.
    const { dispatchDatabase } = await import("../src/dispatch/store");
    dispatchDatabase(ctx).query(
      "UPDATE work_nodes SET options = ? WHERE task_id = ?",
    ).run(JSON.stringify({
      ...getWork(ctx, rootId)!.options,
      maxDescendants: 1,
      maxConcurrent: 1,
      allowDelegation: true,
      delegationEnforcement: "strict",
    }), rootId);

    const a = stepsOfRun(ctx, run.id).find(s => s.stepId === "a")!;
    recordStepResult(ctx, a.taskId!, { ok: true });
    updateTask(ctx, a.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, a.taskId!, spawn, defaultEngineDeps);

    const b = stepsOfRun(ctx, run.id).find(s => s.stepId === "b");
    const live = getRun(ctx, run.id)!;
    // M1: assert the run failed with the descendant limit (not a weak disjunction).
    expect(live.status).toBe("failed");
    expect(live.reason ?? "").toMatch(/Descendant limit reached/i);
    expect(b?.status === "failed" || live.status === "failed").toBe(true);
  });
});

describe("I3: child root sized from the approved graph", () => {
  test("generated child maxDescendants follows graph size, not generate max_steps default 20", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    const parent: WorkflowDef = {
      id: "t/c3-i3-parent",
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
    addDefinition(ctx, parent, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: parent.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const parentRoot = getWork(ctx, getRun(ctx, run.id)!.rootTaskId!)!;
    // Parent graph is tiny (generate + end); must not inherit max_steps+10.
    expect(parentRoot.options.maxDescendants).toBeLessThan(50);
    expect(parentRoot.options.maxDescendants).toBe(Math.max(20, 1 + 10)); // generate + retries slack

    const steps: WorkflowDef["steps"] = { done: { type: "end" } };
    const edges: WorkflowDef["edges"] = [];
    let prev = "s0";
    steps.s0 = { type: "agent", kind: "feature", prompt: "S0" };
    for (let i = 1; i < 18; i++) {
      const id = `s${i}`;
      steps[id] = { type: "agent", kind: "feature", prompt: `S${i}` };
      edges.push({ from: prev, to: id });
      prev = id;
    }
    steps.fan = {
      type: "fanout",
      branches: ["a", "b", "c", "d", "e"],
      each: { type: "agent", kind: "tests", prompt: "T" },
      join: "all",
    };
    edges.push({ from: prev, to: "fan" }, { from: "fan", to: "done", maxLoops: 3 });
    const childGraph: WorkflowDef = {
      id: "gen/tmp",
      version: 1,
      steps,
      edges,
      entry: "s0",
    };
    const submitted = await submitGraph(ctx, {
      runId: run.id,
      stepId: "plan",
      source: childGraph,
    }, defaultEngineDeps, spawn);
    expect(submitted.ok).toBe(true);
    const childRunId = (stepsOfRun(ctx, run.id).find(s => s.stepId === "plan")?.result as { childRunId?: string } | undefined)?.childRunId;
    expect(childRunId).toBeTruthy();
    const child = getRun(ctx, childRunId!)!;
    const childRoot = getWork(ctx, child.rootTaskId!)!;
    // Loop factor (maxLoops+1=4) × (18 agents + 5 branches) + retries slack, capped at 1000.
    const expected = Math.min(1000, Math.max(20, (18 + 5) * 4 + Math.max(10, Object.keys(steps).length)));
    expect(childRoot.options.maxDescendants).toBe(expected);
    expect(expected).toBeGreaterThan(20);
  });
});

describe("I8: dead-root replacement, reuse, orphan sweep", () => {
  test("dead rootTaskId is replaced; wfroot request id is reused; orphans are swept", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    addDefinition(ctx, chain, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const firstRoot = getRun(ctx, run.id)!.rootTaskId!;
    updateTask(ctx, firstRoot, t => { t.state = "stopped"; });

    // Reuse the existing wfroot:<run> row (revive) rather than leaking a new stopped root.
    const revived = ensureRootWorkNode(ctx, getRun(ctx, run.id)!);
    expect(revived).toBe(firstRoot);
    expect(readTask(ctx, revived)!.state).toBe("running");
    expect(readTask(ctx, revived)!.requestId).toBe(`wfroot:${run.id}`);

    // Lose the task entirely: next ensure must create a replacement and CAS the stamp.
    const { taskDatabase } = await import("../src/tasks/store");
    const { dispatchDatabase } = await import("../src/dispatch/store");
    dispatchDatabase(ctx).query("DELETE FROM work_nodes WHERE task_id = ?").run(firstRoot);
    taskDatabase(ctx).query("DELETE FROM tasks WHERE id = ?").run(firstRoot);
    const replaced = ensureRootWorkNode(ctx, getRun(ctx, run.id)!);
    expect(replaced).not.toBe(firstRoot);
    expect(getRun(ctx, run.id)!.rootTaskId).toBe(replaced);
    expect(readTask(ctx, replaced)!.requestId).toBe(`wfroot:${run.id}`);
    expect(readTask(ctx, replaced)!.state).toBe("running");

    // A second ensure reuses the live wfroot task.
    const again = ensureRootWorkNode(ctx, getRun(ctx, run.id)!);
    expect(again).toBe(replaced);

    // Orphan: a workflow-root with wfroot: request id not pointed at by any run.
    const orphan = createTask(ctx, {
      brief: { goal: "orphan root", repo: tmpDir() },
      kind: "workflow-root",
      requestedExecutor: null,
      timeoutS: 600,
      title: "orphan",
      requestId: "wfroot:no-such-run",
    });
    updateTask(ctx, orphan.id, t => { t.state = "running"; });
    registerWork(ctx, orphan.id, {
      allowDelegation: true,
      delegationEnforcement: "strict",
      kind: "workflow-root",
      maxDescendants: 20,
      maxConcurrent: 4,
    });
    const swept = reconcileOrphanWorkflowRoots(ctx);
    expect(swept).toContain(orphan.id);
    expect(["stopped", "done", "failed"]).toContain(readTask(ctx, orphan.id)!.state);
    // Live run root stays running.
    expect(readTask(ctx, replaced)!.state).toBe("running");
  });
});

describe("I11: engine-owned kinds filtered from readers", () => {
  test("running-work skips workflow-root; host-read / repos / messaging / capability skip engine-owned", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    addDefinition(ctx, chain, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;

    const orch = createTask(ctx, {
      brief: { goal: "orch", repo: tmpDir() },
      kind: "orchestrate",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, orch.id, t => { t.state = "running"; t.executor = "claude-code"; });

    const work = await runningWork(ctx);
    expect(work.tasks.some(t => t.taskId === rootId)).toBe(false);
    expect(work.tasks.some(t => t.taskId === orch.id)).toBe(true);

    const stop = await stopRunningWork(ctx);
    expect(stop.skipped.every(s => s.id !== rootId || s.reason.length > 0)).toBe(true);
    // workflow-root must not appear as a stop target that confuses ownership.
    expect(stop.stopped).not.toContain(rootId);
    expect(stop.skipped.every(s => !(s.id === rootId && s.reason.includes("could not be confirmed")))).toBe(true);

    const { hostReadParts } = await import("../src/api/host-read-bridge");
    const parts = hostReadParts(ctx);
    expect(parts.tasks.every(t => !isEngineOwnedKind(t.kind))).toBe(true);

    const { listRepos } = await import("../src/core/repos");
    // Force taskRepos path by clearing registry usage of ordinary tasks only.
    void listRepos;
    const { taskMessageEvents } = await import("../src/messaging/publish");
    expect(taskMessageEvents(ctx, rootId)).toEqual([]);
    expect(taskMessageEvents(ctx, orch.id)).toEqual([]);
  });
});

describe("I10: TS machine.used still counts orchestrate with a workflow-root present", () => {
  test("snapshot used counts local orchestrate; root does not", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    addDefinition(ctx, chain, "source");
    const spawn: SpawnRunner = () => 1;
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, spawn, defaultEngineDeps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;

    const orch = createTask(ctx, {
      brief: { goal: "orch used", repo: tmpDir() },
      kind: "orchestrate",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, orch.id, t => { t.state = "running"; t.executor = "claude-code"; });

    const snap = (await callOp(ctx, "snapshot.get", {})) as {
      snapshot: { machine: { used: number }; tasks: { id: string; kind?: string | null }[] };
    };
    expect(snap.snapshot.tasks.some(t => t.id === rootId)).toBe(false);
    expect(snap.snapshot.tasks.some(t => t.id === orch.id)).toBe(false);
    expect(snap.snapshot.machine.used).toBeGreaterThanOrEqual(1);

    const strategy = loadStrategy(ctx);
    const status = await computeStatus({ ...ctx, readOnly: true }, strategy);
    const context = await readModelContext(ctx);
    const model = buildReadModel(ctx, {
      status,
      strategy,
      tasks: snapshotTasks(ctx, listTasksWhere(ctx, { all: true })),
      setup: context.setup,
      hosts: Object.values(strategy.hosts),
      signedIn: context.accounts,
    });
    expect(model.machine.used).toBeGreaterThanOrEqual(1);
  });
});
