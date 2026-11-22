// Round-6 minors: S-M1, S-M4, S-M5, A-M2/S-M6, A-M3, A-M4, A-M5.
import { describe, expect, spyOn, test } from "bun:test";
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
import { buildTurnPrompt, startTurn } from "../src/workflow/orchestrator";
import {
  CHOOSING_STALE_S, chooseStepChildRunId, enqueueWakeup, reconcileStaleChooseClaims,
} from "../src/workflow/wakeups";
import * as budget from "../src/workflow/budget";
import {
  applyBudgetRaise, COALESCE_WINDOW_S, parseSpent,
  serializeBudget, serializeSpent, stampAttentionAt,
} from "../src/workflow/budget";
import * as runGrant from "../src/workflow/run-grant";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import { callOp } from "../src/api/ops";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;
const READY = NOW + COALESCE_WINDOW_S;
const PROMPT_CAP = 32 * 1024;

function writePlanner(ctx: Ctx): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

function fakeDeps(onDelegate?: (input: DelegateInput) => void) {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    onDelegate?.(input);
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

const childWf: WorkflowDef = {
  id: "t/m-child", version: 1,
  steps: { work: { type: "agent", kind: "research", prompt: "W" }, done: { type: "end" } },
  edges: [{ from: "work", to: "done" }], entry: "work",
};
const chooseWf: WorkflowDef = {
  id: "t/m-choose", version: 1,
  steps: { pick: { type: "choose_workflow", from: ["t/m-child"] }, done: { type: "end" } },
  edges: [{ from: "pick", to: "done" }], entry: "pick",
};

describe("round-6 S-M1: claim release only while waiting+choosing", () => {
  test("startRun throw after child insert keeps settleParentChooseStep result", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "s");
    addDefinition(ctx, childWf, "s");
    let childDelegates = 0;
    const { deps } = fakeDeps((input) => {
      // Child entry agent: throw after insertRun so failRun settles the parent claim.
      if (input.brief.goal.includes("W") || input.requestId?.includes("/work#")) {
        childDelegates++;
        throw new Error("boom after child insert");
      }
    });
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/m-choose", repo: tmpDir(), brief: "B" }, spawn, deps);

    await expect(chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/m-child", reason: "x",
    }, spawn, deps)).rejects.toThrow(/boom after child insert/i);

    expect(childDelegates).toBeGreaterThan(0);
    const pick = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!;
    // Settled failure result from settleParentChooseStep must survive the catch release.
    expect(pick.status).toBe("failed");
    expect(pick.result).toMatchObject({
      workflow: "t/m-child",
      child: expect.objectContaining({ status: "failed" }),
    });
  });
});

describe("round-6 S-M4: assemblePrompt keeps drop-marker reserve", () => {
  test("dropping open blocks still leaves the omit marker (reserve kept for whole loop)", () => {
    const ctx = fakeCtx({ now: NOW });
    const bigBrief = "B".repeat(12 * 1024);
    const bigPrompt = "P".repeat(10 * 1024);
    const run = insertRun(ctx, {
      workflow: "t/sm4", version: 1, repo: tmpDir(), brief: bigBrief, title: "sm4",
    });
    const def: WorkflowDef = {
      id: "t/sm4", version: 1,
      steps: {
        a: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        b: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        c: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        d: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" }, { from: "b", to: "c" },
        { from: "c", to: "d" }, { from: "d", to: "done" },
      ],
      entry: "a",
    };
    addDefinition(ctx, def, "s");
    for (const id of ["a", "b", "c", "d"]) {
      insertStep(ctx, { runId: run.id, stepId: id, attempt: 1, status: "running" });
    }
    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(PROMPT_CAP);
    // Without keeping the reserve, a later small block can consume marker room (S-M4).
    expect(prompt).toMatch(/omitted blocks to fit budget/);
  });
});

