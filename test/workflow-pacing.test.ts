// Phase 6 Task 2: pacing pauses and wake-up windows (D4).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { callOp, type OpDeps } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import { registerWork } from "../src/dispatch/work";
import {
  addDefinition, getDefinition, getRun, insertRun, stepsOfRun, updateRun, type RunRow,
} from "../src/workflow/store";
import { defaultEngineDeps, onTaskSettled, recordStepResult, startStep } from "../src/workflow/engine";
import { enqueueWakeup } from "../src/workflow/wakeups";
import { startTurn, type OrchestratorDeps } from "../src/workflow/orchestrator";
import { advanceRuns } from "../src/workflow/tick";
import {
  STRICT_WAKE_WINDOW_S, pacingPauseReason, wakeAllowsStart, applyPacingToLiveRuns,
  pauseRunByPerson, resumeRunByPerson, type PacingMode,
} from "../src/workflow/pacing";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import { holdMode } from "../src/core/mode-hold";

async function settleStepDone(ctx: Ctx, taskId: string, deps: OpDeps): Promise<void> {
  recordStepResult(ctx, taskId, { ok: true });
  updateTask(ctx, taskId, t => {
    t.state = "done";
    t.result = {
      status: "done", executor: "claude-code", model: null, files: "", report: "ok", backend: "direct",
    };
  });
  await onTaskSettled(ctx, taskId, undefined, {
    ...defaultEngineDeps,
    ...(deps.delegate ? { delegate: deps.delegate } : {}),
  });
}

async function driveRunToDone(ctx: Ctx, runId: string, deps: OpDeps): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const live = getRun(ctx, runId);
    if (!live || live.status === "done" || live.status === "failed" || live.status === "stopped") return;
    const running = stepsOfRun(ctx, runId).find(s => s.status === "running" && s.taskId);
    if (!running?.taskId) return;
    await settleStepDone(ctx, running.taskId, deps);
  }
}

const NOW = 1_700_000_000;

const CHAIN = `
id: t/pacing
version: 1
steps:
  one: { type: agent, kind: research, prompt: "One" }
  two: { type: agent, kind: research, prompt: "Two" }
  done: { type: end }
edges:
  - [one, two]
  - [two, done]
`;

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
    if (input.workParent || input.dispatch) {
      registerWork(ctx, task.id, {
        ...input.dispatch,
      }, input.workParent);
    }
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return { delegate };
}

