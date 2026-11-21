// Round-4 minor findings: prompt caps, attention kinds, choose CAS, retry cap,
// callerParticipant, set_planner clearing unresolved, unresolved streak rev retry.
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
  addDefinition, getRun, insertRun, insertStep, stepsOfRun, updateRun, updateStep, workflowDatabase,
} from "../src/workflow/store";
import { chooseWorkflow, startRun, type EngineDeps } from "../src/workflow/engine";
import { buildTurnPrompt, settleTurn, startTurn } from "../src/workflow/orchestrator";
import { addWakeup, insertTurn } from "../src/workflow/wakeups";
import { COALESCE_WINDOW_S, parseSpent, serializeSpent, stampAttentionAt } from "../src/workflow/budget";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import { callOp } from "../src/api/ops";
import { callerParticipant } from "../src/messaging/participants";
import type { WorkflowDef } from "../src/workflow/schema";
import { CoreError } from "../src/core/errors";

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
    deps: { delegate, stopTask: (ctx: Ctx, id: string) => updateTask(ctx, id, t => { t.state = "stopped"; }) } as EngineDeps,
  };
}

describe("round-4 minors", () => {
  // S-NEW-3: overflowing unfenced blocks must truncate in place, not drop later blocks.
  test("assemblePrompt caps an overflowing open block and keeps later blocks", async () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, { workflow: "t/cap", version: 1, repo: tmpDir(), brief: "b" });
    const big = "X".repeat(16 * 1024);
    const def: WorkflowDef = {
      id: "t/cap", version: 1,
      steps: {
        a: { type: "agent", role: "orchestrator", prompt: big },
        b: { type: "agent", role: "orchestrator", prompt: big },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "b" }, { from: "b", to: "done" }],
      entry: "a",
    };
    addDefinition(ctx, def, "s");
    insertStep(ctx, { runId: run.id, stepId: "a", attempt: 1, status: "running" });
    insertStep(ctx, { runId: run.id, stepId: "b", attempt: 1, status: "running" });
    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));
    expect(prompt).toContain("…[truncated]");
    // Both blocks present (second not dropped by break).
    expect(prompt).toMatch(/## Orchestrator step .*\/a#1/);
    expect(prompt).toMatch(/## Orchestrator step .*\/b#1/);
    // Brief / run state still present after capped open blocks.
    expect(prompt).toMatch(/from the brief|run state/);
  });

  // S-NEW-4: open/failed steps listed first; result= abbreviated so error=/task=/run= survive.
  test("turn prompt lists open and failed steps first with abbreviated results", () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, { workflow: "t/order", version: 1, repo: tmpDir(), brief: "b" });
    const fat = { payload: "Y".repeat(4000) };
    insertStep(ctx, { runId: run.id, stepId: "done-old", attempt: 1, status: "done", taskId: "t-old" });
    updateStep(ctx, { runId: run.id, stepId: "done-old", attempt: 1 }, { result: fat });
    insertStep(ctx, { runId: run.id, stepId: "failed", attempt: 1, status: "failed", taskId: "t-fail" });
    updateStep(ctx, { runId: run.id, stepId: "failed", attempt: 1 }, { error: "boom-err" });
    insertStep(ctx, { runId: run.id, stepId: "open", attempt: 1, status: "running", taskId: "t-open" });
    const prompt = buildTurnPrompt(ctx, run, [], null, stepsOfRun(ctx, run.id));
    const failedAt = prompt.indexOf("failed#1");
    const openAt = prompt.indexOf("open#1");
    const doneAt = prompt.indexOf("done-old#1");
    expect(failedAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(-1);
    expect(doneAt).toBeGreaterThan(-1);
    expect(Math.min(failedAt, openAt)).toBeLessThan(doneAt);
    expect(prompt).toContain("error=boom-err");
    expect(prompt).toContain("task=t-fail");
    expect(prompt).toContain(`run=${run.id}`);
    // Fat result abbreviated, not a multi-KB blob that crowds out later fields.
    expect(prompt).not.toContain("Y".repeat(500));
  });

  // A-m2: stamp/clear per kind.
  test("attention stamps use per-kind clocks; clearAttentionAt without kind leaves others", async () => {
    const { clearAttentionAt, stampAttentionAt: stamp, parseSpent: ps } = await import("../src/workflow/budget");
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, { workflow: "t/attn", version: 1, repo: tmpDir(), brief: "b" });
    stamp(ctx, run.id, "budget_spent");
    stamp({ ...ctx, now: NOW + 10 }, run.id, "orchestrator_failed");
    const spent = ps(getRun(ctx, run.id)!.spent);
    expect(spent.attentionAtByKind?.budget_spent).toBe(NOW);
    expect(spent.attentionAtByKind?.orchestrator_failed).toBe(NOW + 10);
    // clear without kind must not wipe all kinds (A-m2 / N5-2).
    clearAttentionAt(ctx, run.id);
    const after = ps(getRun(ctx, run.id)!.spent);
    expect(after.attentionAtByKind?.budget_spent).toBe(NOW);
    expect(after.attentionAtByKind?.orchestrator_failed).toBe(NOW + 10);
    clearAttentionAt(ctx, run.id, "budget_spent");
    const cleared = ps(getRun(ctx, run.id)!.spent);
    expect(cleared.attentionAtByKind?.budget_spent).toBeUndefined();
    expect(cleared.attentionAtByKind?.orchestrator_failed).toBe(NOW + 10);
  });

  // S M5: orchestrator session always attributes as orchestrator.
  test("callerParticipant forces orchestrator for run-grant sessions", () => {
    const ctx = fakeCtx({
      env: { PACER_ROLE: "orchestrator", PACER_RUN_GRANT: `prg_${"f".repeat(64)}` },
    });
    expect(callerParticipant(ctx, { participant: "human" }).id).toBe("orchestrator");
    expect(callerParticipant(ctx).id).toBe("orchestrator");
  });

  // S N5: retry cap counts retries, not loop attempts.
  test("retry cap ignores high attempt from loops and counts retries only", async () => {
    const { retryFailedStep } = await import("../src/workflow/engine");
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const def: WorkflowDef = {
      id: "t/retry-cap", version: 1,
      steps: {
        one: { type: "agent", kind: "research", prompt: "One" },
        done: { type: "end" },
      },
      edges: [{ from: "one", to: "done" }],
      entry: "one",
    };
    addDefinition(ctx, def, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/retry-cap", repo: tmpDir(), brief: "B" }, spawn, deps);
    // Simulate a loop-elevated attempt number without prior retries.
    const s1 = stepsOfRun(ctx, r.id)[0]!;
    updateStep(ctx, { runId: r.id, stepId: "one", attempt: 1 }, {
      status: "failed", error: "x", endedAt: NOW, advancedAt: undefined,
    });
    // Insert a failed attempt 5 (as if loops raised the counter) with no advanced priors.
    insertStep(ctx, {
      runId: r.id, stepId: "one", attempt: 5, status: "failed", taskId: createTask(ctx, {
        brief: { goal: "x", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60,
      }).id,
    });
    updateStep(ctx, { runId: r.id, stepId: "one", attempt: 5 }, { error: "loop-fail", endedAt: NOW });
    updateRun(ctx, r.id, getRun(ctx, r.id)!.rev, { status: "waiting" });
    // Must not refuse solely because attempt >= 3.
    await retryFailedStep(ctx, { runId: r.id, stepId: "one" }, spawn, deps);
    expect(stepsOfRun(ctx, r.id).some(s => s.stepId === "one" && s.attempt === 6)).toBe(true);
  });

  // A-m1: concurrent chooseWorkflow claims before startRun.
  test("two concurrent run.choose create only one child", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const childWf: WorkflowDef = {
      id: "t/m1-child", version: 1,
      steps: { work: { type: "agent", kind: "research", prompt: "W" }, done: { type: "end" } },
      edges: [{ from: "work", to: "done" }], entry: "work",
    };
    const chooseWf: WorkflowDef = {
      id: "t/m1-choose", version: 1,
      steps: { pick: { type: "choose_workflow", from: ["t/m1-child"] }, done: { type: "end" } },
      edges: [{ from: "pick", to: "done" }], entry: "pick",
    };
    addDefinition(ctx, chooseWf, "s");
    addDefinition(ctx, childWf, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/m1-choose", repo: tmpDir(), brief: "B" }, spawn, deps);
    const results = await Promise.allSettled([
      chooseWorkflow(ctx, { runId: r.id, stepId: "pick", workflow: "t/m1-child", reason: "a" }, spawn, deps),
      chooseWorkflow(ctx, { runId: r.id, stepId: "pick", workflow: "t/m1-child", reason: "b" }, spawn, deps),
    ]);
    const ok = results.filter(x => x.status === "fulfilled");
    const bad = results.filter(x => x.status === "rejected");
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(CoreError);
    const children = workflowDatabase(ctx).query<{ id: string }, [string]>(
      "SELECT id FROM workflow_runs WHERE parent_run_id = ?",
    ).all(r.id);
    expect(children).toHaveLength(1);
  });

  // set_planner clears unresolvedWakes when clearing a non-budget block.
  test("run.set_planner clears unresolvedWakes when unblocking", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    let run = insertRun(ctx, { workflow: "t/sp", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "unresolved wake step_failed:x after 2 done turns",
      spent: serializeSpent({
        orchestratorTurns: 1, messageTurns: 0,
        blockedBy: "unresolved",
        unresolvedWakes: { "step_failed:x": 2 },
      }),
    });
    const updated = await callOp(ctx, "run.set_planner", {
      id: run.id, planner: "codex", expect_rev: run.rev,
    }) as { orchestratorState?: string; spent?: string };
    expect(updated.orchestratorState).toBe("idle");
    const spent = parseSpent(getRun(ctx, run.id)!.spent);
    expect(spent.unresolvedWakes).toBeUndefined();
    expect(spent.blockedBy).toBeUndefined();
  });
});
