// P7-W4-revise-brainstorm-reuse: an orchestrator step re-entered by a back edge
// must get a fresh turn for the new attempt; a prior done orch task must not settle
// attempt N as "no step result" before that turn runs.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { SpawnRunner } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getRun, stepsOfRun, workflowDatabase,
} from "../src/workflow/store";
import {
  answerHumanStep, onTaskSettled, recordStepResult, startRun, type EngineDeps,
} from "../src/workflow/engine";
import { advanceRuns } from "../src/workflow/tick";
import { liveTurn, openWakeups } from "../src/workflow/wakeups";
import {
  settleTurn, startTurn, type OrchestratorDeps,
} from "../src/workflow/orchestrator";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
const READY = NOW + COALESCE_WINDOW_S;

function fakeDeps() {
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
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx: Ctx, id: string) => updateTask(ctx, id, t => { t.state = "stopped"; }),
    } satisfies EngineDeps,
  };
}

function writePlanner(ctx: Ctx, agent = "claude-code"): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: ${agent}\nproviders:\n  ${agent}: {}\n`);
}

const loopWf: WorkflowDef = {
  id: "t/orch-loop",
  version: 1,
  steps: {
    brainstorm: { type: "agent", role: "orchestrator", prompt: "Brainstorm: {{brief}}" },
    approve_spec: {
      type: "human",
      decision: "must",
      question: { kind: "approve_revise", text: "Approve the spec?" },
    },
    done: { type: "end" },
  },
  edges: [
    { from: "brainstorm", to: "approve_spec" },
    { from: "approve_spec", to: "done", when: "result.answer == 'approve'" },
    { from: "approve_spec", to: "brainstorm", when: "result.answer == 'revise'", maxLoops: 2 },
  ],
  entry: "brainstorm",
};

/** Drive one orchestrator-step turn: startTurn → recordStepResult → settle task/turn. */
async function completeOrchStepTurn(
  ctx: Ctx,
  runId: string,
  spawn: SpawnRunner,
  deps: EngineDeps,
  result: unknown,
  at: number,
): Promise<{ turnId: string; attempt: number }> {
  const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
  const turn = await startTurn({ ...ctx, now: at }, runId, orch);
  expect(turn).not.toBeNull();
  const step = stepsOfRun(ctx, runId).find(s =>
    s.stepId === "brainstorm" && (s.status === "running" || s.status === "waiting"),
  );
  expect(step).toBeDefined();
  recordStepResult(ctx, turn!.taskId!, result as Record<string, unknown>);
  updateTask(ctx, turn!.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, turn!.taskId!, spawn, deps);
  await settleTurn(ctx, turn!.id, { outcome: "done" });
  return { turnId: turn!.id, attempt: step!.attempt };
}

describe("orchestrator step back-edge loops (P7-W4-revise-brainstorm-reuse)", () => {
  test("each loop attempt gets its own turn and result; run completes after revise then approve", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, loopWf, "source");
    const { deps } = fakeDeps();
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };

    const r = await startRun(ctx, { workflow: "t/orch-loop", repo: tmpDir(), brief: "B" }, spawn, deps);
    const a1 = await completeOrchStepTurn(ctx, r.id, spawn, deps, { ok: true, n: 1 }, READY);
    expect(a1.attempt).toBe(1);
    expect(getRun(ctx, r.id)!.status).toBe("waiting");
    expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "approve_spec")!.status).toBe("waiting");

    await answerHumanStep(ctx, r.id, "approve_spec", "revise", getRun(ctx, r.id)!.rev, deps, spawn);
    const a2row = stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2);
    expect(a2row).toBeDefined();
    expect(a2row!.status).toBe("running");
    // Prior done state must not settle attempt 2 before its turn (the live defect).
    await onTaskSettled(ctx, a2row!.taskId!, spawn, deps);
    expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2)!.status).toBe("running");
    expect(openWakeups(ctx, r.id).some(w => w.cause === "orchestrator_step" && w.ref.includes("brainstorm#2"))).toBe(true);

    const a2 = await completeOrchStepTurn(ctx, r.id, spawn, deps, { ok: true, n: 2 }, READY + 60);
    expect(a2.attempt).toBe(2);
    expect(a2.turnId).not.toBe(a1.turnId);
    expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2)!.result).toEqual({ ok: true, n: 2 });

    await answerHumanStep(ctx, r.id, "approve_spec", "approve", getRun(ctx, r.id)!.rev, deps, spawn);
    expect(getRun(ctx, r.id)!.status).toBe("done");
    expect(launches.length).toBeGreaterThanOrEqual(2);
  });

  test("stale done orch task without a new step.result fails attempt 2 only after its turn era — not with attempt 1's result", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, loopWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;

    const r = await startRun(ctx, { workflow: "t/orch-loop", repo: tmpDir(), brief: "B" }, spawn, deps);
    await completeOrchStepTurn(ctx, r.id, spawn, deps, { ok: true, from: 1 }, READY);
    await answerHumanStep(ctx, r.id, "approve_spec", "revise", getRun(ctx, r.id)!.rev, deps, spawn);

    const a2 = stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2)!;
    expect(a2.status).toBe("running");
    expect(a2.result).toBeUndefined();
    // Tick recovery against a prior done must not steal attempt 2 (may start its turn).
    await advanceRuns({ ...ctx, now: READY + 1 }, spawn, deps, { spawn, plannerEligible: () => true });
    const still = stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2)!;
    expect(still.status).toBe("running");
    expect(still.error).toBeUndefined();

    // A turn for attempt 2 that settles without step.result must fail THIS attempt only.
    let turn = liveTurn(ctx, r.id);
    if (!turn) {
      turn = await startTurn({ ...ctx, now: READY + 120 }, r.id, { spawn, plannerEligible: () => true });
    }
    expect(turn).not.toBeNull();
    updateTask(ctx, turn!.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, turn!.taskId!, spawn, deps);
    const failed = stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("no step result");
    expect(stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 1)!.result).toEqual({ ok: true, from: 1 });
  });

  test("max_loops exhaustion fails with the existing loop-limit message", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const tight: WorkflowDef = {
      ...loopWf,
      id: "t/orch-loop-tight",
      edges: [
        { from: "brainstorm", to: "approve_spec" },
        { from: "approve_spec", to: "done", when: "result.answer == 'approve'" },
        { from: "approve_spec", to: "brainstorm", when: "result.answer == 'revise'", maxLoops: 1 },
      ],
    };
    addDefinition(ctx, tight, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;

    const r = await startRun(ctx, { workflow: "t/orch-loop-tight", repo: tmpDir(), brief: "B" }, spawn, deps);
    await completeOrchStepTurn(ctx, r.id, spawn, deps, { ok: true }, READY);
    await answerHumanStep(ctx, r.id, "approve_spec", "revise", getRun(ctx, r.id)!.rev, deps, spawn);
    await completeOrchStepTurn(ctx, r.id, spawn, deps, { ok: true, n: 2 }, READY + 60);
    await answerHumanStep(ctx, r.id, "approve_spec", "revise", getRun(ctx, r.id)!.rev, deps, spawn);

    const live = getRun(ctx, r.id)!;
    expect(live.status).toBe("failed");
    expect(live.reason).toMatch(/loop limit approve_spec->brainstorm/);
  });

  test("direct orch→orch edge re-entry settles the prior turn without calling settleTurn by hand", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const direct: WorkflowDef = {
      id: "t/orch-direct",
      version: 1,
      steps: {
        a: { type: "agent", role: "orchestrator", prompt: "A: {{brief}}" },
        b: { type: "agent", role: "orchestrator", prompt: "B: {{brief}}" },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "done" },
      ],
      entry: "a",
    };
    addDefinition(ctx, direct, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-direct", repo: tmpDir(), brief: "B" }, spawn, deps);
    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    const turn1 = await startTurn({ ...ctx, now: READY }, r.id, orch);
    expect(turn1).not.toBeNull();
    recordStepResult(ctx, turn1!.taskId!, { ok: true, step: "a" });
    updateTask(ctx, turn1!.taskId!, t => { t.state = "done"; });
    // Advancement starts step b (orch) which must settle turn1 — do NOT call settleTurn.
    await onTaskSettled(ctx, turn1!.taskId!, spawn, deps);
    const { getTurn } = await import("../src/workflow/wakeups");
    expect(getTurn(ctx, turn1!.id)?.status).toBe("done");
    const b = stepsOfRun(ctx, r.id).find(s => s.stepId === "b");
    expect(b?.status).toBe("running");
    const turn2 = await startTurn({ ...ctx, now: READY + 60 }, r.id, orch);
    expect(turn2).not.toBeNull();
    expect(turn2!.id).not.toBe(turn1!.id);
    recordStepResult(ctx, turn2!.taskId!, { ok: true, step: "b" });
    updateTask(ctx, turn2!.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, turn2!.taskId!, spawn, deps);
    expect(getRun(ctx, r.id)!.status).toBe("done");
  });

  test("orch self-loop re-entry settles the prior turn without calling settleTurn by hand", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const self: WorkflowDef = {
      id: "t/orch-self",
      version: 1,
      steps: {
        loop: { type: "agent", role: "orchestrator", prompt: "Loop {{brief}}" },
        done: { type: "end" },
      },
      edges: [
        { from: "loop", to: "loop", when: "result.again == true", maxLoops: 2 },
        { from: "loop", to: "done", when: "result.again == false" },
      ],
      entry: "loop",
    };
    addDefinition(ctx, self, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-self", repo: tmpDir(), brief: "B" }, spawn, deps);
    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    const turn1 = await startTurn({ ...ctx, now: READY }, r.id, orch);
    expect(turn1).not.toBeNull();
    recordStepResult(ctx, turn1!.taskId!, { again: true });
    updateTask(ctx, turn1!.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, turn1!.taskId!, spawn, deps);
    const { getTurn } = await import("../src/workflow/wakeups");
    expect(getTurn(ctx, turn1!.id)?.status).toBe("done");
    expect(stepsOfRun(ctx, r.id).some(s => s.stepId === "loop" && s.attempt === 2 && s.status === "running")).toBe(true);
    const turn2 = await startTurn({ ...ctx, now: READY + 60 }, r.id, orch);
    expect(turn2).not.toBeNull();
    recordStepResult(ctx, turn2!.taskId!, { again: false });
    updateTask(ctx, turn2!.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, turn2!.taskId!, spawn, deps);
    expect(getRun(ctx, r.id)!.status).toBe("done");
  });

  test("stale result path always has a turn (no weakening if-branch)", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, loopWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-loop", repo: tmpDir(), brief: "B" }, spawn, deps);
    await completeOrchStepTurn(ctx, r.id, spawn, deps, { ok: true, from: 1 }, READY);
    await answerHumanStep(ctx, r.id, "approve_spec", "revise", getRun(ctx, r.id)!.rev, deps, spawn);
    const a2 = stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2)!;
    expect(a2.status).toBe("running");
    // Deterministic: start a turn for attempt 2 (must not be null).
    const turn = await startTurn({ ...ctx, now: READY + 120 }, r.id, { spawn, plannerEligible: () => true });
    expect(turn).not.toBeNull();
    updateTask(ctx, turn!.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, turn!.taskId!, spawn, deps);
    const failed = stepsOfRun(ctx, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("no step result");
  });

  test("fresh engine over same DB recreates exactly one wake-up for re-entry (crash/restart)", async () => {
    const home = tmpDir();
    const makeCtx = (now: number) => {
      const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), now });
      writePlanner(ctx);
      return ctx;
    };
    const ctx1 = makeCtx(NOW);
    addDefinition(ctx1, loopWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx1, { workflow: "t/orch-loop", repo: tmpDir(), brief: "B" }, spawn, deps);
    await completeOrchStepTurn(ctx1, r.id, spawn, deps, { ok: true }, READY);
    await answerHumanStep(ctx1, r.id, "approve_spec", "revise", getRun(ctx1, r.id)!.rev, deps, spawn);
    const a2 = stepsOfRun(ctx1, r.id).find(s => s.stepId === "brainstorm" && s.attempt === 2)!;
    expect(a2.status).toBe("running");
    expect(openWakeups(ctx1, r.id).filter(w => w.cause === "orchestrator_step" && w.ref.includes("brainstorm#2"))).toHaveLength(1);

    // Simulate process crash/restart: new ctx/engine over the same PACER_HOME DB.
    const ctx2 = makeCtx(READY + 1);
    await advanceRuns(ctx2, spawn, deps, { spawn, plannerEligible: () => true });
    const openOrClaimed = workflowDatabase(ctx2).query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM workflow_wakeups WHERE run_id = ? AND cause = ? AND ref LIKE '%brainstorm#2%'",
    ).get(r.id, "orchestrator_step");
    expect(openOrClaimed?.n).toBe(1);
  });

  test("stop after orch re-entry terminals the orchestrate task", async () => {
    const { stopRun } = await import("../src/workflow/engine");
    const { readTask } = await import("../src/tasks/store");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, loopWf, "source");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/orch-loop", repo: tmpDir(), brief: "B" }, spawn, deps);
    await completeOrchStepTurn(ctx, r.id, spawn, deps, { ok: true }, READY);
    await answerHumanStep(ctx, r.id, "approve_spec", "revise", getRun(ctx, r.id)!.rev, deps, spawn);
    const live = getRun(ctx, r.id)!;
    expect(live.orchestratorTaskId).toBeTruthy();
    const orchId = live.orchestratorTaskId!;
    // Re-entry left orch task queued with a wakeup and no live turn — stop must
    // reach the live-turn-absent terminalize path (do not hand-settle first).
    expect(liveTurn(ctx, r.id)).toBeNull();
    await stopRun(ctx, r.id, getRun(ctx, r.id)!.rev, deps);
    expect(getRun(ctx, r.id)!.status).toBe("stopped");
    expect(readTask(ctx, orchId)!.state).toBe("stopped");
  });
});
