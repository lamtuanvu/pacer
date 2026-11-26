// A workflow step worker reports with its attempt credential: step.result, step.artifact and
// question.ask, on its own step only. Identity comes from the verified `pet_` / `pwg_`; nothing
// else widens, and no HTTP bearer gains an operation.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import type { Strategy } from "../src/config/strategy";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";
import { callOp, opNames } from "../src/api/ops";
import { authorizeWorkOperation } from "../src/core/work";
import { issueRunGrant } from "../src/workflow/run-grant";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { dispatchDatabase } from "../src/dispatch/store";
import { issueWorkGrant, registerWork, revokeWorkGrants } from "../src/dispatch/work";
import { issueEnforcementToken, revokeEnforcementTokens } from "../src/dispatch/enforcement-token";
import { certifyExecutor, resolveEnforcementTarget } from "../src/dispatch/enforcement";
import { resolvePolicyRepoInput } from "../src/core/project-policy";
import { addDefinition, getRun, listQuestions, stepByTask, stepsOfRun } from "../src/workflow/store";
import { startRun, type EngineDeps } from "../src/workflow/engine";
import { listArtifacts, runEvidenceDir } from "../src/workflow/artifacts";
import { createMcpServer } from "../src/mcp/server";
import { startServer } from "../src/serve/http";
import { executorEnv, execProcess } from "../src/exec/process";
import { main } from "../src/cli";
import type { WorkflowDef } from "../src/workflow/schema";

const STEP_OPS = ["step.result", "step.artifact", "question.ask"] as const;
const WORK_GRANT_REFUSAL = "Operation is not allowed by this work grant";
const ENFORCEMENT_REFUSAL = "Enforcement identity only reports a native child denial";
const CLI_WORK_REFUSAL = "pacer: work grants only allow scoped dispatch commands";

const fan: WorkflowDef = {
  id: "t/identity",
  version: 1,
  steps: {
    probe: { type: "fanout", branches: ["alpha", "beta"], each: { type: "agent", kind: "research", prompt: "Probe {{branch}}" }, join: "all" },
    done: { type: "end" },
  },
  edges: [{ from: "probe", to: "done" }],
  entry: "probe",
};

function deps(): EngineDeps {
  const byRequest = new Map<string, TaskRecord>();
  return {
    delegate: async (ctx, input: DelegateInput) => {
      const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
      if (prior) return readTask(ctx, prior.id) ?? prior;
      const task = createTask(ctx, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      if (input.workParent) registerWork(ctx, task.id, input.dispatch ?? {}, input.workParent, input.workGrant);
      if (input.requestId) byRequest.set(input.requestId, task);
      return task;
    },
    stopTask: (ctx, id) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
  };
}

/** Two sibling step tasks of one work-node run, both running. */
async function setup(ctx: Ctx = fakeCtx({ now: Date.now() / 1000 })) {
  addDefinition(ctx, fan, "source");
  const run = await startRun(ctx, { workflow: "t/identity", repo: tmpDir(), brief: "B" }, undefined, deps());
  const steps = stepsOfRun(ctx, run.id);
  const own = steps.find(s => s.branch === "alpha")!, other = steps.find(s => s.branch === "beta")!;
  for (const s of [own, other]) updateTask(ctx, s.taskId!, t => { t.state = "running"; });
  mkdirSync(runEvidenceDir(ctx, run.id), { recursive: true });
  const file = join(runEvidenceDir(ctx, run.id), "report.txt");
  writeFileSync(file, "evidence");
  return { ctx, runId: run.id, own: own.taskId!, other: other.taskId!, file };
}

type Mode = "both" | "pet" | "pwg";
const MODES: Mode[] = ["both", "pet", "pwg"];

function credentials(ctx: Ctx, id: string, mode: Mode): Record<string, string> {
  return {
    ...(mode !== "pwg" ? { PACER_ENFORCEMENT_TOKEN: issueEnforcementToken(ctx, id, 1) } : {}),
    ...(mode !== "pet" ? { PACER_WORK_GRANT: issueWorkGrant(ctx, id, 1) } : {}),
  };
}

const worker = (ctx: Ctx, id: string | undefined, creds: Record<string, string>): Ctx =>
  ({ ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: id, ...creds } });

