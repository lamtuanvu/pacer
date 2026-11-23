import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { DelegateInput } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { CoreError } from "../src/core/errors";
import { callOp, type OpDeps } from "../src/api/ops";
import { addDefinition, getRun, stepsOfRun, type RunRow } from "../src/workflow/store";
import { onTaskSettled } from "../src/workflow/engine";
import type { WorkflowError } from "../src/workflow/schema";

/** The same delegation stub the engine tests use: createTask with the input's
 *  brief and a request-id dedupe, so run.start works without a strategy. */
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

const GOOD = `
id: t/demo
version: 1
title: Demo
steps:
  draft: { type: agent, kind: research, prompt: "Draft: {{brief}}" }
  approve: { type: human, question: { text: "Approve?", kind: approve_revise } }
  done: { type: end }
edges:
  - [draft, approve]
  - [approve, done, "result.answer == 'approve'"]
`;

const BAD = `
id: t/broken
version: 1
steps:
  start: { type: agent, kind: research, prompt: "Go" }
edges:
  - [start, nowhere]
`;

/** Resolves with the error a call threw, or null when it succeeded. */
const fail = async (p: Promise<unknown>): Promise<CoreError> => {
  try { await p; return null as unknown as CoreError; }
  catch (e) { return e as CoreError; }
};

const executorCtx = (ctx: Ctx, taskId?: string): Ctx =>
  ({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", ...(taskId ? { PACER_TASK_ID: taskId } : {}) } });

test("workflow.validate accepts a good file and reports every error of a bad one", async () => {
  const ctx = fakeCtx();
  expect(await callOp(ctx, "workflow.validate", { source: GOOD })).toEqual({ ok: true, errors: [] });
  const bad = await callOp(ctx, "workflow.validate", { source: BAD }) as { ok: boolean; errors: WorkflowError[] };
  expect(bad.ok).toBe(false);
  expect(bad.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "edges[0].to", message: "unknown step 'nowhere'" }),
    expect.objectContaining({ path: "steps", message: expect.stringContaining("no end step is reachable") }),
  ]));
});

test("workflow.add installs a version once and conflicts on a different source", async () => {
  const ctx = fakeCtx();
  expect(await callOp(ctx, "workflow.add", { source: GOOD })).toEqual({ id: "t/demo", version: 1, created: true });
  expect(await callOp(ctx, "workflow.add", { source: GOOD })).toEqual({ id: "t/demo", version: 1, created: false });
  const conflict = await fail(callOp(ctx, "workflow.add", { source: GOOD.replace("Demo", "Other") }));
  expect(conflict?.code).toBe("conflict");
  const invalid = await fail(callOp(ctx, "workflow.add", { source: BAD }));
  expect(invalid?.code).toBe("invalid_input");
  expect((invalid?.data as { errors: WorkflowError[] }).errors.length).toBeGreaterThan(0);
});

test("workflow.list returns installed definitions", async () => {
  const ctx = fakeCtx();
  expect(await callOp(ctx, "workflow.list", {})).toEqual([]);
  await callOp(ctx, "workflow.add", { source: GOOD });
  expect(await callOp(ctx, "workflow.list", {})).toEqual([{ id: "t/demo", version: 1, title: "Demo", addedAt: ctx.now }]);
});

test("run.start delegates the entry step, run.get and run.list read it back", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  expect(run.workflow).toBe("t/demo");
  expect(run.status).toBe("running");
  expect(run.rev).toBe(1);
  expect(stepsOfRun(ctx, run.id)[0].status).toBe("running");
  const got = await callOp(ctx, "run.get", { id: run.id }) as { run: RunRow; steps: unknown[] };
  expect(got.run.id).toBe(run.id);
  expect(got.steps).toHaveLength(1);
  expect(await callOp(ctx, "run.list", {})).toEqual([run]);
  expect(await callOp(ctx, "run.list", { status: "running" })).toEqual([run]);
  expect(await callOp(ctx, "run.list", { status: "waiting" })).toEqual([]);
});

test("run.start with an unknown workflow is not_found", async () => {
  const ctx = fakeCtx();
  const e = await fail(callOp(ctx, "run.start", { workflow: "t/none", repo: tmpDir(), brief: "Do X" }, stubDeps()));
  expect(e?.code).toBe("not_found");
});