function writePlanner(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

function orchDeps(mode: "relaxed" | "normal" | "strict" | "emergency"): OrchestratorDeps {
  return {
    spawn: (() => 1) as OrchestratorDeps["spawn"],
    plannerEligible: () => true,
    pacingMode: mode,
  };
}

describe("pacing pause reasons", () => {
  test("mode × priority table", () => {
    expect(pacingPauseReason("relaxed", "background")).toBeNull();
    expect(pacingPauseReason("normal", "background")).toBeNull();
    expect(pacingPauseReason("strict", "background")).toBe("pacing: strict");
    expect(pacingPauseReason("strict", "normal")).toBeNull();
    expect(pacingPauseReason("strict", "urgent")).toBeNull();
    expect(pacingPauseReason("emergency", "normal")).toBe("pacing: emergency");
    expect(pacingPauseReason("emergency", "background")).toBe("pacing: emergency");
    expect(pacingPauseReason("emergency", "urgent")).toBeNull();
  });
});

describe("wake-up windows", () => {
  test("relaxed/normal use the 30s coalesce; person wakes immediately", () => {
    const wakes = [{ createdAt: NOW, byPerson: false }];
    expect(wakeAllowsStart(NOW + 10, "normal", "normal", wakes)).toBe(false);
    expect(wakeAllowsStart(NOW + COALESCE_WINDOW_S, "normal", "normal", wakes)).toBe(true);
    expect(wakeAllowsStart(NOW, "normal", "normal", [{ createdAt: NOW, byPerson: true }])).toBe(true);
  });

  test("strict + normal uses a 10-minute window for non-person wakes", () => {
    const wakes = [{ createdAt: NOW, byPerson: false }];
    expect(wakeAllowsStart(NOW + COALESCE_WINDOW_S, "strict", "normal", wakes)).toBe(false);
    expect(wakeAllowsStart(NOW + STRICT_WAKE_WINDOW_S, "strict", "normal", wakes)).toBe(true);
    expect(wakeAllowsStart(NOW, "strict", "normal", [{ createdAt: NOW, byPerson: true }])).toBe(true);
  });

  test("emergency: only person and urgent non-person wakes", () => {
    const wakes = [{ createdAt: NOW - COALESCE_WINDOW_S, byPerson: false }];
    expect(wakeAllowsStart(NOW, "emergency", "normal", wakes, "pacing: emergency")).toBe(false);
    expect(wakeAllowsStart(NOW, "emergency", "urgent", wakes)).toBe(true);
    expect(wakeAllowsStart(NOW, "emergency", "normal", [{ createdAt: NOW, byPerson: true }], "pacing: emergency")).toBe(true);
  });
});

describe("pacing pauses at step boundaries", () => {
  test("in-flight step finishes; next step does not start while paused", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/pacing", repo: tmpDir(), brief: "bg", priority: "background",
    }, stubDeps()) as RunRow;
    // Force a person pause after entry started (or start then pause).
    let live = getRun(ctx, run.id)!;
    if (!stepsOfRun(ctx, live.id).some(s => s.taskId)) {
      // Entry may have been skipped if already pacing-paused; unpause and start via mode loose.
      live = updateRun(ctx, live.id, live.rev, { pausedReason: null });
      // Re-start by answering nothing — use a fresh run without mode pause.
    }
    // Use a dedicated run that starts under normal mode then gets paused.
    const ctx2 = fakeCtx({ now: NOW });
    writePlanner(ctx2);
    await callOp(ctx2, "workflow.add", { source: CHAIN });
    const run2 = await callOp(ctx2, "run.start", {
      workflow: "t/pacing", repo: tmpDir(), brief: "x", priority: "normal",
    }, stubDeps()) as RunRow;
    const entry = stepsOfRun(ctx2, run2.id).find(s => s.stepId === "one" && s.taskId);
    expect(entry?.taskId).toBeTruthy();
    const paused = await callOp(ctx2, "run.pause", {
      id: run2.id, expect_rev: getRun(ctx2, run2.id)!.rev,
    }) as RunRow;
    expect(paused.pausedReason).toBe("person");

    // Settle the in-flight entry step as done (needs a step.result first).
    recordStepResult(ctx2, entry!.taskId!, { ok: true });
    updateTask(ctx2, entry!.taskId!, t => {
      t.state = "done";
      t.result = {
        status: "done", executor: "claude-code", model: null, files: "", report: "ok", backend: "direct",
      };
    });
    const deps = stubDeps();
    await onTaskSettled(ctx2, entry!.taskId!, undefined, {
      ...defaultEngineDeps,
      ...(deps.delegate ? { delegate: deps.delegate } : {}),
    });

    const after = stepsOfRun(ctx2, run2.id);
    expect(after.find(s => s.stepId === "one")?.status).toBe("done");
    // Next step must not have started.
    expect(after.some(s => s.stepId === "two")).toBe(false);
  });

  test("person message still wakes the orchestrator in emergency", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    await holdMode(ctx, { mode: "emergency", until: NOW + 3600 });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/pacing", repo: tmpDir(), brief: "n", priority: "normal",
    }, stubDeps()) as RunRow;
    // Ensure paused for emergency.
    await applyPacingToLiveRuns(ctx, async (): Promise<PacingMode> => "emergency");
    const live = getRun(ctx, run.id)!;
    expect(live.pausedReason).toBe("pacing: emergency");

    enqueueWakeup(ctx, {
      runId: live.id, cause: "question", ref: "person-msg", createdAt: NOW, byPerson: true,
    });
    const turn = await startTurn(ctx, live.id, orchDeps("emergency"));
    expect(turn).not.toBeNull();
  });

  test("background run abandoned under strict then completes after mode loosens", async () => {
    // Was: pause cleared but entry never started → run stuck running forever.
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    await holdMode(ctx, { mode: "strict", until: NOW + 3600 });
    const deps = stubDeps();
    const run = await callOp(ctx, "run.start", {
      workflow: "t/pacing", repo: tmpDir(), brief: "bg", priority: "background",
    }, deps) as RunRow;
    expect(getRun(ctx, run.id)!.pausedReason).toBe("pacing: strict");
    expect(stepsOfRun(ctx, run.id)).toHaveLength(0);

    await holdMode(ctx, { mode: "normal", until: NOW + 3600 });
    const engineDeps = {
      ...defaultEngineDeps,
      ...(deps.delegate ? { delegate: deps.delegate } : {}),
    };
    await advanceRuns(ctx, undefined, engineDeps, { pacingMode: "normal" });
    expect(getRun(ctx, run.id)!.pausedReason).toBeUndefined();
    const entry = stepsOfRun(ctx, run.id).find(s => s.stepId === "one" && s.taskId);
    expect(entry?.taskId).toBeTruthy();

    // Idempotent: a second tick must not duplicate the entry.
    await advanceRuns(ctx, undefined, engineDeps, { pacingMode: "normal" });
    expect(stepsOfRun(ctx, run.id).filter(s => s.stepId === "one")).toHaveLength(1);

    await driveRunToDone(ctx, run.id, deps);
    expect(getRun(ctx, run.id)!.status).toBe("done");
  });

  test("person pause at start then run.resume starts the entry", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    await holdMode(ctx, { mode: "emergency", until: NOW + 3600 });
    const deps = stubDeps();
    const run = await callOp(ctx, "run.start", {
      workflow: "t/pacing", repo: tmpDir(), brief: "n", priority: "normal",
    }, deps) as RunRow;
    expect(getRun(ctx, run.id)!.pausedReason).toBe("pacing: emergency");
    expect(stepsOfRun(ctx, run.id)).toHaveLength(0);

    // Person takes the pause (still no steps); resume must start entry.
    const personPaused = await callOp(ctx, "run.pause", {
      id: run.id, expect_rev: getRun(ctx, run.id)!.rev,
    }) as RunRow;
    expect(personPaused.pausedReason).toBe("person");
    expect(stepsOfRun(ctx, run.id)).toHaveLength(0);

    await holdMode(ctx, { mode: "normal", until: NOW + 3600 });
    const resumed = await callOp(ctx, "run.resume", {
      id: run.id, expect_rev: getRun(ctx, run.id)!.rev,
    }, deps) as RunRow;
    expect(resumed.pausedReason).toBeUndefined();
    const entry = stepsOfRun(ctx, run.id).find(s => s.stepId === "one" && s.taskId);
    expect(entry?.taskId).toBeTruthy();

    await driveRunToDone(ctx, run.id, deps);
    expect(getRun(ctx, run.id)!.status).toBe("done");
  });

  test("paused_reason is on the run entity for person pause", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    await callOp(ctx, "workflow.add", { source: CHAIN });
    const run = await callOp(ctx, "run.start", {
      workflow: "t/pacing", repo: tmpDir(), brief: "p",
    }, stubDeps()) as RunRow;
    const paused = await callOp(ctx, "run.pause", {
      id: run.id, expect_rev: getRun(ctx, run.id)!.rev,
    }) as RunRow;
    expect(paused.pausedReason).toBe("person");
    const got = await callOp(ctx, "run.get", { id: run.id }) as { run: RunRow };
    expect(got.run.pausedReason).toBe("person");
    const resumed = await callOp(ctx, "run.resume", {
      id: run.id, expect_rev: got.run.rev,
    }) as RunRow;
    expect(resumed.pausedReason).toBeUndefined();
  });

  test("applyPacingToLiveRuns skips mode read when no live runs", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    let reads = 0;
    const n = await applyPacingToLiveRuns(ctx, async (): Promise<PacingMode> => {
      reads++;
      return "emergency";
    });
    expect(n).toBe(0);
    expect(reads).toBe(0);
  });

  test("person pause/resume applies to the whole run tree", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, {
      id: "t/pacing", version: 1, entry: "one",
      steps: {
        one: { type: "agent", kind: "research", prompt: "One" },
        two: { type: "agent", kind: "research", prompt: "Two" },
        done: { type: "end" },
      },
      edges: [{ from: "one", to: "two" }, { from: "two", to: "done" }],
    }, CHAIN);
    const def = getDefinition(ctx, "t/pacing")!;
    const deps = stubDeps();
    const engine = {
      ...defaultEngineDeps,
      ...(deps.delegate ? { delegate: deps.delegate } : {}),
    };
    const parent = insertRun(ctx, {
      workflow: def.id, version: def.version, repo: tmpDir(), brief: "parent",
    });
    await startStep(ctx, parent, def, def.entry, undefined, { deps: engine });
    const child = insertRun(ctx, {
      workflow: def.id, version: def.version, repo: tmpDir(), brief: "child",
      parentRunId: parent.id, parentStep: "one",
    });
    await startStep(ctx, child, def, def.entry, undefined, { deps: engine });
    expect(stepsOfRun(ctx, child.id).some(s => s.taskId)).toBe(true);

    const paused = pauseRunByPerson(ctx, parent.id, getRun(ctx, parent.id)!.rev);
    expect(paused.pausedReason).toBe("person");
    expect(getRun(ctx, child.id)!.pausedReason).toBe("person");

    // Child must not start a further step while the tree is person-paused.
    await expect(startStep(ctx, getRun(ctx, child.id)!, def, "two", undefined, { deps: engine }))
      .rejects.toThrow(/paused/);

    const resumed = resumeRunByPerson(ctx, parent.id, getRun(ctx, parent.id)!.rev, "normal");
    expect(resumed.pausedReason).toBeUndefined();
    expect(getRun(ctx, child.id)!.pausedReason).toBeUndefined();
  });
});
