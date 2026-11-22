import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { buildReadModel, readModelContext } from "../src/api/read-model";
import { snapshotTasks } from "../src/api/read-model/tasks";
import { loadStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { slotUse } from "../src/engine/slots";
import { createTask, listActiveAndRecentTasks, listTasksWhere, updateTask } from "../src/tasks/store";
import { superviseTask } from "../src/tasks/api";
import { addDefinition, getRun } from "../src/workflow/store";
import { startRun, stopRun, type EngineDeps } from "../src/workflow/engine";
import { registerWork } from "../src/dispatch/work";
import { fakeCtx, tmpDir } from "./helpers";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import type { WorkflowDef } from "../src/workflow/schema";

function writeStrategy(ctx: ReturnType<typeof fakeCtx>) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), [
    "planner: claude-code",
    "providers:",
    "  claude-code: {}",
    "  codex: {}",
    "execution:",
    "  local_max_tasks: 2",
    "",
  ].join("\n"));
}

function fakeDeps() {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return prior;
    const task = createTask(ctx, {
      brief: input.brief,
      kind: input.kind ?? null,
      requestedExecutor: null,
      timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.workParent) registerWork(ctx, task.id, input.dispatch ?? {}, input.workParent, input.workGrant);
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return {
    deps: {
      delegate,
      stopTask: (ctx: ReturnType<typeof fakeCtx>, id: string) => {
        updateTask(ctx, id, t => { t.state = "stopped"; });
      },
    } satisfies EngineDeps,
  };
}

const chain: WorkflowDef = {
  id: "t/root-hide",
  version: 1,
  steps: {
    one: { type: "agent", kind: "research", prompt: "One" },
    done: { type: "end" },
  },
  edges: [{ from: "one", to: "done" }],
  entry: "one",
};

describe("workflow-root hide, capacity, supervision, stop", () => {
  test("hidden from snapshot/list; does not count in machine.used or slots; plain run untouched", async () => {
    const ctx = fakeCtx();
    writeStrategy(ctx);
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, undefined, deps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;
    expect(rootId).toBeTruthy();

    const ordinary = createTask(ctx, {
      brief: { goal: "ordinary", repo: tmpDir() },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, ordinary.id, t => { t.state = "running"; t.executor = "codex"; });

    const snap = (await callOp(ctx, "snapshot.get", {})) as {
      snapshot: { machine: { used: number }; tasks: { id: string; kind?: string | null }[] };
    };
    expect(snap.snapshot.tasks.some(t => t.id === rootId)).toBe(false);
    expect(snap.snapshot.tasks.every(t => t.kind !== "workflow-root")).toBe(true);
    expect(snap.snapshot.tasks.every(t => t.kind !== "orchestrate")).toBe(true);
    // Ordinary local running only — workflow-root must not bump used.
    expect(snap.snapshot.machine.used).toBe(1);

    const use = slotUse(listTasksWhere(ctx, { states: ["running"] }), ctx);
    expect(use.local).toBe(1);

    // Plain pinned run (step_mode plain) has no root.
    const plainCtx = fakeCtx();
    writeStrategy(plainCtx);
    addDefinition(plainCtx, chain, "source");
    const { insertRun, updateRun } = await import("../src/workflow/store");
    const plain = insertRun(plainCtx, {
      workflow: chain.id, version: 1, repo: tmpDir(), brief: "plain",
    });
    // Force plain mode as Phase 1 upgrade path.
    updateRun(plainCtx, plain.id, plain.rev, { stepMode: "plain" });
    expect(getRun(plainCtx, plain.id)!.stepMode).toBe("plain");
    expect(getRun(plainCtx, plain.id)!.rootTaskId).toBeUndefined();
  });

  test("supervision does not fail a live workflow-root; stop settles root and children", async () => {
    const ctx = fakeCtx({ now: 1_700_000_000 });
    addDefinition(ctx, chain, "source");
    const { deps } = fakeDeps();
    const run = await startRun(ctx, { workflow: chain.id, repo: tmpDir(), brief: "B" }, undefined, deps);
    const rootId = getRun(ctx, run.id)!.rootTaskId!;
    const rootBefore = listTasksWhere(ctx, { all: true }).find(t => t.id === rootId)!;
    expect(rootBefore.state).toBe("running");

    // Advance the clock past the 600s neverStarted threshold.
    const later = { ...ctx, now: ctx.now + 700 };
    await superviseTask(later, rootId);
    const rootAfter = listTasksWhere(later, { all: true }).find(t => t.id === rootId)!;
    expect(rootAfter.state).toBe("running");
    void rootBefore;

    const stopped = await stopRun(ctx, run.id, getRun(ctx, run.id)!.rev, deps);
    expect(stopped.status).toBe("stopped");
    const rootFinal = listTasksWhere(ctx, { all: true }).find(t => t.id === rootId)!;
    expect(["stopped", "done", "failed"]).toContain(rootFinal.state);
  });
});

void buildReadModel;
void readModelContext;
void snapshotTasks;
void listActiveAndRecentTasks;
void loadStrategy;
void computeStatus;