test("run.start from an executor session is refused", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const e = await fail(callOp(executorCtx(ctx), "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()));
  expect(e?.code).toBe("not_allowed");
  expect(e?.message).toContain("step.result");
});

test("step.result records the calling executor's result; a second one conflicts", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const step = stepsOfRun(ctx, run.id)[0];
  const exec = executorCtx(ctx, step.taskId);
  const recorded = await callOp(exec, "step.result", { result: { ok: true } }) as { result: unknown };
  expect(recorded.result).toEqual({ ok: true });
  const again = await fail(callOp(exec, "step.result", { result: { ok: true } }));
  expect(again?.code).toBe("conflict");
});

test("step.result outside a delegated task is refused", async () => {
  const ctx = fakeCtx();
  const e = await fail(callOp(ctx, "step.result", { result: { ok: true } }));
  expect(e?.code).toBe("not_allowed");
  const noTask = await fail(callOp(executorCtx(ctx), "step.result", { result: { ok: true } }));
  expect(noTask?.code).toBe("not_allowed");
});

test("run.answer settles the waiting human step; a stale rev conflicts", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const step = stepsOfRun(ctx, run.id)[0];
  await callOp(executorCtx(ctx, step.taskId), "step.result", { result: { ok: true } });
  updateTask(ctx, step.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, step.taskId!);
  const waiting = getRun(ctx, run.id)!;
  expect(waiting.status).toBe("waiting");

  const stale = await fail(callOp(ctx, "run.answer", { id: run.id, step: "approve", answer: "approve", expect_rev: waiting.rev - 1 }));
  expect(stale?.code).toBe("conflict");
  const answered = await callOp(ctx, "run.answer", { id: run.id, step: "approve", answer: "approve", expect_rev: waiting.rev }) as RunRow;
  expect(answered.status).toBe("done");
  expect(stepsOfRun(ctx, run.id).find(s => s.stepId === "approve")!.result).toEqual({ answer: "approve" });
});

test("run.stop stops running step tasks and marks the run stopped", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const step = stepsOfRun(ctx, run.id)[0];
  const stopped = await callOp(ctx, "run.stop", { id: run.id, expect_rev: run.rev }) as RunRow;
  expect(stopped.status).toBe("stopped");
  expect(readTask(ctx, step.taskId!)!.state).toBe("stopped");
  const stale = await fail(callOp(ctx, "run.stop", { id: run.id, expect_rev: run.rev }));
  expect(stale?.code).toBe("conflict");
});

test("every run change publishes a run entity event", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const step = stepsOfRun(ctx, run.id)[0];
  updateTask(ctx, step.taskId!, t => { t.state = "stopped"; });
  await onTaskSettled(ctx, step.taskId!);
  // Phase 2: a failed step wakes the orchestrator; the run waits (does not fail yet).
  const waiting = getRun(ctx, run.id)!;
  expect(waiting.status).toBe("waiting");
  const readRuns = async (id: string) => {
    const outbox = (await import("../src/link/store")).readOutboxSince(ctx, 0);
    return outbox.filter(e => e.envelope.type === "entity" && (e.envelope.data as { kind: string }).kind === "run" && (e.envelope.data as { id: string }).id === id);
  };
  const runs = await readRuns(run.id);
  expect(runs.length).toBeGreaterThanOrEqual(2);
  const started = JSON.parse(JSON.stringify((runs[0]!.envelope.data as { value: RunRow }).value));
  expect(started.status).toBe("running");
  expect(started.orchestrator).toBeDefined();
  const latest = JSON.parse(JSON.stringify((runs[runs.length - 1]!.envelope.data as { value: RunRow }).value));
  expect(latest.status).toBe("waiting");
  // A second run publishes its stop through the engine as well.
  const run2 = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  await callOp(ctx, "run.stop", { id: run2.id, expect_rev: run2.rev });
  const stopped = await readRuns(run2.id);
  expect(stopped.length).toBeGreaterThanOrEqual(2);
  expect((JSON.parse(JSON.stringify((stopped[stopped.length - 1]!.envelope.data as { value: RunRow }).value)) as RunRow).status).toBe("stopped");
});

test("addDefinition through the ops keeps the store's conflict rules", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  expect(addDefinition(ctx, JSON.parse(JSON.stringify({
    id: "t/demo", version: 1,
    steps: { draft: { type: "agent", kind: "research", prompt: "Draft: {{brief}}" }, approve: { type: "human", question: { text: "Approve?", kind: "approve_revise" } }, done: { type: "end" } },
    edges: [{ from: "draft", to: "approve" }, { from: "approve", to: "done", when: "result.answer == 'approve'" }],
    entry: "draft", title: "Demo",
  })), GOOD)).toEqual({ id: "t/demo", version: 1, created: false });
});

