// P7-W4-start-auto: run.start workflow "auto" resolves to workflows.router
// (default pacer-dev/router), refuses clearly when the router is missing/disabled,
// and honors a configured override.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { shutdownPlugins } from "../src/plugins";
import { COALESCE_WINDOW_S } from "../src/workflow/budget";
import { chooseWorkflow, defaultEngineDeps, startRun } from "../src/workflow/engine";
import { startTurn, settleTurn } from "../src/workflow/orchestrator";
import { syncPluginWorkflows } from "../src/workflow/plugin-sync";
import { addDefinition, getRun, stepsOfRun } from "../src/workflow/store";
import { createTask, updateTask } from "../src/tasks/store";
import { issueRunGrant } from "../src/workflow/run-grant";
import { onTaskSettled, recordStepResult } from "../src/workflow/engine";
import type { WorkflowDef } from "../src/workflow/schema";
import type { SpawnRunner } from "../src/tasks/api";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";

const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => shutdownPlugins(ctx)));
});

const NOW = 1_700_000_000;

function home(strategyExtra = "") {
  const dir = tmpDir();
  const ctx = fakeCtx({
    home: dir,
    pacerHome: join(dir, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    now: NOW,
  });
  contexts.push(ctx);
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    `planner: claude-code\nproviders:\n  claude-code: {}\n${strategyExtra}`,
  );
  return ctx;
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return toApiError(e).code;
  }
};

const msgOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "";
  } catch (e) {
    return toApiError(e).message;
  }
};

async function syncDev(ctx: ReturnType<typeof fakeCtx>) {
  await callOp(ctx, "plugin.enable", { id: "pacer-dev" });
  await syncPluginWorkflows(ctx, "pacer-dev");
}

test("run.start auto resolves to default workflows.router pacer-dev/router", async () => {
  const ctx = home();
  await syncDev(ctx);
  const repo = gitRepo();
  const run = await startRun(ctx, { workflow: "auto", repo, brief: "Quick trivia", title: "t" }, undefined, {
    ...defaultEngineDeps,
    delegate: async (c, input) => createTask(c, {
      brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 60,
      title: input.title, requestId: input.requestId,
    }),
  });
  expect(run.workflow).toBe("pacer-dev/router");
  expect(run.brief).toBe("Quick trivia");
  const viaOp = await callOp(ctx, "run.start", {
    workflow: "auto", repo, brief: "via op",
  }) as { workflow: string };
  expect(viaOp.workflow).toBe("pacer-dev/router");
}, 60000);

test("run.start auto refuses clearly when the router plugin is disabled", async () => {
  const ctx = home();
  await syncDev(ctx);
  const repo = gitRepo();
  await callOp(ctx, "plugin.disable", { id: "pacer-dev" });
  const code = await codeOf(startRun(ctx, { workflow: "auto", repo, brief: "nope" }));
  expect(code).toBe("not_allowed");
  const msg = await msgOf(startRun(ctx, { workflow: "auto", repo, brief: "nope" }));
  expect(msg).toMatch(/router|pacer-dev\/router|cannot start|disabled/i);
}, 60000);

test("run.start auto uses configured workflows.router override", async () => {
  const ctx = home("workflows:\n  router: t/custom-router\n");
  const custom: WorkflowDef = {
    id: "t/custom-router",
    version: 1,
    steps: {
      choose: { type: "choose_workflow", from: ["t/ask"] },
      done: { type: "end" },
    },
    edges: [{ from: "choose", to: "done" }],
    entry: "choose",
  };
  const ask: WorkflowDef = {
    id: "t/ask",
    version: 1,
    steps: {
      answer: { type: "agent", role: "orchestrator", prompt: "Answer: {{brief}}" },
      done: { type: "end" },
    },
    edges: [{ from: "answer", to: "done" }],
    entry: "answer",
  };
  addDefinition(ctx, custom, "source");
  addDefinition(ctx, ask, "source");
  const repo = gitRepo();
  const run = await startRun(ctx, { workflow: "auto", repo, brief: "route me" });
  expect(run.workflow).toBe("t/custom-router");
});

