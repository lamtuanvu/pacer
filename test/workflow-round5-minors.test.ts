// Round-5 remaining minors: N5-5, A-M4/5/7, N5-6, grandchildren, error cap.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { SpawnRunner } from "../src/tasks/api";
import { createTask, listTasks, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import {
  addDefinition, getRun, insertRun, insertStep, stepsOfRun, updateRun, updateStep, workflowDatabase,
} from "../src/workflow/store";
import { chooseWorkflow, startRun, type EngineDeps } from "../src/workflow/engine";
import {
  buildHandoverPrompt, buildTurnPrompt, getOrchestratorAttention, settleTurn, startTurn,
} from "../src/workflow/orchestrator";
import { stepsOfRootTree } from "../src/workflow/wakeups";
import { COALESCE_WINDOW_S, parseSpent, serializeSpent, stampAttentionAt } from "../src/workflow/budget";
import { applyBudgetRaise } from "../src/workflow/budget";
import { executorEnv } from "../src/exec/process";
import { defaultPumpDeps } from "../src/link/pump";
import { snapshotTasks } from "../src/api/read-model/tasks";
import { listActiveAndRecentTasks } from "../src/tasks/store";
import { main } from "../src/cli";
import type { WorkflowDef } from "../src/workflow/schema";

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
    deps: {
      delegate,
      stopTask: (ctx: Ctx, id: string) => updateTask(ctx, id, t => { t.state = "stopped"; }),
    } as EngineDeps,
  };
}

describe("round-5 N5-5: production opt-in for orchestrate grant", () => {
  test("executorEnv opts in role+prg_ only when runGrant is passed (orchestrate sites)", () => {
    const grant = `prg_${"a".repeat(64)}`;
    const orch = executorEnv(
      { PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator", PATH: "/bin" },
      { HOME: "/tmp" },
      "t-orch",
      [],
      { runGrant: grant },
    );
    expect(orch.PACER_ROLE).toBe("orchestrator");
    expect(orch.PACER_RUN_GRANT).toBe(grant);

    const plain = executorEnv(
      { PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator", PATH: "/bin" },
      { HOME: "/tmp" },
      "t-plain",
      [],
    );
    expect(plain.PACER_ROLE).toBe("executor");
    expect(plain.PACER_RUN_GRANT).toBeUndefined();
  });

  // Vacuous local-lambda opt-in test removed in round-6 I3; see test/workflow-round6-i3.test.ts.
});

describe("round-5 A-M4: filter orchestrate from list/pump/host bridge", () => {
  test("pacer list, pump tasks, and host snapshot hide orchestrate; store still has them", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const orch = createTask(ctx, {
      brief: { goal: "orchestrate run_x", repo: tmpDir() },
      kind: "orchestrate", requestedExecutor: null, timeoutS: 60,
    });
    const plain = createTask(ctx, {
      brief: { goal: "plain work", repo: tmpDir() },
      kind: "research", requestedExecutor: null, timeoutS: 60,
    });
    expect(listTasks(ctx, Infinity).some(t => t.id === orch.id)).toBe(true);

    const listed = defaultPumpDeps.tasks(ctx);
    expect(listed.some(t => t.id === orch.id)).toBe(false);
    expect(listed.some(t => t.id === plain.id)).toBe(true);

    const snap = snapshotTasks(ctx, listActiveAndRecentTasks(ctx));
    expect(snap.every(t => t.kind !== "orchestrate")).toBe(true);

    const out = await main(["tasks", "--all", "--json"], ctx);
    expect(out.code).toBe(0);
    const rows = JSON.parse(out.out) as { id?: string; task_id?: string; kind?: string | null }[];
    expect(rows.every(r => r.kind !== "orchestrate")).toBe(true);
    const ids = rows.map(r => r.id ?? r.task_id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(orch.id);
  });
});

describe("round-5 A-M5: one step.result per turn documented and ordered", () => {
  test("turn prompt states one step per turn and lists open orch steps in stable order", () => {
    const ctx = fakeCtx({ now: NOW });
    const run = insertRun(ctx, { workflow: "t/am5", version: 1, repo: tmpDir(), brief: "b" });
    const def: WorkflowDef = {
      id: "t/am5", version: 1,
      steps: {
        a: { type: "agent", role: "orchestrator", prompt: "A-FIRST" },
        b: { type: "agent", role: "orchestrator", prompt: "B-SECOND" },
        done: { type: "end" },
      },
      edges: [{ from: "a", to: "b" }, { from: "b", to: "done" }],
      entry: "a",
    };
    addDefinition(ctx, def, "s");
    insertStep(ctx, { runId: run.id, stepId: "b", attempt: 1, status: "running" });
    // Older startedAt for a so it lists first.
    workflowDatabase(ctx).query(
      "UPDATE workflow_steps SET started_at = ? WHERE run_id = ? AND step_id = ?",
    ).run(NOW - 10, run.id, "b");
    insertStep(ctx, { runId: run.id, stepId: "a", attempt: 1, status: "running" });
    workflowDatabase(ctx).query(
      "UPDATE workflow_steps SET started_at = ? WHERE run_id = ? AND step_id = ?",
    ).run(NOW - 20, run.id, "a");
    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));
    expect(prompt).toMatch(/One step\.result per turn: report the step shown as task=/i);
    expect(prompt.indexOf("A-FIRST")).toBeLessThan(prompt.indexOf("B-SECOND"));
  });
});