const ask = { text: "Which?", answerType: "single", options: [{ value: "a" }, { value: "b" }], blocks: "step" };
const params = (op: string, file: string): Record<string, unknown> =>
  op === "step.result" ? { result: { ok: true } } : op === "step.artifact" ? { path: file, label: "report" } : ask;

async function refusesAll(ctx: Ctx, file: string, message?: string | RegExp) {
  for (const op of STEP_OPS) {
    const attempt = callOp(ctx, op, params(op, file));
    await expect(attempt).rejects.toMatchObject({ code: "not_allowed", ...(typeof message === "string" ? { message } : {}) });
  }
}

function untouched(ctx: Ctx, runId: string, taskId: string) {
  expect(stepByTask(ctx, taskId)!.result).toBeUndefined();
  expect(listQuestions(ctx, runId)).toEqual([]);
  expect(listArtifacts(ctx, runId)).toEqual([]);
}

describe("a step worker's credential", () => {
  for (const mode of MODES) {
    test(`${mode}: result, artifact and question succeed on the own step only`, async () => {
      const { ctx, runId, own, other, file } = await setup();
      const me = worker(ctx, own, credentials(ctx, own, mode));
      await callOp(me, "step.artifact", { path: file, label: "report" });
      await callOp(me, "question.ask", ask);
      await callOp(me, "step.result", { result: { ok: true } });
      expect(stepByTask(ctx, own)!.result).toEqual({ ok: true });
      expect(stepByTask(ctx, other)!.result).toBeUndefined();
      expect(listQuestions(ctx, runId)).toMatchObject([{ askerTaskId: own, stepId: "probe", branch: "alpha" }]);
      expect(listArtifacts(ctx, runId)).toHaveLength(1);
      expect(readTask(ctx, other)!.question).toBeUndefined();
    });

    test(`${mode}: another task's id is refused`, async () => {
      const { ctx, runId, own, other, file } = await setup();
      const creds = credentials(ctx, own, mode);
      await refusesAll(worker(ctx, other, creds), file);
      await refusesAll(worker(ctx, undefined, creds), file);
      await refusesAll(worker(ctx, "", creds), file);
      untouched(ctx, runId, own);
      untouched(ctx, runId, other);
    });
  }

  test("credentials of two different tasks are refused whatever the task id says", async () => {
    const { ctx, runId, own, other, file } = await setup();
    const creds = {
      PACER_ENFORCEMENT_TOKEN: issueEnforcementToken(ctx, own, 1),
      PACER_WORK_GRANT: issueWorkGrant(ctx, other, 1),
    };
    await refusesAll(worker(ctx, own, creds), file);
    await refusesAll(worker(ctx, other, creds), file);
    untouched(ctx, runId, own);
    untouched(ctx, runId, other);
  });

  test("one invalid credential beside a valid one is refused", async () => {
    const { ctx, runId, own, file } = await setup();
    await refusesAll(worker(ctx, own, { ...credentials(ctx, own, "pet"), PACER_WORK_GRANT: "pwg_" + "0".repeat(64) }), file);
    await refusesAll(worker(ctx, own, { ...credentials(ctx, own, "pwg"), PACER_ENFORCEMENT_TOKEN: "pet_x" }), file);
    untouched(ctx, runId, own);
  });

  for (const mode of MODES) {
    test(`${mode}: revoked, expired, earlier-attempt and settled credentials are refused`, async () => {
      const { ctx, runId, own, file } = await setup();
      const me = worker(ctx, own, credentials(ctx, own, mode));
      await refusesAll({ ...me, now: me.now + 601 }, file);
      updateTask(ctx, own, t => {
        t.attempts.push({ executor: "codex", model: null, startedAt: ctx.now, endedAt: ctx.now, exitCode: 1, timedOut: false, limitHit: false, log: "" });
      });
      await refusesAll(me, file);
      updateTask(ctx, own, t => { t.attempts.pop(); t.state = "done"; });
      await refusesAll(me, file);
      updateTask(ctx, own, t => { t.state = "running"; });
      revokeEnforcementTokens(ctx, own);
      revokeWorkGrants(ctx, own);
      await refusesAll(me, file);
      untouched(ctx, runId, own);
    });
  }

  test("a question cannot name another run, step, attempt or branch", async () => {
    const { ctx, runId, own } = await setup();
    for (const mode of MODES) {
      const me = worker(ctx, own, credentials(ctx, own, mode));
      for (const extra of [{ runId }, { runId: "run_aaaaaaaaaa" }, { stepId: "done" }, { attempt: 2 }, { branch: "beta" }]) {
        await expect(callOp(me, "question.ask", { ...ask, ...extra })).rejects.toMatchObject({ code: "not_allowed" });
      }
    }
    expect(listQuestions(ctx, runId)).toEqual([]);
    const me = worker(ctx, own, credentials(ctx, own, "pet"));
    await callOp(me, "question.ask", { ...ask, stepId: "probe", attempt: 1, branch: "alpha" });
    expect(listQuestions(ctx, runId)).toMatchObject([{ askerTaskId: own }]);
  });

  test("no other operation opens", async () => {
    const { ctx, own, other } = await setup();
    const open = (mode: Mode) => {
      const me = worker(ctx, own, credentials(ctx, own, mode));
      return opNames().filter(name => {
        try { authorizeWorkOperation(me, name, { id: own }); return true; } catch { return false; }
      }).sort();
    };
    const self = [...STEP_OPS] as string[];
    expect(open("pet")).toEqual([...self, "dispatch.enforcement.denied"].sort());
    expect(open("both")).toEqual([...self, "dispatch.enforcement.denied"].sort());
    // The work grant keeps exactly the registered operations it had before, plus the three on the own step.
    expect(open("pwg")).toEqual([...self,
      "dispatch.child", "dispatch.events", "dispatch.stop", "dispatch.tree", "dispatch.wait",
      "msg.close", "msg.inbox", "msg.log", "msg.policy", "msg.read", "msg.send", "msg.wait", "tree.status",
      "task.diff", "task.get", "task.log", "task.wait",
    ].sort());
    const me = worker(ctx, own, credentials(ctx, own, "pwg"));
    for (const op of ["step.skip", "step.retry", "question.answer", "question.escalate", "question.get", "question.list", "run.get", "run.stop", "run.start", "task.ask"]) {
      expect(() => authorizeWorkOperation(me, op, { id: other })).toThrow();
    }
  });

  test("a forged environment without the credential cannot report on a credentialed step", async () => {
    const { ctx, runId, own, other, file } = await setup();
    credentials(ctx, other, "pet");
    credentials(ctx, own, "pwg");
    // Own credentials dropped, a sibling's task id claimed.
    await refusesAll(worker(ctx, other, {}), file);
    await refusesAll(worker(ctx, own, {}), file);
    await refusesAll(worker(ctx, other, { PACER_ENFORCEMENT_TOKEN: "pet_" + "a".repeat(64) }), file);
    untouched(ctx, runId, own);
    untouched(ctx, runId, other);
  });

  test("a sibling that has not launched yet cannot be reported on without a credential", async () => {
    const { ctx, runId, other, file } = await setup();
    updateTask(ctx, other, t => { t.state = "queued"; });
    await refusesAll(worker(ctx, other, {}), file);
    untouched(ctx, runId, other);
  });

  test("a step whose attempts get no credential reports as before", async () => {
    const { ctx, runId, own, file } = await setup();
    dispatchDatabase(ctx).query("DELETE FROM work_nodes WHERE task_id=?").run(own);
    const me = worker(ctx, own, {});
    for (const op of STEP_OPS) await callOp(me, op, params(op, file));
    expect(stepByTask(ctx, own)!.result).toEqual({ ok: true });
    expect(listQuestions(ctx, runId)).toMatchObject([{ askerTaskId: own }]);
  });

  test("an orchestrator role or run grant is never answered by the step credential", async () => {
    const { ctx, runId, own, file } = await setup();
    const creds = credentials(ctx, own, "both");
    const role = worker(ctx, own, creds);
    await refusesAll({ ...role, env: { ...role.env, PACER_ROLE: "orchestrator" } }, file);
    const foreign = issueRunGrant(ctx, { runId: "run_aaaaaaaaaa", turnId: "turn_x", deadline: ctx.now + 600 });
    for (const op of STEP_OPS) {
      await expect(callOp({ ...role, env: { ...role.env, PACER_RUN_GRANT: foreign } }, op, params(op, file))).rejects.toThrow();
    }
    updateTask(ctx, own, t => { t.kind = "orchestrate"; });
    await refusesAll(role, file);
    untouched(ctx, runId, own);
  });

  test("a managed task that is not a step is refused exactly as before", async () => {
    const { ctx, file } = await setup();
    const plain = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    registerWork(ctx, plain.id, { allowDelegation: true, delegationEnforcement: "strict" });
    updateTask(ctx, plain.id, t => { t.state = "running"; });
    await refusesAll(worker(ctx, plain.id, credentials(ctx, plain.id, "pwg")), file, WORK_GRANT_REFUSAL);
    await refusesAll(worker(ctx, plain.id, credentials(ctx, plain.id, "pet")), file, ENFORCEMENT_REFUSAL);
    await refusesAll(worker(ctx, plain.id, credentials(ctx, plain.id, "both")), file, ENFORCEMENT_REFUSAL);
    const granted = worker(ctx, plain.id, credentials(ctx, plain.id, "pwg"));
    for (const argv of [["step", "result", "--json", "{}"], ["step", "artifact", file, "--label", "x"], ["ask", "--type", "text", "q"], ["ask", "q"]]) {
      expect(await main(argv, { ...granted, env: { ...granted.env } })).toEqual({ code: 2, out: "", err: CLI_WORK_REFUSAL });
    }
    expect(readTask(ctx, plain.id)!.question).toBeUndefined();
  });
});