test("auto router choose starts a child that inherits the brief and completes", async () => {
  const ctx = home();
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\n",
  );
  const ask: WorkflowDef = {
    id: "t/ask",
    version: 1,
    steps: {
      answer: { type: "agent", role: "orchestrator", prompt: "Answer: {{brief}}" },
      done: { type: "end" },
    },
    edges: [{ from: "answer", to: "done" }],
    entry: "answer",
  };
  const router: WorkflowDef = {
    id: "t/router",
    version: 1,
    steps: {
      choose: { type: "choose_workflow", from: ["t/ask"] },
      done: { type: "end" },
    },
    edges: [{ from: "choose", to: "done" }],
    entry: "choose",
  };
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\nworkflows:\n  router: t/router\n",
  );
  addDefinition(ctx, ask, "source");
  addDefinition(ctx, router, "source");
  const spawn: SpawnRunner = () => 1;
  const repo = gitRepo();
  const deps = {
    ...defaultEngineDeps,
    delegate: async (c: typeof ctx, input: { brief: unknown; kind?: string | null; title?: string; requestId?: string }) => {
      const b = input.brief as { goal: string; repo?: string };
      return createTask(c, {
        brief: { goal: b.goal, repo: b.repo ?? repo },
        kind: input.kind ?? null,
        requestedExecutor: null,
        timeoutS: 60,
        title: input.title,
        requestId: input.requestId,
      });
    },
  };
  const run = await startRun(ctx, { workflow: "auto", repo, brief: "inherit-me" }, spawn, deps);
  expect(run.workflow).toBe("t/router");

  const ready = (getRun(ctx, run.id)?.updatedAt ?? ctx.now) + COALESCE_WINDOW_S;
  const turn = await startTurn({ ...ctx, now: ready }, run.id, { spawn, plannerEligible: () => true });
  expect(turn).not.toBeNull();
  const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: ready + 600 });
  const child = await chooseWorkflow(
    { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator", PACER_TASK_ID: turn!.taskId! } },
    { runId: run.id, stepId: "choose", workflow: "t/ask", reason: "fits" },
    spawn,
    deps,
  );
  expect(child.brief).toBe("inherit-me");
  expect(child.parentRunId).toBe(run.id);

  const childStep = stepsOfRun(ctx, child.id).find(s => s.stepId === "answer")!;
  recordStepResult(ctx, childStep.taskId!, { ok: true });
  updateTask(ctx, childStep.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, childStep.taskId!, spawn, deps);
  await settleTurn(ctx, turn!.id, { outcome: "done" });

  expect(getRun(ctx, child.id)!.status).toBe("done");
  // Parent choose settles when the child ends.
  const pick = stepsOfRun(ctx, run.id).find(s => s.stepId === "choose");
  expect(pick?.status).toBe("done");
  expect(pick?.result).toMatchObject({ workflow: "t/ask", reason: "fits", childRunId: child.id });
});

test("run.start auto refuses clearly when the router is missing", async () => {
  const ctx = home("workflows:\n  router: missing/router\n");
  const repo = gitRepo();
  const code = await codeOf(startRun(ctx, { workflow: "auto", repo, brief: "nope" }));
  expect(code).toBe("not_found");
  const msg = await msgOf(startRun(ctx, { workflow: "auto", repo, brief: "nope" }));
  expect(msg).toBe("workflows.router 'missing/router' is not installed (run.start auto)");
});