describe("round-6 S-M5: startTurn refunds once on launch failure", () => {
  test("settleTurn throw after launch refund does not double-refund", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const chain: WorkflowDef = {
      id: "t/sm5", version: 1,
      steps: {
        one: { type: "agent", kind: "research", prompt: "One" },
        done: { type: "end" },
      },
      edges: [{ from: "one", to: "done" }],
      entry: "one",
    };
    addDefinition(ctx, chain, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    let run = await startRun(ctx, {
      workflow: "t/sm5", repo: tmpDir(), brief: "B",
    }, spawn, deps);
    run = updateRun(ctx, run.id, run.rev, {
      budget: serializeBudget({ orchestratorTurns: 10, messageTurns: 10 }),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    });
    enqueueWakeup(ctx, {
      runId: run.id, cause: "step_failed", ref: `${run.id}/one#1`, createdAt: NOW - 100,
    });

    // Force settleTurn (via revokeRunGrant) to throw after the launch-path refund,
    // so the outer startTurn catch would otherwise refund again (S-M2).
    const revoke = spyOn(runGrant, "revokeRunGrant").mockImplementation(() => {
      throw new Error("settle boom");
    });
    let refunds = 0;
    const realRefund = budget.refundOrchestratorTurn;
    const refund = spyOn(budget, "refundOrchestratorTurn").mockImplementation((c, id) => {
      refunds += 1;
      return realRefund(c, id);
    });

    const badSpawn: SpawnRunner = () => {
      throw new Error("launch boom");
    };
    try {
      await startTurn({ ...ctx, now: READY }, run.id, {
        spawn: badSpawn, plannerEligible: () => true, skipDefaultPacing: true,
      });
    } catch (err) {
      // settleTurn may surface after the single refund; either return or throw is fine.
      expect(err).toBeInstanceOf(Error);
    }
    const spent = parseSpent(getRun(ctx, run.id)!.spent);
    // countOrchestratorTurn then exactly one refund → 0 (never a second refund).
    expect(refunds).toBe(1);
    expect(spent.orchestratorTurns).toBe(0);
    revoke.mockRestore();
    refund.mockRestore();
  });
});

describe("round-6 A-M2/S-M6: stale choose claims filter by choosingAt", () => {
  test("older finished child from a prior attempt is not stamped on a new choosing claim", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "s");
    addDefinition(ctx, childWf, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/m-choose", repo: tmpDir(), brief: "B" }, spawn, deps);
    const pick = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!;
    // Old child from a previous attempt (created before choosingAt).
    const oldChild = insertRun(ctx, {
      workflow: "t/m-child", version: 1, repo: r.repo, brief: "B",
      parentRunId: r.id, parentStep: "pick",
    });
    workflowDatabase(ctx).query(
      "UPDATE workflow_runs SET created_at = ? WHERE id = ?",
    ).run(NOW - 1000, oldChild.id);

    const choosingAt = NOW - CHOOSING_STALE_S - 1;
    updateStep(ctx, { runId: r.id, stepId: "pick", attempt: pick.attempt }, {
      result: { workflow: "t/m-child", reason: "retry", choosing: true, choosingAt },
    });

    const handled = reconcileStaleChooseClaims({ ...ctx, now: NOW });
    expect(handled).toBe(1);
    const after = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!;
    // Must clear (no child created at/after choosingAt), not stamp the old child.
    expect(chooseStepChildRunId(after.result)).toBeUndefined();
    expect(after.result).toBeUndefined();
  });

  test("slow in-flight startRun child is not cleared while still creating", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    addDefinition(ctx, chooseWf, "s");
    addDefinition(ctx, childWf, "s");
    const r = await startRun(ctx, { workflow: "t/m-choose", repo: tmpDir(), brief: "B" }, () => 1, fakeDeps().deps);
    const pick = stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!;
    const choosingAt = NOW - CHOOSING_STALE_S - 1;
    updateStep(ctx, { runId: r.id, stepId: "pick", attempt: pick.attempt }, {
      result: { workflow: "t/m-child", reason: "mid", choosing: true, choosingAt },
    });
    // Child appears just as we reconcile (created_at >= choosingAt) — stamp, do not clear.
    const child = insertRun(ctx, {
      workflow: "t/m-child", version: 1, repo: r.repo, brief: "B",
      parentRunId: r.id, parentStep: "pick",
    });
    workflowDatabase(ctx).query(
      "UPDATE workflow_runs SET created_at = ? WHERE id = ?",
    ).run(choosingAt + 1, child.id);

    reconcileStaleChooseClaims({ ...ctx, now: NOW });
    expect(chooseStepChildRunId(
      stepsOfRun(ctx, r.id).find(s => s.stepId === "pick")!.result,
    )).toBe(child.id);
  });
});