const BAD_SHAPE = `
id: t/badshape
version: 1
entry: missing
steps:
  launch: { type: agent, kind: research, prompt: "Go" }
  split:
    type: fanout
    branches: [alpha, alpha]
    each: { type: agent, kind: research, prompt: "p" }
    join: { quorum: 3 }
  orphan: { type: agent, kind: research, prompt: "p" }
  done: { type: end }
edges:
  - [launch, split]
  - [split, done]
`;

const TOO_LONG = `id: t/long
version: 1
steps:
  ${"x".repeat(53)}: { type: agent, kind: research, prompt: "Go" }
  done: { type: end }
edges:
  - [${"x".repeat(53)}, done]
`;

test("validate reports entry, fanout, branch and edge shape errors once each", async () => {
  const ctx = fakeCtx();
  const bad = await callOp(ctx, "workflow.validate", { source: BAD_SHAPE }) as { ok: boolean; errors: WorkflowError[] };
  expect(bad.ok).toBe(false);
  const asText = bad.errors.map(e => `${e.path}: ${e.message}`);
  expect(asText).toContain("entry: unknown step 'missing'");
  expect(asText).toContain("steps.split.branches[1]: duplicate branch name 'alpha'");
  expect(asText).toContain("steps.split.join: join quorum 3 is greater than the branch count 2");
  expect(asText).toContain("steps.orphan: step orphan has no outgoing edge");
  for (const line of asText) expect(asText.filter(l => l === line)).toHaveLength(1); // each error exactly once
});

test("validate rejects step ids and branch names longer than 48 characters", async () => {
  const ctx = fakeCtx();
  const bad = await callOp(ctx, "workflow.validate", { source: TOO_LONG }) as { ok: boolean; errors: WorkflowError[] };
  expect(bad.ok).toBe(false);
  expect(bad.errors.some(e => e.path === `steps.${"x".repeat(53)}` && /longer than 48/.test(e.message))).toBe(true);
  const longBranch = `
id: t/longbranch
version: 1
steps:
  split:
    type: fanout
    branches: [${"y".repeat(49)}, ok]
    each: { type: agent, kind: research, prompt: "p" }
    join: all
  done: { type: end }
edges:
  - [split, done]
`;
  const branchBad = await callOp(ctx, "workflow.validate", { source: longBranch }) as { ok: boolean; errors: WorkflowError[] };
  expect(branchBad.ok).toBe(false);
  expect(branchBad.errors.some(e => e.path === "steps.split.branches[0]" && /longer than 48/.test(e.message))).toBe(true);
});

test("a duplicate step id in YAML is one error and an invalid add leaves workflow.list empty", async () => {
  const ctx = fakeCtx();
  const dup = `
id: t/dup
version: 1
steps:
  same: { type: agent, kind: research, prompt: "a" }
  same: { type: end }
edges: []
`;
  const bad = await callOp(ctx, "workflow.validate", { source: dup }) as { ok: boolean; errors: WorkflowError[] };
  expect(bad.ok).toBe(false);
  expect(bad.errors.length).toBe(1);
  const refused = await fail(callOp(ctx, "workflow.add", { source: dup }));
  expect(refused?.code).toBe("invalid_input");
  expect(await callOp(ctx, "workflow.list", {})).toEqual([]);
});

test("run.set_auto, set_budget and set_planner round-trip; executor refused", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  let run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  run = await callOp(ctx, "run.set_auto", { id: run.id, auto: true, expect_rev: run.rev }) as RunRow;
  expect(run.auto).toBe(true);
  run = await callOp(ctx, "run.set_budget", { id: run.id, orchestrator_turns: 40, message_turns: 10, expect_rev: run.rev }) as RunRow;
  expect(run.budget).toContain("40");
  run = await callOp(ctx, "run.set_planner", { id: run.id, planner: "codex", expect_rev: run.rev }) as RunRow;
  expect(run.pendingPlanner).toBe("codex");
  // Switch takes effect at the next turn only: current planner may still be the old one.
  const got = await callOp(ctx, "run.get", { id: run.id }) as { run: RunRow & { orchestrator?: { state?: string; planner?: string } } };
  expect(got.run.orchestrator).toMatchObject({ state: expect.any(String) });
  expect((await fail(callOp(executorCtx(ctx), "run.set_planner", {
    id: run.id, planner: "cursor", expect_rev: got.run.rev,
  })))?.code).toBe("not_allowed");
  expect((await fail(callOp(executorCtx(ctx), "run.set_budget", {
    id: run.id, orchestrator_turns: 99, expect_rev: got.run.rev,
  })))?.code).toBe("not_allowed");
});