test("run.start auto refuses a broken strategy.yaml with a clear diagnostic", async () => {
  const ctx = home();
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: [broken\n");
  const repo = gitRepo();
  const code = await codeOf(startRun(ctx, { workflow: "auto", repo, brief: "nope" }));
  expect(code).toBe("invalid_input");
  const msg = await msgOf(startRun(ctx, { workflow: "auto", repo, brief: "nope" }));
  expect(msg.startsWith("run.start auto: cannot load strategy (")).toBe(true);
});

test("choose mid-turn attaching a child orch step must not fail it as no step result when the choosing turn ends", async () => {
  // Live W4b: router choose starts pacer-dev/ask (answer is role:orchestrator on the
  // shared orch task). Ending the choose turn without step.result used to fail answer.
  const ctx = home();
  const ask: WorkflowDef = {
    id: "t/ask-orch",
    version: 1,
    steps: {
      answer: { type: "agent", role: "orchestrator", prompt: "Answer: {{brief}}" },
      done: { type: "end" },
    },
    edges: [{ from: "answer", to: "done" }],
    entry: "answer",
  };
  const router: WorkflowDef = {
    id: "t/router-orch",
    version: 1,
    steps: {
      choose: { type: "choose_workflow", from: ["t/ask-orch"] },
      done: { type: "end" },
    },
    edges: [{ from: "choose", to: "done" }],
    entry: "choose",
  };
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\nworkflows:\n  router: t/router-orch\n",
  );
  addDefinition(ctx, ask, "source");
  addDefinition(ctx, router, "source");
  const spawn: SpawnRunner = () => 1;
  const repo = gitRepo();
  const deps = {
    ...defaultEngineDeps,
    delegate: async (c: typeof ctx, input: { brief: unknown; kind?: string | null; title?: string; requestId?: string }) => {
      const b = input.brief as { goal: string; repo?: string };
      return createTask(c, {
        brief: { goal: b.goal, repo: b.repo ?? repo },
        kind: input.kind ?? null,
        requestedExecutor: null,
        timeoutS: 60,
        title: input.title,
        requestId: input.requestId,
      });
    },
  };
  const run = await startRun(ctx, { workflow: "auto", repo, brief: "capital?" }, spawn, deps);
  const ready = (getRun(ctx, run.id)?.updatedAt ?? ctx.now) + COALESCE_WINDOW_S;
  const turn = await startTurn({ ...ctx, now: ready }, run.id, { spawn, plannerEligible: () => true });
  expect(turn).not.toBeNull();
  const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: ready + 600 });
  const child = await chooseWorkflow(
    { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator", PACER_TASK_ID: turn!.taskId! } },
    { runId: run.id, stepId: "choose", workflow: "t/ask-orch", reason: "ask" },
    spawn,
    deps,
  );
  const answer = stepsOfRun(ctx, child.id).find(s => s.stepId === "answer")!;
  expect(answer.status).toBe("running");
  expect(answer.taskId).toBe(turn!.taskId);
  // Choosing turn ends without step.result for the newly attached child orch step.
  // onTaskSettled must requeue the orch task AND settle the choosing turn so a
  // follow-up turn can claim the child's wakeup (live W4b hang).
  updateTask(ctx, turn!.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, turn!.taskId!, spawn, deps);
  const still = stepsOfRun(ctx, child.id).find(s => s.stepId === "answer")!;
  expect(still.status).toBe("running");
  expect(still.error).toBeUndefined();
  const { getTurn } = await import("../src/workflow/wakeups");
  expect(getTurn(ctx, turn!.id)?.status).toBe("done");

  // A later root turn can still record the child answer and finish.
  const turn2 = await startTurn({ ...ctx, now: ready + 60 }, run.id, { spawn, plannerEligible: () => true });
  expect(turn2).not.toBeNull();
  expect(turn2!.id).not.toBe(turn!.id);
  recordStepResult(ctx, turn2!.taskId!, { ok: true, answer: "Paris" });
  updateTask(ctx, turn2!.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, turn2!.taskId!, spawn, deps);
  await settleTurn(ctx, turn2!.id, { outcome: "done" });
  expect(getRun(ctx, child.id)!.status).toBe("done");
});

test("settle-choose path must not settle a foreign live turn on the shared orch task", async () => {
  const ctx = home();
  const ask: WorkflowDef = {
    id: "t/ask-race",
    version: 1,
    steps: {
      answer: { type: "agent", role: "orchestrator", prompt: "Answer: {{brief}}" },
      done: { type: "end" },
    },
    edges: [{ from: "answer", to: "done" }],
    entry: "answer",
  };
  const router: WorkflowDef = {
    id: "t/router-race",
    version: 1,
    steps: {
      choose: { type: "choose_workflow", from: ["t/ask-race"] },
      done: { type: "end" },
    },
    edges: [{ from: "choose", to: "done" }],
    entry: "choose",
  };
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\nworkflows:\n  router: t/router-race\n",
  );
  addDefinition(ctx, ask, "source");
  addDefinition(ctx, router, "source");
  const spawn: SpawnRunner = () => 1;
  const repo = gitRepo();
  const deps = {
    ...defaultEngineDeps,
    delegate: async (c: typeof ctx, input: { brief: unknown; kind?: string | null; title?: string; requestId?: string }) => {
      const b = input.brief as { goal: string; repo?: string };
      return createTask(c, {
        brief: { goal: b.goal, repo: b.repo ?? repo },
        kind: input.kind ?? null,
        requestedExecutor: null,
        timeoutS: 60,
        title: input.title,
        requestId: input.requestId,
      });
    },
  };
  const run = await startRun(ctx, { workflow: "auto", repo, brief: "race" }, spawn, deps);
  const ready = NOW + COALESCE_WINDOW_S;
  const turn = await startTurn({ ...ctx, now: ready }, run.id, { spawn, plannerEligible: () => true });
  expect(turn).not.toBeNull();
  const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: ready + 600 });
  const child = await chooseWorkflow(
    { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator", PACER_TASK_ID: turn!.taskId! } },
    { runId: run.id, stepId: "choose", workflow: "t/ask-race", reason: "ask" },
    spawn,
    deps,
  );
  // Real negative control: foreign live turn on a different run, same shared orch task,
  // with a *lower* rowid than the choosing turn. Without run-scoped liveTurnForTask,
  // ORDER BY rowid ASC LIMIT 1 would settle the foreign turn first.
  const { insertTurn, getTurn, liveTurnForTask } = await import("../src/workflow/wakeups");
  const { workflowDatabase } = await import("../src/workflow/store");
  const own = turn!;
  const ownRow = getTurn(ctx, own.id)!;
  workflowDatabase(ctx).query("DELETE FROM workflow_turns WHERE id = ?").run(own.id);
  const foreign = insertTurn(ctx, {
    id: `turn_foreign_${child.id}`,
    runId: child.id,
    planner: "claude-code",
    status: "running",
    startedAt: ready + 1,
    deadline: ready + 600,
    taskId: own.taskId!,
    failures: 0,
  });
  insertTurn(ctx, {
    id: ownRow.id,
    runId: ownRow.runId,
    planner: ownRow.planner,
    status: "running",
    startedAt: ownRow.startedAt,
    deadline: ownRow.deadline,
    taskId: ownRow.taskId!,
    failures: ownRow.failures,
    sessionId: ownRow.sessionId,
  });
  // Unscoped lookup prefers the lower-rowid foreign turn — proves the control is real.
  expect(liveTurnForTask(ctx, own.taskId!)!.id).toBe(foreign.id);
  // Scoped lookup (production path) must still see only this root's turn.
  expect(liveTurnForTask(ctx, own.taskId!, run.id)!.id).toBe(own.id);
  updateTask(ctx, own.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, own.taskId!, spawn, deps);
  expect(getTurn(ctx, own.id)?.status).toBe("done");
  expect(getTurn(ctx, foreign.id)?.status).toBe("running");
});