describe("the CLI under a step worker's work grant", () => {
  test("allows step result, step artifact and structured ask, nothing else", async () => {
    const { ctx, runId, own, other, file } = await setup();
    const me = worker(ctx, own, credentials(ctx, own, "both"));
    const cli = (argv: string[], from: Ctx = me) => main(argv, { ...from, env: { ...from.env } });
    for (const argv of [
      ["step", "skip", runId, "probe"], ["step", "retry", runId, "probe"], ["ask", "plain question"], ["answer", "q_aaaaaaaaaa", "a"],
      ["question", "list"], ["run", "show", runId], ["stop", other], ["send", other, "hi"], ["status"], ["report", "--status", "done"],
    ]) expect(await cli(argv)).toEqual({ code: 2, out: "", err: CLI_WORK_REFUSAL });
    // A sibling's task id turns even the three allowed commands back into the old refusal.
    const forged = { ...me, env: { ...me.env, PACER_TASK_ID: other } };
    expect(await cli(["step", "result", "--json", "{}"], forged)).toEqual({ code: 2, out: "", err: CLI_WORK_REFUSAL });
    untouched(ctx, runId, own);

    expect((await cli(["step", "artifact", file, "--label", "report"])).code).toBe(0);
    expect((await cli(["ask", "--type", "text", "--blocks", "nothing", "Which?"])).code).toBe(0);
    expect((await cli(["step", "result", "--json", '{"ok":true}'])).code).toBe(0);
    expect(stepByTask(ctx, own)!.result).toEqual({ ok: true });
  });
});