test("run.set_planner rejects unknown planners", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const e = await fail(callOp(ctx, "run.set_planner", { id: run.id, planner: "not-a-planner", expect_rev: run.rev }));
  expect(e?.code).toBe("invalid_input");
});

test("run.retry_orchestrator clears a failure block and is person-only", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  let run = await callOp(ctx, "run.start", { workflow: "t/demo", repo: tmpDir(), brief: "Do X" }, stubDeps()) as RunRow;
  const { updateRun, workflowDatabase } = await import("../src/workflow/store");
  const { insertTurn } = await import("../src/workflow/wakeups");
  insertTurn(ctx, {
    id: "turn_fail3",
    runId: run.id,
    planner: "claude-code",
    status: "failed",
    startedAt: 1,
    deadline: 2,
    failures: 3,
  });
  workflowDatabase(ctx).query(
    "UPDATE workflow_turns SET ended_at = ? WHERE id = ?",
  ).run(2, "turn_fail3");
  run = updateRun(ctx, run.id, run.rev, {
    orchestratorState: "blocked", reason: "orchestrator failed 3 times",
  });
  run = await callOp(ctx, "run.retry_orchestrator", { id: run.id, expect_rev: run.rev }) as RunRow;
  expect(run.orchestratorState).toBe("idle");
  const failures = workflowDatabase(ctx).query<{ failures: number }, [string]>(
    "SELECT failures FROM workflow_turns WHERE id = ?",
  ).get("turn_fail3")!.failures;
  expect(failures).toBe(0);
  expect((await fail(callOp(executorCtx(ctx), "run.retry_orchestrator", {
    id: run.id, expect_rev: run.rev,
  })))?.code).toBe("not_allowed");
  // Orchestrator role is also refused for person-only ops.
  expect((await fail(callOp(
    { ...ctx, env: { ...ctx.env, PACER_ROLE: "orchestrator" } },
    "run.retry_orchestrator",
    { id: run.id, expect_rev: run.rev },
  )))?.code).toBe("not_allowed");
});

test("run.sync_base / publish / cleanup ops and grant scoping", async () => {
  const ctx = fakeCtx();
  await callOp(ctx, "workflow.add", { source: GOOD });
  const run = await callOp(ctx, "run.start", {
    workflow: "t/demo", repo: tmpDir(), brief: "Do X", publish: "draft",
  }, stubDeps()) as RunRow;
  expect(run.publishOptIn ?? (await callOp(ctx, "run.get", { id: run.id }) as { run: RunRow }).run.publishOptIn).toBe("draft");

  // No branch yet → sync_base invalid_input (research step does not create a branch).
  const sync = await fail(callOp(ctx, "run.sync_base", { id: run.id, expect_rev: run.rev }));
  expect(["invalid_input", "not_found"]).toContain(sync?.code);

  const { issueRunGrant } = await import("../src/workflow/run-grant");
  const { insertTurn } = await import("../src/workflow/wakeups");
  insertTurn(ctx, {
    id: "turn_p5ops", runId: run.id, planner: "claude-code",
    status: "running", startedAt: ctx.now, deadline: ctx.now + 600,
  });
  const bearer = issueRunGrant(ctx, { runId: run.id, turnId: "turn_p5ops", deadline: ctx.now + 600 });
  const granted = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer, PACER_ROLE: "orchestrator" } };

  // Person-only cleanup refused under grant (assertPersonCaller / assertCallerCanInvoke).
  const cleanup = await fail(callOp(granted, "run.cleanup", {
    id: run.id, delete_branch: false, expect_rev: run.rev,
  }));
  expect(cleanup?.code).toBe("not_allowed");

  // Wrong run id under grant → unknown run (same text as unknown id).
  const other = await callOp(ctx, "run.start", {
    workflow: "t/demo", repo: tmpDir(), brief: "Other",
  }, stubDeps()) as RunRow;
  const wrong = await fail(callOp(granted, "run.sync_base", { id: other.id, expect_rev: other.rev }));
  expect(wrong?.code).toBe("not_allowed");
  expect(wrong?.message).toMatch(/unknown run|outside this run grant|not allowed by this run grant/i);

  // Executor cannot publish.
  expect((await fail(callOp(executorCtx(ctx), "run.publish", {
    id: run.id, draft: true, title: "t", body: "b", expect_rev: run.rev,
  })))?.code).toBe("not_allowed");
});