test("stop during choose deferral terminals the orchestrate task", async () => {
  const { stopRun } = await import("../src/workflow/engine");
  const { readTask } = await import("../src/tasks/store");
  const { getTurn } = await import("../src/workflow/wakeups");
  const ctx = home();
  const ask: WorkflowDef = {
    id: "t/ask-stop",
    version: 1,
    steps: {
      answer: { type: "agent", role: "orchestrator", prompt: "A" },
      done: { type: "end" },
    },
    edges: [{ from: "answer", to: "done" }],
    entry: "answer",
  };
  const router: WorkflowDef = {
    id: "t/router-stop",
    version: 1,
    steps: {
      choose: { type: "choose_workflow", from: ["t/ask-stop"] },
      done: { type: "end" },
    },
    edges: [{ from: "choose", to: "done" }],
    entry: "choose",
  };
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\nworkflows:\n  router: t/router-stop\n",
  );
  addDefinition(ctx, ask, "source");
  addDefinition(ctx, router, "source");
  const spawn: SpawnRunner = () => 1;
  const repo = gitRepo();
  const deps = {
    ...defaultEngineDeps,
    delegate: async (c: typeof ctx, input: { brief: unknown; kind?: string | null; title?: string; requestId?: string }) => {
      const b = input.brief as { goal: string; repo?: string };
      return createTask(c, {
        brief: { goal: b.goal, repo: b.repo ?? repo },
        kind: input.kind ?? null,
        requestedExecutor: null,
        timeoutS: 60,
        title: input.title,
        requestId: input.requestId,
      });
    },
  };
  const run = await startRun(ctx, { workflow: "auto", repo, brief: "stop-me" }, spawn, deps);
  const ready = NOW + COALESCE_WINDOW_S;
  const turn = await startTurn({ ...ctx, now: ready }, run.id, { spawn, plannerEligible: () => true });
  expect(turn).not.toBeNull();
  const grant = issueRunGrant(ctx, { runId: run.id, turnId: turn!.id, deadline: ready + 600 });
  await chooseWorkflow(
    { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: grant, PACER_ROLE: "orchestrator", PACER_TASK_ID: turn!.taskId! } },
    { runId: run.id, stepId: "choose", workflow: "t/ask-stop", reason: "ask" },
    spawn,
    deps,
  );
  // Deferral path: onTaskSettled settles the choosing turn; then stop with no live turn.
  updateTask(ctx, turn!.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, turn!.taskId!, spawn, deps);
  expect(getTurn(ctx, turn!.id)?.status).toBe("done");
  const orchId = getRun(ctx, run.id)!.orchestratorTaskId!;
  await stopRun(ctx, run.id, getRun(ctx, run.id)!.rev, deps);
  expect(getRun(ctx, run.id)!.status).toBe("stopped");
  expect(readTask(ctx, orchId)!.state).toBe("stopped");
});