describe("ask --blocks", () => {
  async function asking() {
    const { ctx, runId, own } = await setup();
    const me = worker(ctx, own, credentials(ctx, own, "pet"));
    return { ctx, runId, own, cli: (argv: string[]) => main(argv, { ...me, env: { ...me.env } }) };
  }
  const forms: [string, string[], string][] = [
    ["bare before another flag", ["--blocks", "--step", "probe", "Q?"], "step"],
    ["bare before the text", ["--blocks", "Q?"], "step"],
    ["trailing", ["Q?", "--blocks"], "step"],
    ["valued step", ["--blocks", "step", "Q?"], "step"],
    ["valued branch", ["--blocks", "branch", "Q?"], "branch"],
    ["valued nothing", ["--blocks", "nothing", "Q?"], "nothing"],
    ["equals", ["--blocks=branch", "Q?"], "branch"],
    ["absent", ["Q?"], "step"],
  ];
  for (const [name, args, expected] of forms) {
    test(name, async () => {
      const { ctx, runId, cli } = await asking();
      const result = await cli(["ask", "--type", "text", ...args]);
      expect(result.err).toBe("");
      expect(listQuestions(ctx, runId)).toMatchObject([{ text: "Q?", blocks: expected }]);
    });
  }

  test("an unknown explicit value is refused", async () => {
    const { ctx, runId, cli } = await asking();
    for (const args of [["--blocks=all", "Q?"], ["--blocks=", "Q?"], ["Q?", "--blocks", "all"]]) {
      expect((await cli(["ask", "--type", "text", ...args])).code).toBe(2);
    }
    expect(listQuestions(ctx, runId)).toEqual([]);
  });

  test("the command line shipped in the question prompt parses", async () => {
    const prompt = await Bun.file(resolve(import.meta.dir, "../plugins/pacer-dev/prompts/questions.md")).text();
    expect(prompt).toContain('pacer ask --type <kind> [--option ...] [--recommend] [--blocks] [--artifact] --step <id> [--attempt <n>] "<text>"');
    const { ctx, runId, cli } = await asking();
    const result = await cli(["ask", "--type", "single", "--option", "a", "--option", "b", "--recommend", "a", "--blocks", "--step", "probe", "--attempt", "1", "Which?"]);
    expect(result.err).toBe("");
    expect(listQuestions(ctx, runId)).toMatchObject([{ blocks: "step", recommended: "a" }]);
  });
});