describe("round-5 A-M7: real id-collision for steps.work.result", () => {
  test("root work result wins {{steps.work.result}} over child work with same id", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const childWf: WorkflowDef = {
      id: "t/am7-child", version: 1,
      steps: {
        work: { type: "agent", kind: "research", prompt: "CHILD-WORK" },
        orch: { type: "agent", role: "orchestrator", prompt: "see {{steps.work.result}}" },
        done: { type: "end" },
      },
      edges: [{ from: "work", to: "orch" }, { from: "orch", to: "done" }],
      entry: "work",
    };
    const rootWf: WorkflowDef = {
      id: "t/am7-root", version: 1,
      steps: {
        work: { type: "agent", kind: "research", prompt: "ROOT-WORK-INSTRUCTION" },
        pick: { type: "choose_workflow", from: ["t/am7-child"] },
        done: { type: "end" },
      },
      edges: [{ from: "work", to: "pick" }, { from: "pick", to: "done" }],
      entry: "work",
    };
    addDefinition(ctx, rootWf, "s");
    addDefinition(ctx, childWf, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/am7-root", repo: tmpDir(), brief: "B" }, spawn, deps);
    const rootWork = stepsOfRun(ctx, r.id).find(s => s.stepId === "work")!;
    updateStep(ctx, { runId: r.id, stepId: "work", attempt: 1 }, {
      status: "done", result: { text: "ROOT-WORK-INSTRUCTION" }, endedAt: NOW,
    });
    // Advance to choose by inserting waiting pick.
    insertStep(ctx, { runId: r.id, stepId: "pick", attempt: 1, status: "waiting" });
    updateRun(ctx, r.id, getRun(ctx, r.id)!.rev, { status: "waiting" });

    const child = await chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/am7-child", reason: "x",
    }, spawn, deps);
    // Finish child work so orch can reference steps.work.result from the CHILD run only.
    const childWork = stepsOfRun(ctx, child.id).find(s => s.stepId === "work");
    if (childWork?.taskId) {
      updateTask(ctx, childWork.taskId, t => { t.state = "done"; });
    }
    updateStep(ctx, { runId: child.id, stepId: "work", attempt: 1 }, {
      status: "done", result: { text: "CHILD-ONLY" }, endedAt: NOW,
    });
    insertStep(ctx, { runId: child.id, stepId: "orch", attempt: 1, status: "running" });

    const tree = stepsOfRootTree(ctx, r.id);
    const prompt = buildTurnPrompt(ctx, getRun(ctx, r.id)!, [], childWf, tree);
    // Child orch open block resolves {{steps.work.result}} from the owning child run.
    expect(prompt).toMatch(/## Orchestrator step[\s\S]*CHILD-ONLY/);
    // The substitution fence for the child orch must not carry the root work text.
    const orchMatch = /## Orchestrator step[^\n]*\n[\s\S]*?(?=\n## |\n--- data [a-f0-9]+ from the brief|\n…\[truncated|$)/.exec(prompt);
    expect(orchMatch?.[0] ?? "").toContain("CHILD-ONLY");
    expect(orchMatch?.[0] ?? "").not.toContain("ROOT-WORK-INSTRUCTION");

    const hand = buildHandoverPrompt(ctx, getRun(ctx, r.id)!, [], rootWf, tree);
    expect(hand).toMatch(/work#/);
    expect(hand).toContain(child.id);
  });
});

