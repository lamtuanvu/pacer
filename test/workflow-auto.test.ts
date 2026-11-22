// Phase 2 Task 7: auto mode and recorded decisions.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { callOp, type OpDeps } from "../src/api/ops";
import { CoreError } from "../src/core/errors";
import { createTask, readTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput, SpawnRunner } from "../src/tasks/api";
import { getRun, stepsOfRun, workflowDatabase, type RunRow } from "../src/workflow/store";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn, openWakeups } from "../src/workflow/wakeups";
import { advanceRuns } from "../src/workflow/tick";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import type { OrchestratorDeps } from "../src/workflow/orchestrator";

type DecisionRow = { run_id: string; step_id: string; actor: string; kind: string; choice: string; reason: string };

function listDecisions(ctx: Ctx, runId: string): DecisionRow[] {
  return workflowDatabase(ctx).query<DecisionRow, [string]>(
    "SELECT run_id, step_id, actor, kind, choice, reason FROM workflow_decisions WHERE run_id = ? ORDER BY at, id",
  ).all(runId);
}

const NOW = 1_700_000_000;

const AUTO_WF = `
id: t/auto
version: 1
title: Auto
steps:
  route: { type: human, decision: auto, question: { text: "Route?", kind: text } }
  approve: { type: human, decision: must, question: { text: "Approve?", kind: approve_revise } }
  done: { type: end }
edges:
  - [route, approve]
  - [approve, done]
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
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return { delegate };
}

const fail = async (p: Promise<unknown>): Promise<CoreError> => {
  try { await p; return null as unknown as CoreError; }
  catch (e) { return e as CoreError; }
};

function withGrant(ctx: Ctx, bearer: string): Ctx {
  return { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer, PACER_ROLE: undefined } };
}

async function startWaiting(ctx: Ctx): Promise<RunRow> {
  await callOp(ctx, "workflow.add", { source: AUTO_WF });
  return await callOp(ctx, "run.start", { workflow: "t/auto", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
}

function grantFor(ctx: Ctx, runId: string): string {
  insertTurn(ctx, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: ctx.now,
    deadline: ctx.now + 1200,
  });
  return issueRunGrant(ctx, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: ctx.now + 600 });
}

describe("auto mode and recorded decisions", () => {
  test("with auto off, run.decide is not_allowed", async () => {
    const ctx = fakeCtx({ now: NOW });
    const run = await startWaiting(ctx);
    expect(run.auto).toBeFalsy();
    expect(stepsOfRun(ctx, run.id)[0].stepId).toBe("route");
    const bearer = grantFor(ctx, run.id);
    const e = await fail(callOp(withGrant(ctx, bearer), "run.decide", {
      id: run.id, step: "route", choice: "left", reason: "default route",
    }));
    expect(e?.code).toBe("not_allowed");
  });

  test("with auto on, run.decide answers an auto step and records the decision", async () => {
    const ctx = fakeCtx({ now: NOW });
    const run = await startWaiting(ctx);
    const set = await callOp(ctx, "run.set_auto", { id: run.id, auto: true, expect_rev: run.rev }) as RunRow;
    expect(set.auto).toBe(true);
    const bearer = grantFor(ctx, set.id);
    const decided = await callOp(withGrant(ctx, bearer), "run.decide", {
      id: set.id, step: "route", choice: "left", reason: "prefer left",
    }) as RunRow;
    expect(stepsOfRun(ctx, decided.id).find(s => s.stepId === "route")!.result).toEqual({ answer: "left" });
    expect(decided.status).toBe("waiting");
    const decisions = listDecisions(ctx, set.id);
    expect(decisions).toEqual([expect.objectContaining({
      run_id: set.id,
      step_id: "route",
      actor: "orchestrator",
      kind: "decide",
      choice: "left",
      reason: "prefer left",
    })]);
  });

  test("run.decide never answers a must step; the refusal is recorded", async () => {
    const ctx = fakeCtx({ now: NOW });
    let run = await startWaiting(ctx);
    run = await callOp(ctx, "run.set_auto", { id: run.id, auto: true, expect_rev: run.rev }) as RunRow;
    const bearer = grantFor(ctx, run.id);
    // Answer the auto step first so the must step is waiting.
    run = await callOp(withGrant(ctx, bearer), "run.decide", {
      id: run.id, step: "route", choice: "left", reason: "go",
    }) as RunRow;
    expect(stepsOfRun(ctx, run.id).find(s => s.stepId === "approve")!.status).toBe("waiting");
    const e = await fail(callOp(withGrant(ctx, bearer), "run.decide", {
      id: run.id, step: "approve", choice: "approve", reason: "looks fine",
    }));
    expect(e?.code).toBe("not_allowed");
    const decisions = listDecisions(ctx, run.id);
    expect(decisions.some(d => d.step_id === "approve" && d.kind === "refused")).toBe(true);
    expect(stepsOfRun(ctx, run.id).find(s => s.stepId === "approve")!.status).toBe("waiting");
  });

  test("a strict override wins over decision: auto", async () => {
    const ctx = fakeCtx({ now: NOW });
    let run = await startWaiting(ctx);
    run = await callOp(ctx, "run.set_auto", {
      id: run.id, auto: true, expect_rev: run.rev, strict_steps: ["route"],
    }) as RunRow;
    const bearer = grantFor(ctx, run.id);
    const e = await fail(callOp(withGrant(ctx, bearer), "run.decide", {
      id: run.id, step: "route", choice: "left", reason: "should fail",
    }));
    expect(e?.code).toBe("not_allowed");
    // Person can still answer.
    const answered = await callOp(ctx, "run.answer", {
      id: run.id, step: "route", answer: "left", expect_rev: getRun(ctx, run.id)!.rev,
    }) as RunRow;
    expect(stepsOfRun(ctx, answered.id).find(s => s.stepId === "route")!.result).toEqual({ answer: "left" });
  });

  test("run.answer by the person always works, including with auto off", async () => {
    const ctx = fakeCtx({ now: NOW });
    const run = await startWaiting(ctx);
    expect(run.auto).toBeFalsy();
    const answered = await callOp(ctx, "run.answer", {
      id: run.id, step: "route", answer: "manual", expect_rev: run.rev,
    }) as RunRow;
    expect(stepsOfRun(ctx, answered.id).find(s => s.stepId === "route")!.result).toEqual({ answer: "manual" });
  });

  test("run.set_auto is person-only: executor and prg_ grant are refused", async () => {
    const ctx = fakeCtx({ now: NOW });
    const run = await startWaiting(ctx);
    const exec = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor" } };
    expect((await fail(callOp(exec, "run.set_auto", { id: run.id, auto: true, expect_rev: run.rev })))?.code).toBe("not_allowed");
    const bearer = grantFor(ctx, run.id);
    expect((await fail(callOp(withGrant(ctx, bearer), "run.set_auto", {
      id: run.id, auto: true, expect_rev: run.rev,
    })))?.code).toBe("not_allowed");
  });

  test("I2: run.decide on a choose_workflow child uses the root auto flag", async () => {
    const ctx = fakeCtx({ now: NOW });
    const childSrc = `
