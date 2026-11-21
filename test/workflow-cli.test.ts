import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { DelegateInput } from "../src/tasks/api";
import { callOp, type OpDeps } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { onTaskSettled } from "../src/workflow/engine";
import { findCommand } from "../src/commands";
import { workflowCmd } from "../src/commands/workflow";
import { runCmd, stepCmd } from "../src/commands/run";

/** The same delegation stub the engine and ops tests use. */
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

const FANOUT = `
id: t/fan
version: 1
steps:
  probe: { type: fanout, branches: [alpha, beta], each: { type: agent, kind: research, prompt: "Probe {{branch}}" }, join: all }
  done: { type: end }
edges:
  - [probe, done]
`;

function cliCtx(): Ctx {
  const ctx = fakeCtx();
  ctx.env.PACER_API = "inprocess";
  return ctx;
}

const executorCtx = (ctx: Ctx, taskId?: string): Ctx =>
  ({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", ...(taskId ? { PACER_TASK_ID: taskId } : {}) } });

function writeWorkflow(source: string): string {
  const file = join(mkdtempSync(join(tmpDir(), "wf-")), "demo.yaml");
  writeFileSync(file, source);
  return file;
}

/** Settles the entry step with a recorded result so the run waits on its human step. */
async function settleToWaiting(ctx: Ctx, runId: string): Promise<void> {
  const { steps } = await callOp(ctx, "run.get", { id: runId }) as { steps: { taskId?: string }[] };
  const draft = steps[0].taskId!;
  await callOp(executorCtx(ctx, draft), "step.result", { result: { ok: true } }, {});
  updateTask(ctx, draft, t => { t.state = "done"; });
  await onTaskSettled(ctx, draft);
}

test("workflow, run and step are registered commands", () => {
  for (const name of ["workflow", "run", "step"]) {
    const command = findCommand(name);
    expect(command?.usage).toContain(name);
    expect(typeof command?.run).toBe("function");
  }
});

test("workflow validate passes a good file and reports errors one per line with exit 1", async () => {
  const ctx = cliCtx();
  const ok = await workflowCmd(["validate", writeWorkflow(GOOD)], ctx);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("ok");
  const json = await workflowCmd(["validate", writeWorkflow(GOOD), "--json"], ctx);
  expect(JSON.parse(json.out)).toEqual({ ok: true, errors: [] });

  const bad = await workflowCmd(["validate", writeWorkflow(BAD)], ctx);
  expect(bad.code).toBe(1);
  for (const line of ["edges[0].to: unknown step 'nowhere'", "steps: no end step is reachable from 'start'"]) {
    expect(bad.err).toContain(line);
  }
  expect(bad.err.trim().split("\n")).toHaveLength(2);
});

test("workflow add installs, list shows it, both with --json", async () => {
  const ctx = cliCtx();
  const added = await workflowCmd(["add", writeWorkflow(GOOD), "--json"], ctx);
  expect(JSON.parse(added.out)).toEqual({ id: "t/demo", version: 1, created: true });
  const text = await workflowCmd(["add", writeWorkflow(GOOD)], ctx);
  expect(text.out).toContain("t/demo@1");
  expect(text.out).toContain("already installed");
  const list = await workflowCmd(["list"], ctx);
  expect(list.out).toContain("t/demo@1");
  expect(list.out).toContain("Demo");
  const listJson = await workflowCmd(["list", "--json"], ctx);
  expect(JSON.parse(listJson.out)[0].id).toBe("t/demo");
});

test("run start delegates with --brief and --repo; --json prints the run", async () => {
  const ctx = cliCtx();
  await workflowCmd(["add", writeWorkflow(GOOD)], ctx);
  const repo = gitRepo();
  const started = await runCmd(["start", "t/demo", "--brief", "Do X", "--repo", repo, "--json"], ctx, stubDeps());
  expect(started.code).toBe(0);
  const run = JSON.parse(started.out);
  expect(run.workflow).toBe("t/demo");
  expect(run.status).toBe("running");
  const { steps } = await callOp(ctx, "run.get", { id: run.id }) as { steps: { taskId?: string }[] };
  expect(readTask(ctx, steps[0].taskId!)!.brief.repo).toBe(repo);
  const missingBrief = await runCmd(["start", "t/demo"], ctx, stubDeps());
  expect(missingBrief.code).toBe(2);
  expect(missingBrief.err).toContain("usage");
});

test("run start defaults --repo to the current git top-level", async () => {
  const ctx = cliCtx();
  await workflowCmd(["add", writeWorkflow(GOOD)], ctx);
  const repo = gitRepo();
  const ctxWithGit: Ctx = { ...ctx, run: async argv =>
    argv[1] === "rev-parse" ? { code: 0, stdout: `${repo}\n`, stderr: "" } : { code: 127, stdout: "", stderr: "not available in tests" } };
  const started = await runCmd(["start", "t/demo", "--brief", "Do X", "--json"], ctxWithGit, stubDeps());
  expect(started.code).toBe(0);
  const run = JSON.parse(started.out);
  const { steps } = await callOp(ctx, "run.get", { id: run.id }) as { steps: { taskId?: string }[] };
  // The delegated brief carries the resolved repo.
  expect(readTask(ctx, steps[0].taskId!)!.brief.repo).toBe(repo);
});

test("run list and run show render runs and their steps", async () => {
  const ctx = cliCtx();
  await workflowCmd(["add", writeWorkflow(GOOD)], ctx);
  const run = JSON.parse((await runCmd(["start", "t/demo", "--brief", "Do X", "--repo", tmpDir(), "--json"], ctx, stubDeps())).out);
  const list = await runCmd(["list"], ctx);
  expect(list.out).toContain(`${run.id}  running  t/demo@1`);
  const waitingList = await runCmd(["list", "--status", "waiting"], ctx);
  expect(waitingList.code).toBe(0);
  expect(waitingList.out).toBe("");
  const shown = await runCmd(["show", run.id], ctx);
  expect(shown.out.split("\n")[0]).toBe(`${run.id}  t/demo@1  running`);
  expect(shown.out).toMatch(/^draft  running  t-\d{8}-\d{6}-[0-9a-f]{4}$/m);
  const shownJson = await runCmd(["show", run.id, "--json"], ctx);
  expect(JSON.parse(shownJson.out).run.id).toBe(run.id);
  const unknown = await runCmd(["show", "run_zzzzzzzzzz"], ctx);
  expect(unknown.code).toBe(2);
  expect(unknown.err).toContain("unknown run");
});

test("run show marks fan-out branches", async () => {
  const ctx = cliCtx();
  await workflowCmd(["add", writeWorkflow(FANOUT)], ctx);
  const run = JSON.parse((await runCmd(["start", "t/fan", "--brief", "Do X", "--repo", tmpDir(), "--json"], ctx, stubDeps())).out);
  const shown = await runCmd(["show", run.id], ctx);
  expect(shown.out).toMatch(/^probe\/alpha  running  t-\d{8}-\d{6}-[0-9a-f]{4}$/m);
  expect(shown.out).toMatch(/^probe\/beta  running  t-\d{8}-\d{6}-[0-9a-f]{4}$/m);
});

test("run answer settles a waiting human step and a second answer conflicts", async () => {
  const ctx = cliCtx();
  await workflowCmd(["add", writeWorkflow(GOOD)], ctx);
  const run = JSON.parse((await runCmd(["start", "t/demo", "--brief", "Do X", "--repo", tmpDir(), "--json"], ctx, stubDeps())).out);
  await settleToWaiting(ctx, run.id);
  expect((JSON.parse((await runCmd(["show", run.id, "--json"], ctx)).out)).run.status).toBe("waiting");

  const answered = await runCmd(["answer", run.id, "approve", "approve", "--json"], ctx, stubDeps());
  expect(answered.code).toBe(0);
  expect(JSON.parse(answered.out).status).toBe("done");
  const again = await runCmd(["answer", run.id, "approve", "approve"], ctx, stubDeps());
  expect(again.code).toBe(2);
  expect(again.err).toContain("conflict");
});

test("run stop marks the run stopped", async () => {
  const ctx = cliCtx();
  await workflowCmd(["add", writeWorkflow(GOOD)], ctx);
  const run = JSON.parse((await runCmd(["start", "t/demo", "--brief", "Do X", "--repo", tmpDir(), "--json"], ctx, stubDeps())).out);
  const stopped = await runCmd(["stop", run.id, "--json"], ctx, stubDeps());
  expect(stopped.code).toBe(0);
  expect(JSON.parse(stopped.out).status).toBe("stopped");
});

test("an executor session reports a step result but cannot start a run", async () => {
  const ctx = cliCtx();
  await workflowCmd(["add", writeWorkflow(GOOD)], ctx);
  const run = JSON.parse((await runCmd(["start", "t/demo", "--brief", "Do X", "--repo", tmpDir(), "--json"], ctx, stubDeps())).out);
  const step = (await callOp(ctx, "run.get", { id: run.id }) as { steps: { taskId?: string }[] }).steps[0];
  const exec = executorCtx(ctx, step.taskId);

  const refused = await runCmd(["start", "t/demo", "--brief", "Do X", "--repo", tmpDir()], exec, stubDeps());
  expect(refused.code).toBe(2);
  expect(refused.err).toContain("step.result");

  const reported = await stepCmd(["result", "--json", '{"ok":true}'], exec);
  expect(reported.code).toBe(0);
  expect(JSON.parse(reported.out).result).toEqual({ ok: true });

  const twice = await stepCmd(["result", "--json", '{"ok":true}'], exec);
  expect(twice.code).toBe(2);
  expect(twice.err).toContain("conflict");

  const outsider = await stepCmd(["result", "--json", '{"ok":true}'], cliCtx());
  expect(outsider.code).toBe(2);
  expect(outsider.err).toContain("delegated task");
});

test("step result also accepts --file and rejects bad usage", async () => {
  const ctx = cliCtx();
  await workflowCmd(["add", writeWorkflow(GOOD)], ctx);
  const run = JSON.parse((await runCmd(["start", "t/demo", "--brief", "Do X", "--repo", tmpDir(), "--json"], ctx, stubDeps())).out);
  const step = (await callOp(ctx, "run.get", { id: run.id }) as { steps: { taskId?: string }[] }).steps[0];
  const exec = executorCtx(ctx, step.taskId);
  const file = join(mkdtempSync(join(tmpDir(), "res-")), "result.json");
  writeFileSync(file, '{"ok":true}');
  const byFile = await stepCmd(["result", "--file", file], exec);
  expect(byFile.code).toBe(0);
  expect(JSON.parse(byFile.out).result).toEqual({ ok: true });
  const noBody = await stepCmd(["result"], exec);
  expect(noBody.code).toBe(2);
  const both = await stepCmd(["result", "--json", '{"ok":true}', "--file", file], exec);
  expect(both.code).toBe(2);
  const notObject = await stepCmd(["result", "--json", "[1]"], exec);
  expect(notObject.code).toBe(2);
  expect(notObject.err).toContain("object");
});