describe("round-5 N5-6: stepResultsMap attempt, unresolved attention, keep blockedBy", () => {
  test("highest attempt wins in stepResultsMap; unresolved attention returned; budget raise keeps unresolved", () => {
    const ctx = fakeCtx({ now: NOW });
    let run = insertRun(ctx, { workflow: "t/n56", version: 1, repo: tmpDir(), brief: "b" });
    insertStep(ctx, { runId: run.id, stepId: "work", attempt: 1, status: "done" });
    updateStep(ctx, { runId: run.id, stepId: "work", attempt: 1 }, { result: { v: "old" } });
    insertStep(ctx, { runId: run.id, stepId: "work", attempt: 2, status: "done" });
    updateStep(ctx, { runId: run.id, stepId: "work", attempt: 2 }, { result: { v: "new" } });
    insertStep(ctx, {
      runId: run.id, stepId: "orch", attempt: 1, status: "running",
    });
    const def: WorkflowDef = {
      id: "t/n56", version: 1,
      steps: {
        work: { type: "agent", kind: "research", prompt: "w" },
        orch: { type: "agent", role: "orchestrator", prompt: "got {{steps.work.result.v}}" },
        done: { type: "end" },
      },
      edges: [{ from: "work", to: "orch" }, { from: "orch", to: "done" }],
      entry: "work",
    };
    addDefinition(ctx, def, "s");
    const prompt = buildTurnPrompt(ctx, run, [], def, stepsOfRun(ctx, run.id));
    expect(prompt).toMatch(/## Orchestrator step[\s\S]*\bnew\b/);
    const orchMatch = /## Orchestrator step[^\n]*\n[\s\S]*?(?=\n## |\n--- data [a-f0-9]+ from the brief|\n…\[truncated|$)/.exec(prompt);
    expect(orchMatch?.[0] ?? "").toMatch(/\bnew\b/);
    expect(orchMatch?.[0] ?? "").not.toMatch(/\bold\b/);

    run = updateRun(ctx, run.id, run.rev, {
      orchestratorState: "blocked",
      reason: "unresolved wake step_failed:x after 2 done turns",
      spent: serializeSpent({
        orchestratorTurns: 1, messageTurns: 0,
        blockedBy: "unresolved",
        unresolvedWakes: { "step_failed:x": 2 },
      }),
    });
    stampAttentionAt(ctx, run.id, "unresolved_wake");
    const attn = getOrchestratorAttention(ctx, run.id);
    expect(attn?.id).toBe(`unresolved_wake:${run.id}`);

    const raised = applyBudgetRaise(ctx, run.id, getRun(ctx, run.id)!.rev, {
      orchestratorTurns: 100,
    });
    expect(parseSpent(raised.spent).blockedBy).toBe("unresolved");
  });
});

describe("round-5 grandchildren and error cap", () => {
  test("stepsOfRootTree includes grandchildren; error= is capped", async () => {
    const ctx = fakeCtx({ now: NOW });
    writePlanner(ctx);
    const grand: WorkflowDef = {
      id: "t/grand", version: 1,
      steps: { g: { type: "agent", kind: "research", prompt: "G" }, done: { type: "end" } },
      edges: [{ from: "g", to: "done" }], entry: "g",
    };
    const child: WorkflowDef = {
      id: "t/child", version: 1,
      steps: {
        pick: { type: "choose_workflow", from: ["t/grand"] },
        done: { type: "end" },
      },
      edges: [{ from: "pick", to: "done" }], entry: "pick",
    };
    const root: WorkflowDef = {
      id: "t/root", version: 1,
      steps: {
        pick: { type: "choose_workflow", from: ["t/child"] },
        done: { type: "end" },
      },
      edges: [{ from: "pick", to: "done" }], entry: "pick",
    };
    addDefinition(ctx, root, "s");
    addDefinition(ctx, child, "s");
    addDefinition(ctx, grand, "s");
    const { deps } = fakeDeps();
    const spawn: SpawnRunner = () => 1;
    const r = await startRun(ctx, { workflow: "t/root", repo: tmpDir(), brief: "B" }, spawn, deps);
    const c = await chooseWorkflow(ctx, {
      runId: r.id, stepId: "pick", workflow: "t/child", reason: "c",
    }, spawn, deps);
    const g = await chooseWorkflow(ctx, {
      runId: c.id, stepId: "pick", workflow: "t/grand", reason: "g",
    }, spawn, deps);
    const tree = stepsOfRootTree(ctx, r.id);
    expect(tree.some(s => s.runId === g.id)).toBe(true);

    insertStep(ctx, { runId: r.id, stepId: "fail", attempt: 1, status: "failed" });
    updateStep(ctx, { runId: r.id, stepId: "fail", attempt: 1 }, {
      error: "E".repeat(500),
    });
    const prompt = buildTurnPrompt(ctx, getRun(ctx, r.id)!, [], root, stepsOfRootTree(ctx, r.id));
    expect(prompt).toContain("error=");
    expect(prompt).not.toContain("E".repeat(200));
    expect(prompt).toMatch(/error=E+…/);
  });
});