describe("MCP", () => {
  async function connect(ctx: Ctx) {
    const server = createMcpServer(() => ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const names = async () => (await client.listTools()).tools.map(t => t.name).sort();
    return { call, names, close: async () => { await client.close(); await server.close(); } };
  }

  for (const mode of MODES) {
    test(`${mode}: a step worker gets the step tools, served without the service`, async () => {
      const { ctx, runId, own, file } = await setup();
      const mcp = await connect(worker(ctx, own, credentials(ctx, own, mode)));
      try {
        expect(await mcp.names()).toEqual(expect.arrayContaining(["step_result", "step_artifact", "pacer_question"]));
        expect((await mcp.call("step_artifact", { path: file, label: "report" })).isError).toBeFalsy();
        expect((await mcp.call("pacer_question", { action: "ask", text: "Which?", answerType: "text" })).isError).toBeFalsy();
        expect((await mcp.call("pacer_question", { action: "answer", id: "q_aaaaaaaaaa", answer: "a", expect_rev: 1 })).isError).toBe(true);
        expect((await mcp.call("step_result", { result: { ok: true } })).isError).toBeFalsy();
        expect(stepByTask(ctx, own)!.result).toEqual({ ok: true });
        expect(listQuestions(ctx, runId)).toMatchObject([{ askerTaskId: own, status: "open" }]);
      } finally { await mcp.close(); }
    });
  }

  test("a granted task that is not a step gets no step tools", async () => {
    const { ctx } = await setup();
    const plain = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    registerWork(ctx, plain.id, { allowDelegation: true });
    updateTask(ctx, plain.id, t => { t.state = "running"; });
    const mcp = await connect(worker(ctx, plain.id, credentials(ctx, plain.id, "pwg")));
    try {
      const names = await mcp.names();
      for (const name of ["step_result", "step_artifact", "pacer_question"]) expect(names).not.toContain(name);
    } finally { await mcp.close(); }
  });
});

test("neither bearer reaches a step operation over HTTP, even if the service carries the task id", async () => {
  const { ctx, runId, own, file } = await setup();
  const creds = credentials(ctx, own, "both");
  const served = { ...ctx, env: { ...ctx.env, PACER_TASK_ID: own } };
  const server = startServer(() => served, { port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false });
  try {
    for (const bearer of Object.values(creds)) {
      for (const op of STEP_OPS) {
        const response = await fetch(`http://127.0.0.1:${server.port}/v3/ops/${op}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, host: `127.0.0.1:${server.port}` },
          body: JSON.stringify(params(op, file)),
        });
        expect(response.status).toBe(403);
        await response.body?.cancel();
      }
    }
    untouched(ctx, runId, own);
  } finally { server.stop(); }
});

// Strict work certifies headless launches only.
async function certifiedClaude(ctx: Ctx, strategy: Strategy, repo: string) {
  const binary = join(ctx.home, "claude-bin");
  writeFileSync(binary, "claude");
  ctx.which = name => name === "claude" ? binary : null;
  const previous = ctx.run;
  ctx.run = (argv, timeout, options) => argv[0] === binary
    ? Promise.resolve({ code: 0, stdout: "2.1.281 (Claude Code)", stderr: "" })
    : previous(argv, timeout, options);
  const resolved = await resolvePolicyRepoInput(ctx, repo);
  const target = await resolveEnforcementTarget(ctx, strategy, "claude-code", resolved.path);
  await certifyExecutor(ctx, target, async () => ({ attempted: true, blocked: true, childStarted: false, entries: ["Agent", "Task"] }));
}

test("the environment a real runner builds can report through the CLI", async () => {
  const { validateStrategy } = await import("../src/config/strategy");
  const { runTask } = await import("../src/tasks/runner");
  const { defaultHooks } = await import("../src/classify/hooks");
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const strategy = validateStrategy({
    execution: { launch_mode: "headless" }, planner: "codex",
    accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex", usage: "unmetered" } },
    runners: { "claude-code": { models: [{ id: "provider/deep", tier: "frontier" }] } }, dispatch: { timeoutMs: 5000 },
  }, "test");
  addDefinition(ctx, fan, "source");
  const run = await startRun(ctx, { workflow: "t/identity", repo: tmpDir(), brief: "B" }, undefined, deps());
  const step = stepsOfRun(ctx, run.id).find(s => s.branch === "alpha")!;
  const id = step.taskId!;
  await certifiedClaude(ctx, strategy, readTask(ctx, id)!.brief.repo);
  updateTask(ctx, getRun(ctx, run.id)!.rootTaskId!, t => { t.state = "running"; });
  const outputs: { code: number; stderr: string }[] = [];
  let seen: string[] = [];
  const settled = await runTask(ctx, id, {
    loadStrategy: () => strategy, hooks: defaultHooks,
    computeStatus: async statusCtx => ({
      generatedAt: statusCtx.now, strategy: "test", planner: "codex", mode: "normal", disabled: false, calendarPace: false,
      providers: [{ id: "claude-code", usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false }],
      executors: { ranked: [], excluded: [] },
    }),
    runAttempt: async (runCtx, cfg) => {
      const env: Record<string, string | undefined> = {
        ...executorEnv(runCtx.env, {}, id), PATH: process.env.PATH, HOME: ctx.home, PACER_HOME: ctx.pacerHome,
      };
      seen = ["PACER_ENFORCEMENT_TOKEN", "PACER_WORK_GRANT", "PACER_TASK_ID", "PACER_ROLE"].filter(name => env[name]);
      const evidence = runEvidenceDir(ctx, run.id);
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "report.txt"), "evidence");
      for (const argv of [
        ["step", "artifact", join(evidence, "report.txt"), "--label", "report"],
        ["ask", "--type", "text", "--blocks", "--step", "probe", "Which?"],
        ["step", "result", "--json", '{"ok":true}'],
      ]) {
        const result = await execProcess({ argv: [process.execPath, "src/cli.ts", ...argv], cwd: resolve(import.meta.dir, ".."), env, timeoutMs: 30_000 });
        outputs.push({ code: result.code, stderr: result.stderr });
      }
      return { exec: { code: 0, stdout: "ok", stderr: "", timedOut: false }, report: "ok", attempt: { executor: cfg.id, model: cfg.model, startedAt: ctx.now, endedAt: ctx.now + 1, exitCode: 0, timedOut: false, limitHit: false, log: "" } };
    },
    verifyRepo: async () => ({ files: "" }),
  });
  expect(seen).toEqual(["PACER_ENFORCEMENT_TOKEN", "PACER_WORK_GRANT", "PACER_TASK_ID", "PACER_ROLE"]);
  expect(outputs).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }, { code: 0, stderr: "" }]);
  expect(stepByTask(ctx, id)!.result).toEqual({ ok: true });
  expect(listArtifacts(ctx, run.id)).toHaveLength(1);
  expect(listQuestions(ctx, run.id)).toHaveLength(1);
  expect(["done", "needs_input"]).toContain(settled.state);
}, 120_000);
