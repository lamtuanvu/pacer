// A blocking question holds its orchestrator step and the answer resumes it; a
// person can retry or skip a failed step; a plan approval is a visible question;
// a resolved decision unblocks the planner. Real engine, tick and ops; only task
// delegation and process launch are faked.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { callOp } from "../src/api/ops";
import { runCmd, stepCmd } from "../src/commands/run";
import type { DelegateInput, SpawnRunner } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskState } from "../src/tasks/types";
import {
  addDefinition, getRun, listQuestions, setRunBranch, stepsOfRun, updateRun, updateStep, workflowDatabase,
} from "../src/workflow/store";
import { chooseWorkflow, recordStepResult, startRun, type EngineDeps } from "../src/workflow/engine";
import { submitGraph } from "../src/workflow/generate";
import { advanceRuns } from "../src/workflow/tick";
import { askQuestion } from "../src/workflow/questions";
import { issueRunGrant } from "../src/workflow/run-grant";
import { liveTurn, openWakeups } from "../src/workflow/wakeups";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import type { WorkflowDef } from "../src/workflow/schema";

function world() {
  const ctx = fakeCtx({ now: 1_700_000_000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  workflowDatabase(ctx);
  const byRequest = new Map<string, string>();
  const delegate: EngineDeps["delegate"] = async (c, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(c, prior)!;
    const task = createTask(c, {
      brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.requestId) byRequest.set(input.requestId, task.id);
    return task;
  };
  const deps: EngineDeps = { delegate, stopTask: (c, id) => { updateTask(c, id, t => { t.state = "stopped"; }); } };
  const spawn: SpawnRunner = () => 4242;
  const repo = tmpDir();
  const tick = async (seconds = 31) => {
    ctx.now += seconds;
    await advanceRuns(ctx, spawn, deps, { skipDefaultPacing: true, pacingMode: "normal" });
  };
  const install = (def: WorkflowDef) => { addDefinition(ctx, def, `id: ${def.id}\n`); return def; };
  const start = async (def: WorkflowDef) => startRun(ctx, { workflow: def.id, repo, brief: "B" }, spawn, deps);
  const rows = (runId: string, stepId: string) => stepsOfRun(ctx, runId).filter(s => s.stepId === stepId);
  const row = (runId: string, stepId: string) => rows(runId, stepId).sort((a, b) => b.attempt - a.attempt)[0]!;
  const finish = (taskId: string, state: TaskState = "done") => updateTask(ctx, taskId, t => {
    t.state = state;
    t.result = { status: state as "done", executor: "claude-code", model: null, files: "", report: "", backend: "direct" };
  });
  /** The run's live orchestrator turn, started by the tick. */
  const turn = async (runId: string) => {
    if (!liveTurn(ctx, runId)) await tick();
    const live = liveTurn(ctx, runId);
    if (!live) throw new Error(`no live turn: ${JSON.stringify(getRun(ctx, runId))}`);
    return live;
  };
  const grantCtx = (runId: string): Ctx => {
    const live = liveTurn(ctx, runId)!;
    const bearer = issueRunGrant(ctx, { runId, turnId: live.id, deadline: live.deadline });
    return { ...ctx, env: { ...ctx.env, PACER_ROLE: "orchestrator", PACER_RUN_GRANT: bearer, PACER_TASK_ID: live.taskId! } };
  };
  const person = (name: string, params: Record<string, unknown>) =>
    callOp(ctx, name, params, { spawnRunner: spawn, delegate });
  const agent = (c: Ctx, name: string, params: Record<string, unknown>) =>
    callOp(c, name, params, { spawnRunner: spawn, delegate });
  return { ctx, deps, spawn, repo, tick, install, start, rows, row, finish, turn, grantCtx, person, agent };
}

type World = ReturnType<typeof world>;

const brainstorm: WorkflowDef = {
  id: "t/ask-orch", version: 1, entry: "brainstorm",
  steps: {
    brainstorm: { type: "agent", role: "orchestrator", prompt: "Brainstorm {{brief}}" },
    done: { type: "end" },
  },
  edges: [{ from: "brainstorm", to: "done" }],
};

const question = { text: "Which database?", answerType: "single" as const, options: [{ value: "sqlite" }, { value: "postgres" }], blocks: "step" as const };

/** Starts the run, then has its first turn ask a question. */
async function asked(w: World, blocks: "step" | "branch" | "nothing" = "step") {
  w.install(brainstorm);
  const run = await w.start(brainstorm);
  const first = await w.turn(run.id);
  const q = await askQuestion(w.grantCtx(run.id), { ...question, blocks, stepId: "brainstorm" });
  return { run, first, q };
}

test("a blocking orchestrator question holds the step when the turn ends", async () => {
  for (const blocks of ["step", "branch"] as const) {
    const w = world();
    const { run, first } = await asked(w, blocks);
    w.finish(first.taskId!);
    await w.tick();
    expect(w.row(run.id, "brainstorm").status).toBe("waiting");
    expect(w.row(run.id, "brainstorm").error).toBeUndefined();
    // Nothing owes a turn: no retry, no failure wake, and the planner is not blocked.
    await w.tick();
    await w.tick();
    expect(liveTurn(w.ctx, run.id)).toBeNull();
    expect(openWakeups(w.ctx, run.id)).toEqual([]);
    expect(getRun(w.ctx, run.id)!.orchestratorState).toBe("idle");
    expect(getRun(w.ctx, run.id)!.status).toBe("waiting");
    expect(deriveWorkflowAttention(w.ctx).map(i => i.kind)).toEqual(["question"]);
  }
});

test("the answer resumes the held step in a new turn that carries it as data", async () => {
  const w = world();
  const { run, first, q } = await asked(w);
  w.finish(first.taskId!);
  await w.tick();
  await w.person("question.answer", { id: q.id, answer: "sqlite", expect_rev: q.rev });
  expect(w.row(run.id, "brainstorm").status).toBe("running");
  const second = await w.turn(run.id);
  expect(second.id).not.toBe(first.id);
  const prompt = readTask(w.ctx, second.taskId!)!.brief.goal;
  expect(prompt).toContain("Orchestrator step");
  expect(prompt).toMatch(/--- data \w+ answers .*brainstorm#1 ---\n[\s\S]*sqlite/);
  recordStepResult(w.ctx, second.taskId!, { ok: true });
  w.finish(second.taskId!);
  await w.tick();
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
});

test("an answer given before the asking turn settles still resumes the step", async () => {
  const w = world();
  const { run, first, q } = await asked(w);
  await w.person("question.answer", { id: q.id, answer: "sqlite", expect_rev: q.rev });
  w.finish(first.taskId!);
  await w.tick();
  expect(w.row(run.id, "brainstorm").status).toBe("running");
  const second = await w.turn(run.id);
  expect(second.id).not.toBe(first.id);
  recordStepResult(w.ctx, second.taskId!, { ok: true });
  w.finish(second.taskId!);
  await w.tick();
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
});

test("a turn that asks twice in a row is held each time and never blocks the planner", async () => {
  const w = world();
  const { run, first, q } = await asked(w);
  w.finish(first.taskId!);
  await w.tick();
  await w.person("question.answer", { id: q.id, answer: "sqlite", expect_rev: q.rev });
  const second = await w.turn(run.id);
  await askQuestion(w.grantCtx(run.id), { ...question, text: "Which cache?", stepId: "brainstorm" });
  w.finish(second.taskId!);
  await w.tick();
  expect(w.row(run.id, "brainstorm").status).toBe("waiting");
  expect(getRun(w.ctx, run.id)!.orchestratorState).toBe("idle");
});

test("a turn that gets its answer and still reports nothing fails the step", async () => {
  const w = world();
  const { run, first, q } = await asked(w);
  w.finish(first.taskId!);
  await w.tick();
  await w.person("question.answer", { id: q.id, answer: "sqlite", expect_rev: q.rev });
  const second = await w.turn(run.id);
  w.finish(second.taskId!);
  await w.tick();
  expect(w.row(run.id, "brainstorm")).toMatchObject({ status: "failed", error: "no step result" });
});

test("a question that blocks nothing does not hold the step", async () => {
  const w = world();
  const { run, first } = await asked(w, "nothing");
  w.finish(first.taskId!);
  await w.tick();
  expect(w.row(run.id, "brainstorm")).toMatchObject({ status: "failed", error: "no step result" });
});

test("the tick resumes a held step whose answer or withdrawal landed without a resume", async () => {
  for (const status of ["answered", "withdrawn"] as const) {
    const w = world();
    const { run, first, q } = await asked(w);
    w.finish(first.taskId!);
    await w.tick();
    // As after a restart between the record and the resume: only the row changed.
    workflowDatabase(w.ctx).query("UPDATE workflow_questions SET status = ?, answer = ?, rev = rev + 1 WHERE id = ?")
      .run(status, status === "answered" ? "sqlite" : null, q.id);
    await w.tick();
    expect(w.row(run.id, "brainstorm").status).toBe("running");
    const second = await w.turn(run.id);
    recordStepResult(w.ctx, second.taskId!, { ok: true });
    w.finish(second.taskId!);
    await w.tick();
    expect(getRun(w.ctx, run.id)!.status).toBe("done");
  }
});

test("a question without --attempt binds to the step's current attempt", async () => {
  const w = world();
  w.install(brainstorm);
  const run = await w.start(brainstorm);
  const first = await w.turn(run.id);
  w.finish(first.taskId!);
  await w.tick();
  const live = getRun(w.ctx, run.id)!;
  await w.person("step.retry", { id: run.id, step: "brainstorm", expect_rev: live.rev });
  const second = await w.turn(run.id);
  const q = await askQuestion(w.grantCtx(run.id), { ...question, stepId: "brainstorm" });
  expect(q.attempt).toBe(2);
  w.finish(second.taskId!);
  await w.tick();
  expect(w.row(run.id, "brainstorm")).toMatchObject({ attempt: 2, status: "waiting" });
});

test("a choose_workflow step that asked is not retried until the answer arrives", async () => {
  const w = world();
  w.install(brainstorm);
  const router = w.install({
    id: "t/router", version: 1, entry: "pick",
    steps: { pick: { type: "choose_workflow", from: ["t/ask-orch"] }, done: { type: "end" } },
    edges: [{ from: "pick", to: "done" }],
  });
  const run = await w.start(router);
  const first = await w.turn(run.id);
  const q = await askQuestion(w.grantCtx(run.id), { ...question, stepId: "pick" });
  w.finish(first.taskId!);
  await w.tick();
  await w.tick();
  expect(liveTurn(w.ctx, run.id)).toBeNull();
  expect(getRun(w.ctx, run.id)!.orchestratorState).toBe("idle");
  await w.person("question.answer", { id: q.id, answer: "sqlite", expect_rev: q.rev });
  const second = await w.turn(run.id);
  expect(readTask(w.ctx, second.taskId!)!.brief.goal).toContain("## choose_workflow");
  await chooseWorkflow(w.ctx, { runId: run.id, stepId: "pick", workflow: "t/ask-orch", reason: "r" }, w.spawn, w.deps);
});

test("an executor that asked keeps its step running while its task needs input", async () => {
  const w = world();
  const def = w.install({
    id: "t/ask-exec", version: 1, entry: "work",
    steps: { work: { type: "agent", kind: "research", prompt: "W" }, done: { type: "end" } },
    edges: [{ from: "work", to: "done" }],
  });
  const run = await w.start(def);
  const taskId = w.row(run.id, "work").taskId!;
  updateTask(w.ctx, taskId, t => { t.state = "running"; });
  await askQuestion({ ...w.ctx, env: { ...w.ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: taskId } }, question);
  updateTask(w.ctx, taskId, t => { t.state = "needs_input"; });
  await w.tick();
  expect(w.row(run.id, "work").status).toBe("running");
});

const plain: WorkflowDef = {
  id: "t/plain", version: 1, entry: "work",
  steps: { work: { type: "agent", kind: "research", prompt: "W" }, done: { type: "end" } },
  edges: [{ from: "work", to: "done" }],
};

async function failedStep(w: World) {
  w.install(plain);
  const run = await w.start(plain);
  w.finish(w.row(run.id, "work").taskId!, "failed");
  await w.tick(1);
  expect(w.row(run.id, "work").status).toBe("failed");
  return getRun(w.ctx, run.id)!;
}

test("a person retries a failed step with the run's rev", async () => {
  const w = world();
  const run = await failedStep(w);
  await expect(w.person("step.retry", { id: run.id, step: "work" })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(w.person("step.retry", { id: run.id, step: "work", expect_rev: run.rev - 1 })).rejects.toMatchObject({ code: "conflict" });
  expect(w.rows(run.id, "work")).toHaveLength(1);
  await w.person("step.retry", { id: run.id, step: "work", expect_rev: run.rev });
  expect(w.row(run.id, "work")).toMatchObject({ attempt: 2, status: "running" });
  expect(workflowDatabase(w.ctx).query("SELECT actor, kind FROM workflow_decisions WHERE run_id = ?").all(run.id))
    .toEqual([{ actor: "person", kind: "retry" }]);
});

test("two people retrying with one rev start one new attempt", async () => {
  const w = world();
  const run = await failedStep(w);
  const both = await Promise.allSettled([1, 2].map(() =>
    w.person("step.retry", { id: run.id, step: "work", expect_rev: run.rev })));
  expect(both.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(w.rows(run.id, "work")).toHaveLength(2);
});

test("a person skips a failed step and the run advances", async () => {
  const w = world();
  const run = await failedStep(w);
  await w.person("step.skip", { id: run.id, step: "work", expect_rev: run.rev });
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
});

test("executors, scoped grants and a foreign run grant cannot retry or skip", async () => {
  const w = world();
  const run = await failedStep(w);
  const taskId = w.row(run.id, "work").taskId!;
  w.install(brainstorm);
  const other = await w.start(brainstorm);
  await w.turn(other.id);
  const foreign = w.grantCtx(other.id);
  const callers: Ctx[] = [
    { ...w.ctx, env: { ...w.ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: taskId } },
    { ...w.ctx, env: { ...w.ctx.env, PACER_TASK_ID: taskId, PACER_ROLE: "executor", PACER_WORK_GRANT: `pwg_${"0".repeat(64)}` } },
    { ...w.ctx, env: { ...w.ctx.env, PACER_ASSISTANT_GRANT: `pag_${"0".repeat(64)}` } },
    { ...w.ctx, env: { ...w.ctx.env, PACER_ROLE: "orchestrator" } },
    { ...w.ctx, env: { ...w.ctx.env, PACER_ROLE: "orchestrator", PACER_RUN_GRANT: `prg_${"0".repeat(64)}` } },
    foreign,
  ];
  for (const caller of callers) {
    for (const name of ["step.retry", "step.skip"]) {
      await expect(w.agent(caller, name, { id: run.id, step: "work", expect_rev: getRun(w.ctx, run.id)!.rev }))
        .rejects.toMatchObject({ code: "not_allowed" });
    }
  }
  expect(w.rows(run.id, "work")).toHaveLength(1);
});

test("a person retries a rejected fan-out branch without restarting the others", async () => {
  const w = world();
  const def = w.install({
    id: "t/fan", version: 1, entry: "review",
    steps: {
      review: { type: "fanout", branches: ["a", "b"], each: { type: "agent", kind: "research", prompt: "R" }, join: "all" },
      done: { type: "end" },
    },
    edges: [{ from: "review", to: "done" }],
  });
  const run = await w.start(def);
  const branch = (name: string) => w.rows(run.id, "review").filter(s => s.branch === name).sort((x, y) => y.attempt - x.attempt)[0]!;
  const a = branch("a");
  updateStep(w.ctx, { runId: run.id, stepId: "review", attempt: a.attempt, branch: "a" }, { status: "failed", error: "review rejected" });
  const live = getRun(w.ctx, run.id)!;
  const out = await stepCmd(["retry", run.id, "review"], w.ctx, { spawnRunner: w.spawn, delegate: w.deps.delegate });
  expect(out).toMatchObject({ code: 0 });
  expect(branch("a")).toMatchObject({ attempt: a.attempt + 1, status: "running" });
  expect(w.rows(run.id, "review").filter(s => s.branch === "b")).toHaveLength(1);
  expect(getRun(w.ctx, run.id)!.rev).toBeGreaterThan(live.rev);
});

const planned: WorkflowDef = {
  id: "t/planned", version: 1, entry: "plan",
  steps: {
    plan: { type: "generate", prompt: "P", approval: "auto", limits: { step_types: ["agent"], max_steps: 4 } },
    done: { type: "end" },
  },
  edges: [{ from: "plan", to: "done" }],
};

const graph: WorkflowDef = {
  id: "g/one", version: 1, entry: "build",
  steps: { build: { type: "agent", kind: "research", prompt: "Build" }, end: { type: "end" } },
  edges: [{ from: "build", to: "end" }],
};

async function submitted(w: World, o: { auto?: boolean } = {}) {
  w.install(planned);
  let run = await w.start(planned);
  if (o.auto) run = updateRun(w.ctx, run.id, getRun(w.ctx, run.id)!.rev, { auto: true });
  const first = await w.turn(run.id);
  const out = await submitGraph(w.ctx, { runId: run.id, stepId: "plan", source: graph }, w.deps, w.spawn);
  expect(out.ok).toBe(true);
  w.finish(first.taskId!);
  await w.tick();
  return run;
}
const openQs = (w: World, runId: string) => listQuestions(w.ctx, runId, "open");
const children = (w: World, runId: string) =>
  workflowDatabase(w.ctx).query<{ id: string }, [string]>("SELECT id FROM workflow_runs WHERE parent_run_id = ?").all(runId);

test("approval: auto with auto mode off asks the person, visibly", async () => {
  const w = world();
  const run = await submitted(w);
  const [q] = openQs(w, run.id);
  expect(q).toMatchObject({ stepId: "plan", answerType: "approve_revise", answerer: "person", blocks: "step", status: "open" });
  expect(q!.text).toContain("build");
  expect(openQs(w, run.id)).toHaveLength(1);
  expect(await w.person("question.list", {})).toMatchObject([{ id: q!.id }]);
  expect(deriveWorkflowAttention(w.ctx).map(i => i.id)).toEqual([`question:${q!.id}`]);
  const shown = await runCmd(["show", run.id], w.ctx, { spawnRunner: w.spawn });
  expect(shown.out).toContain(q!.id);
  expect(shown.out).toContain(`pacer answer ${q!.id}`);
});

test("answering the plan question starts the child run once", async () => {
  const w = world();
  const run = await submitted(w);
  const [q] = openQs(w, run.id);
  await w.person("question.answer", { id: q!.id, answer: "approve", expect_rev: q!.rev });
  expect(children(w, run.id)).toHaveLength(1);
  expect(openQs(w, run.id)).toEqual([]);
  await expect(w.person("run.answer", { id: run.id, step: "plan", answer: "approve", expect_rev: getRun(w.ctx, run.id)!.rev }))
    .rejects.toMatchObject({ code: "conflict" });
  expect(children(w, run.id)).toHaveLength(1);
});

test("run.answer resolves the plan question", async () => {
  const w = world();
  const run = await submitted(w);
  const [q] = openQs(w, run.id);
  await w.person("run.answer", { id: run.id, step: "plan", answer: "approve", expect_rev: getRun(w.ctx, run.id)!.rev });
  expect(openQs(w, run.id)).toEqual([]);
  expect(listQuestions(w.ctx, run.id, "answered").map(x => x.id)).toEqual([q!.id]);
});

test("revise sends the note back and the next graph raises a new question", async () => {
  const w = world();
  const run = await submitted(w);
  const [q] = openQs(w, run.id);
  await w.person("question.answer", { id: q!.id, answer: "revise", note: "add tests", expect_rev: q!.rev });
  expect(openQs(w, run.id)).toEqual([]);
  expect(w.row(run.id, "plan").result).toMatchObject({ reviseNote: "add tests" });
  await w.turn(run.id);
  await submitGraph(w.ctx, { runId: run.id, stepId: "plan", source: graph }, w.deps, w.spawn);
  expect(openQs(w, run.id)).toHaveLength(1);
  expect(openQs(w, run.id)[0]!.id).not.toBe(q!.id);
});

test("with auto mode on the planner is asked, sees the plan and may approve", async () => {
  const w = world();
  const run = await submitted(w, { auto: true });
  const [q] = openQs(w, run.id);
  expect(q!.answerer).toBe("orchestrator");
  expect(deriveWorkflowAttention(w.ctx)).toEqual([]);
  const second = await w.turn(run.id);
  expect(readTask(w.ctx, second.taskId!)!.brief.goal).toContain(q!.id);
  await w.agent(w.grantCtx(run.id), "question.answer", { id: q!.id, answer: "approve", expect_rev: q!.rev });
  expect(children(w, run.id)).toHaveLength(1);
  expect(openQs(w, run.id)).toEqual([]);
});

test("run.decide approves the plan and resolves the question", async () => {
  const w = world();
  const run = await submitted(w, { auto: true });
  await w.turn(run.id);
  await w.agent(w.grantCtx(run.id), "run.decide", { id: run.id, step: "plan", choice: "approve", reason: "ok" });
  expect(children(w, run.id)).toHaveLength(1);
  expect(openQs(w, run.id)).toEqual([]);
});

test("turning auto mode off hands the open plan question to the person", async () => {
  const w = world();
  const run = await submitted(w, { auto: true });
  await w.person("run.set_auto", { id: run.id, auto: false, expect_rev: getRun(w.ctx, run.id)!.rev });
  const [q] = openQs(w, run.id);
  expect(q!.answerer).toBe("person");
  await w.turn(run.id).catch(() => undefined);
  if (liveTurn(w.ctx, run.id)) {
    await expect(w.agent(w.grantCtx(run.id), "question.answer", { id: q!.id, answer: "approve", expect_rev: q!.rev }))
      .rejects.toMatchObject({ code: "not_allowed" });
  }
});

test("an escalated plan question stays the person's", async () => {
  const w = world();
  const run = await submitted(w, { auto: true });
  await w.turn(run.id);
  const [q] = openQs(w, run.id);
  await w.agent(w.grantCtx(run.id), "question.escalate", { id: q!.id, suggested: "approve", reason: "unsure", expect_rev: q!.rev });
  await expect(w.agent(w.grantCtx(run.id), "run.decide", { id: run.id, step: "plan", choice: "approve", reason: "r" }))
    .rejects.toMatchObject({ code: "not_allowed" });
  expect(openQs(w, run.id)[0]).toMatchObject({ answerer: "person" });
});

test("a re-plan that asks goes to the person even for an auto step", async () => {
  const w = world();
  w.install(planned);
  const run = await w.start(planned);
  updateRun(w.ctx, run.id, getRun(w.ctx, run.id)!.rev, { auto: true });
  updateStep(w.ctx, { runId: run.id, stepId: "plan", attempt: 1 }, { result: { replanMode: "ask" } });
  await w.turn(run.id);
  await submitGraph(w.ctx, { runId: run.id, stepId: "plan", source: graph }, w.deps, w.spawn);
  expect(openQs(w, run.id)[0]).toMatchObject({ answerer: "person" });
  await expect(w.agent(w.grantCtx(run.id), "run.decide", { id: run.id, step: "plan", choice: "approve", reason: "r" }))
    .rejects.toMatchObject({ code: "not_allowed" });
});

test("the tick raises the question for a plan that waits without one", async () => {
  const w = world();
  const run = await submitted(w);
  workflowDatabase(w.ctx).query("DELETE FROM workflow_questions WHERE run_id = ?").run(run.id);
  await w.tick();
  await w.tick();
  expect(openQs(w, run.id)).toHaveLength(1);
});

/** A code step waiting for review that two turns leave unreviewed. */
async function blockedOnReview(w: World) {
  const def = w.install({
    id: "t/code", version: 1, entry: "work",
    steps: { work: { type: "agent", kind: "feature", prompt: "W" }, done: { type: "end" } },
    edges: [{ from: "work", to: "done" }],
  });
  const run = await w.start(def);
  setRunBranch(w.ctx, run.id, { branch: "pacer/run-x", base_ref: "main", base_sha: "0".repeat(40) });
  const taskId = w.row(run.id, "work").taskId!;
  recordStepResult(w.ctx, taskId, { summary: "ok" });
  w.finish(taskId);
  await w.tick();
  for (let i = 0; i < 2; i++) {
    const turn = await w.turn(run.id);
    w.finish(turn.taskId!);
    await w.tick();
  }
  expect(getRun(w.ctx, run.id)!.orchestratorState).toBe("blocked");
  return { run: getRun(w.ctx, run.id)!, taskId };
}

test("a review verdict unblocks a planner that left the review open", async () => {
  const w = world();
  const { run, taskId } = await blockedOnReview(w);
  await w.tick();
  expect(getRun(w.ctx, run.id)!.orchestratorState).toBe("blocked");
  updateTask(w.ctx, taskId, t => { t.review = { accepted: false, at: w.ctx.now } as NonNullable<typeof t.review>; });
  await w.tick();
  const after = getRun(w.ctx, run.id)!;
  expect(after.reason ?? "").not.toContain("unresolved");
  expect(after.orchestratorState).not.toBe("blocked");
  expect(deriveWorkflowAttention(w.ctx).filter(i => i.id.startsWith("unresolved_wake"))).toEqual([]);
  // The planner takes the rejected step's decision without a manual retry.
  await w.turn(run.id);
});

test("pacer run retry-orchestrator clears a blocked planner", async () => {
  const w = world();
  const { run } = await blockedOnReview(w);
  const out = await runCmd(["retry-orchestrator", run.id], w.ctx, {});
  expect(out).toMatchObject({ code: 0 });
  expect(getRun(w.ctx, run.id)!.orchestratorState).toBe("idle");
});

test("a failed step nobody is working on asks the person to retry or skip it", async () => {
  const w = world();
  const run = await failedStep(w);
  // The planner's turn for the failure is pending, then live: nothing to ask yet.
  expect(deriveWorkflowAttention(w.ctx)).toEqual([]);
  const turn = await w.turn(run.id);
  expect(deriveWorkflowAttention(w.ctx)).toEqual([]);
  w.finish(turn.taskId!);
  await w.tick();
  const [item] = deriveWorkflowAttention(w.ctx);
  expect(item).toMatchObject({ id: `step_failed:${run.id}:work#1`, severity: "blocked" });
  expect(item!.actions.map(a => a.op)).toEqual(["step.retry", "step.skip"]);
  const shown = await runCmd(["show", run.id], w.ctx, {});
  expect(shown.out).toContain(`pacer step retry ${run.id} work`);
  await w.person(item!.actions[0]!.op!, item!.actions[0]!.params as Record<string, unknown>);
  expect(w.row(run.id, "work")).toMatchObject({ attempt: 2, status: "running" });
  expect(deriveWorkflowAttention(w.ctx)).toEqual([]);
});

const attended: WorkflowDef = {
  id: "t/attended", version: 1, entry: "brainstorm",
  steps: {
    brainstorm: { type: "agent", role: "orchestrator", interactive: true, prompt: "B" },
    open_pr: { type: "agent", role: "orchestrator", prompt: "O" },
    done: { type: "end" },
  },
  edges: [{ from: "brainstorm", to: "open_pr" }, { from: "open_pr", to: "done" }],
};

test("only the turn of an interactive step takes the interactive lane and its deadline", async () => {
  const w = world();
  w.install(attended);
  const run = await w.start(attended);
  const first = await w.turn(run.id);
  expect(readTask(w.ctx, first.taskId!)).toMatchObject({ interactive: true, timeoutS: 7200 });
  expect(first.deadline - first.startedAt).toBe(7200);
  recordStepResult(w.ctx, first.taskId!, {});
  w.finish(first.taskId!);
  await w.tick();
  const second = await w.turn(run.id);
  expect(readTask(w.ctx, second.taskId!)).toMatchObject({ interactive: false, timeoutS: 1200 });
  expect(second.deadline - second.startedAt).toBe(1200);
});

test("the first turn of a headless step creates a headless task", async () => {
  const w = world();
  w.install(brainstorm);
  const run = await w.start(brainstorm);
  const first = await w.turn(run.id);
  expect(readTask(w.ctx, first.taskId!)).toMatchObject({ interactive: false, timeoutS: 1200 });
});

test("every one-click answer to a human step or plan approval asks first", async () => {
  const w = world();
  await submitted(w);
  const [item] = deriveWorkflowAttention(w.ctx);
  expect(item!.actions).toHaveLength(1);
  expect(item!.actions[0]!.confirm).toContain('Answer "approve" to: Approve the plan');
  const own = world();
  await asked(own);
  expect(deriveWorkflowAttention(own.ctx)[0]!.actions.map(a => a.confirm)).toEqual([undefined, undefined]);
});