id: t/auto-child
version: 1
steps:
  ask: { type: human, decision: auto, question: { text: "Go?", kind: text } }
  done: { type: end }
edges:
  - [ask, done]
`;
    const parentSrc = `
id: t/auto-parent
version: 1
steps:
  pick: { type: choose_workflow, from: ["t/auto-child"] }
  done: { type: end }
edges:
  - [pick, done]
`;
    await callOp(ctx, "workflow.add", { source: childSrc });
    await callOp(ctx, "workflow.add", { source: parentSrc });
    const deps = stubDeps();
    let parent = await callOp(ctx, "run.start", {
      workflow: "t/auto-parent", repo: tmpDir(), brief: "P",
    }, deps) as RunRow;
    parent = await callOp(ctx, "run.set_auto", { id: parent.id, auto: true, expect_rev: parent.rev }) as RunRow;
    const bearer = grantFor(ctx, parent.id);
    // Choose the child under the root grant.
    const child = await callOp(withGrant(ctx, bearer), "run.choose", {
      id: parent.id, step: "pick", workflow: "t/auto-child", reason: "fit",
    }, deps) as RunRow;
    expect(child.parentRunId).toBe(parent.id);
    expect(child.auto).toBeFalsy(); // child row does not copy auto
    expect(getRun(ctx, parent.id)!.auto).toBe(true);
    expect(stepsOfRun(ctx, child.id).find(s => s.stepId === "ask")?.status).toBe("waiting");
    // Decide against the child id — must succeed via the root auto flag.
    const decided = await callOp(withGrant(ctx, bearer), "run.decide", {
      id: child.id, step: "ask", choice: "yes", reason: "root auto",
    }, deps) as RunRow;
    expect(stepsOfRun(ctx, decided.id).find(s => s.stepId === "ask")!.result).toEqual({ answer: "yes" });
  });

  test("auto human step wakes the orchestrator through the real tick (not run.decide)", async () => {
    const ctx = fakeCtx({ now: NOW });
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
    let run = await startWaiting(ctx);
    expect(openWakeups(ctx, run.id)).toHaveLength(0);
    run = await callOp(ctx, "run.set_auto", { id: run.id, auto: true, expect_rev: run.rev }) as RunRow;
    expect(run.auto).toBe(true);
    // No wake-up was written at insert (auto was off); the tick scan recreates it.
    const launches: string[] = [];
    const spawn: SpawnRunner = (_c, id) => { launches.push(id); return 1; };
    const orch: OrchestratorDeps = { spawn, plannerEligible: () => true };
    const ready = { ...ctx, now: NOW + COALESCE_WINDOW_S };
    await advanceRuns(ready, spawn, undefined, orch);
    const turns = workflowDatabase(ctx).query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM workflow_turns WHERE run_id = ?",
    ).all(run.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe("running");
    expect(openWakeups(ctx, run.id)).toHaveLength(0);
    expect(launches).toHaveLength(1);
    const claimed = workflowDatabase(ctx).query<{ cause: string; ref: string }, [string, string]>(
      "SELECT cause, ref FROM workflow_wakeups WHERE run_id = ? AND turn_id = ?",
    ).all(run.id, turns[0]!.id);
    expect(claimed).toEqual([{ cause: "question", ref: `${run.id}/route#1` }]);
  });

  test("with auto already on, entering a human step writes the question wake-up with the row", async () => {
    const ctx = fakeCtx({ now: NOW });
    const wf = `
id: t/auto-then
version: 1
title: Auto then
steps:
  draft: { type: agent, kind: research, prompt: "Draft" }
  route: { type: human, decision: auto, question: { text: "Route?", kind: text } }
  done: { type: end }
edges:
  - [draft, route]
  - [route, done]
`;
    await callOp(ctx, "workflow.add", { source: wf });
    const deps = stubDeps();
    let run = await callOp(ctx, "run.start", {
      workflow: "t/auto-then", repo: tmpDir(), brief: "Do X",
    }, deps) as RunRow;
    run = await callOp(ctx, "run.set_auto", { id: run.id, auto: true, expect_rev: run.rev }) as RunRow;
    const draft = stepsOfRun(ctx, run.id).find(s => s.stepId === "draft")!;
    const { onTaskSettled, recordStepResult } = await import("../src/workflow/engine");
    const { updateTask } = await import("../src/tasks/store");
    recordStepResult(ctx, draft.taskId!, { ok: true });
    updateTask(ctx, draft.taskId!, t => { t.state = "done"; });
    await onTaskSettled(ctx, draft.taskId!);
    const open = openWakeups(ctx, run.id);
    expect(open).toEqual([expect.objectContaining({ cause: "question", ref: `${run.id}/route#1` })]);
  });

  test("run.answer with a grant is not_allowed for must, strict and auto-off steps", async () => {
    // auto-off
    const ctxOff = fakeCtx({ now: NOW });
    const runOff = await startWaiting(ctxOff);
    const bearerOff = grantFor(ctxOff, runOff.id);
    expect((await fail(callOp(withGrant(ctxOff, bearerOff), "run.answer", {
      id: runOff.id, step: "route", answer: "left", expect_rev: runOff.rev,
    })))?.code).toBe("not_allowed");

    // must step with auto on (advance past the auto step first via run.decide)
    const ctxMust = fakeCtx({ now: NOW });
    let runMust = await startWaiting(ctxMust);
    runMust = await callOp(ctxMust, "run.set_auto", { id: runMust.id, auto: true, expect_rev: runMust.rev }) as RunRow;
    const bearerMust = grantFor(ctxMust, runMust.id);
    runMust = await callOp(withGrant(ctxMust, bearerMust), "run.decide", {
      id: runMust.id, step: "route", choice: "left", reason: "go",
    }) as RunRow;
    expect((await fail(callOp(withGrant(ctxMust, bearerMust), "run.answer", {
      id: runMust.id, step: "approve", answer: "approve", expect_rev: getRun(ctxMust, runMust.id)!.rev,
    })))?.code).toBe("not_allowed");

    // strict override
    const ctxStrict = fakeCtx({ now: NOW });
    let runStrict = await startWaiting(ctxStrict);
    runStrict = await callOp(ctxStrict, "run.set_auto", {
      id: runStrict.id, auto: true, expect_rev: runStrict.rev, strict_steps: ["route"],
    }) as RunRow;
    const bearerStrict = grantFor(ctxStrict, runStrict.id);
    expect((await fail(callOp(withGrant(ctxStrict, bearerStrict), "run.answer", {
      id: runStrict.id, step: "route", answer: "left", expect_rev: runStrict.rev,
    })))?.code).toBe("not_allowed");
  });
});