describe("round-6 A-M3: stronger assertions", () => {
  test("H3 marker asserts omitted blocks to fit budget", () => {
    const ctx = fakeCtx({ now: NOW });
    const bigBrief = "B".repeat(12 * 1024);
    const bigPrompt = "P".repeat(10 * 1024);
    const run = insertRun(ctx, {
      workflow: "t/am3-h3", version: 1, repo: tmpDir(), brief: bigBrief, title: "h3",
    });
    const def: WorkflowDef = {
      id: "t/am3-h3", version: 1,
      steps: {
        a: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        b: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        c: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        d: { type: "agent", role: "orchestrator", prompt: bigPrompt },
        done: { type: "end" },
      },
      edges: [
        { from: "a", to: "b" }, { from: "b", to: "c" },
        { from: "c", to: "d" }, { from: "d", to: "done" },
      ],
      entry: "a",
    };
    addDefinition(ctx, def, "s");
    for (const id of ["a", "b", "c", "d"]) {
      insertStep(ctx, { runId: run.id, stepId: id, attempt: 1, status: "running" });
    }
    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));
    expect(prompt).toMatch(/omitted blocks to fit budget/);
  });
});

describe("round-6 A-M4: clearBudgetAttention only raise kinds", () => {
  test("orchestrator budget raise does not clear message-budget stamps", () => {
    const ctx = fakeCtx({ now: NOW });
    let run = insertRun(ctx, { workflow: "t/am4", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, {
      budget: serializeBudget({ orchestratorTurns: 5, messageTurns: 10 }),
      spent: serializeSpent({ orchestratorTurns: 5, messageTurns: 10 }),
      orchestratorState: "blocked",
      reason: "turn budget spent",
    });
    stampAttentionAt(ctx, run.id, "budget_spent");
    stampAttentionAt(ctx, run.id, "budget_msg_spent");
    const raised = applyBudgetRaise(ctx, run.id, getRun(ctx, run.id)!.rev, {
      orchestratorTurns: 20,
    });
    const spent = parseSpent(raised.spent);
    expect(spent.attentionAtByKind?.budget_spent).toBeUndefined();
    expect(spent.attentionAtByKind?.budget_msg_spent).toBe(NOW);
  });
});

describe("round-6 A-M5: attentionAt fallback does not revive cleared kinds", () => {
  test("cleared orchestrator_failed does not reuse scalar attentionAt while other kinds remain", async () => {
    const ctx = fakeCtx({ now: NOW });
    let run = insertRun(ctx, { workflow: "t/am5", version: 1, repo: tmpDir(), brief: "b" });
    run = updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
      spent: serializeSpent({ orchestratorTurns: 1, messageTurns: 0 }),
    });
    stampAttentionAt(ctx, run.id, "budget_warn");
    stampAttentionAt({ ...ctx, now: NOW + 50 }, run.id, "orchestrator_failed");
    expect(parseSpent(getRun(ctx, run.id)!.spent).attentionAt).toBe(NOW);

    await callOp(ctx, "run.retry_orchestrator", {
      id: run.id, expect_rev: getRun(ctx, run.id)!.rev,
    });
    const spent = parseSpent(getRun(ctx, run.id)!.spent);
    expect(spent.attentionAtByKind?.orchestrator_failed).toBeUndefined();
    expect(spent.attentionAtByKind?.budget_warn).toBe(NOW);

    // Re-block later without a fresh stamp: since uses updatedAt, not the scalar.
    const later = { ...ctx, now: NOW + 200 };
    updateRun(later, run.id, getRun(later, run.id)!.rev, {
      orchestratorState: "blocked",
      reason: "planner failed 4×",
    });
    const item = deriveWorkflowAttention(later).find(i => i.id === `orchestrator_failed:${run.id}`);
    expect(item?.since).toBe(NOW + 200);
    expect(item?.since).not.toBe(NOW);
  });
});
