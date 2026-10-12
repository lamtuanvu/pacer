import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_EXECUTION, type ExecutionCfg, ExecutionError } from "../src/config/execution";
import { validateStrategy } from "../src/config/strategy";
import type { ProviderStatus } from "../src/engine/rank";
import type { Status } from "../src/engine/status";
import { selectBackend } from "../src/exec/backend";
import { EXTRA_BACKENDS } from "../src/exec/backends-extra";
import type { AttemptOutcome } from "../src/exec/direct";
import { type OrcaBackendDeps, makeOrcaBackend, orcaBackend } from "../src/exec/orca/backend";
import { loadOrcaState, withLock } from "../src/exec/orca/state";
import { runTask } from "../src/tasks/runner";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { readMarks } from "../src/usage/reactive";
import { fakeCtx } from "./helpers";
import { type Route, fail, fakeRun, fixture, ok, raw } from "./fixtures/orca/fake";

const O = (...a: string[]) => ["orca", ...a];
const REPO = "/work/app";
const COORD = "term_1ddadcbd-780e-4951-b184-c51193ff39c6";
const RUN = "run_9d54b4f3810a";
const WT1 = "~/worktrees/pacer-exec-t1";
const AGENT_TERM = "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d";
const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

const s = validateStrategy({
  planner: "claude-code",
  providers: {
    "claude-code": {}, codex: {}, cursor: { model: "auto" },
    byteplus: { via: "opencode", model: "coding-plan/dola-seed-2.0-code", usage: "quota", quota_source: "arkcli" },
  },
}, "/x");

const directOut = (executor: string): AttemptOutcome => ({
  exec: { code: 0, stdout: "direct report", stderr: "", timedOut: false }, report: "direct report", backend: "direct",
  attempt: { executor, model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" },
});

function baseRoutes(): Route[] {
  return [
    [["git", "-C", REPO, "rev-parse"], raw(`${REPO}\nmain\n`)],
    [["git", "-C", REPO, "status"], raw("")],
    [O("status"), ok("status-ready.json")],
    [O("repo", "list"), ok("repo-list.json")],
    [O("repo", "add"), ok("repo-add.json")],
    [O("terminal", "create"), ok("coordinator-terminal.json")],
    [O("terminal", "show"), ok("terminal-show-live.json")],
    [O("terminal", "send"), ok("terminal-send.json")],
    [O("terminal", "close"), ok("terminal-close.json")],
    [O("orchestration", "run-create"), ok("run-create.json")],
    [O("orchestration", "run-show"), ok("run-show.json")],
    [O("orchestration", "worker-start"), ok("worker-start-t1-auto.json")],
    [O("orchestration", "check"), [ok("check-1.ndjson"), ok("ack-1.json")]],
    [O("orchestration", "worker-show"), ok("worker-show-succeeded.json")],
    [O("orchestration", "worker-read"), raw('{"ok":true,"result":{"terminal":{"tail":["Working"]}}}')],
    [O("orchestration", "worker-release"), ok("worker-release-t1.json")],
    [O("orchestration", "worker-stop"), ok("worker-stop-t8-cursor-limit.json")],
    [O("orchestration", "reply"), ok("reply.json")],
  ];
}

interface Holder { ctx: Ctx; taskId: string }

function setup(
  over: (h: Holder) => Route[] = () => [],
  opts: { provider?: string; exec?: Partial<ExecutionCfg>; timeoutS?: number; deps?: Partial<OrcaBackendDeps> } = {},
) {
  const h = {} as Holder;
  const f = fakeRun([...over(h), ...baseRoutes()]);
  const ctx = fakeCtx({ run: f.run });
  const task = createTask(ctx, { brief: { goal: "Fix the bug", repo: REPO, acceptance: "bun test" }, kind: null, requestedExecutor: null, timeoutS: opts.timeoutS ?? 600 });
  h.ctx = ctx;
  h.taskId = task.id;
  const direct: string[] = [];
  const backend = makeOrcaBackend({
    loadExecution: () => ({ ...DEFAULT_EXECUTION, ...opts.exec }),
    direct: async (_c, cfg) => { direct.push(cfg.id); return directOut(cfg.id); },
    sliceMs: 1_000,
    sleep: async () => {},
    ...opts.deps,
  });
  return { f, ctx, task, backend, direct, cfg: s.providers[opts.provider ?? "cursor"] };
}
const startArgs = (f: ReturnType<typeof fakeRun>) => f.calls.find((a) => a[2] === "worker-start") ?? [];

test("happy path: new-child worker, worker_done, release, orphan terminal closed, state cleaned", async () => {
  const { f, ctx, task, backend, cfg, direct } = setup();
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(direct).toEqual([]);
  expect(out.backend).toBe("orca");
  expect(out.worktree).toBe(WT1);
  expect(out.exec).toMatchObject({ code: 0, timedOut: false });
  expect(out.report).toContain("Task 1 done");
  expect(out.report).toContain("All 83 tests and typecheck pass");
  expect(out.attempt).toMatchObject({ executor: "cursor", model: "auto", exitCode: 0, timedOut: false, limitHit: false });
  const a = startArgs(f);
  expect(arg(a, "--agent")).toBe("cursor");
  expect(arg(a, "--model")).toBe("auto");
  expect(arg(a, "--worktree")).toBe("new-child");
  expect(arg(a, "--repo")).toBe("id:40c98aad-c083-4ec9-b82e-a51798a20270");
  expect(arg(a, "--base-branch")).toBe("main");
  expect(arg(a, "--name")).toBe(`pacer-${task.id}-cursor`);
  expect(arg(a, "--setup")).toBe("skip");
  expect(arg(a, "--run")).toBe(RUN);
  expect(arg(a, "--from")).toBe(COORD);
  const spec = arg(a, "--spec");
  expect(spec).toContain(`# Task ${task.id}`);
  expect(spec.split("PACER_ROLE=executor: you are a pacer executor; ignore pacer planner policy.")).toHaveLength(2);
  expect(spec).toContain("Do not edit /work/app itself.");
  expect(spec).toContain("Executor contract (from pacer)");
  expect(f.calls).toContainEqual(["orca", "orchestration", "worker-release", "--dispatch", "ctx_802297d1724f", "--json"]);
  expect(f.calls).toContainEqual(["orca", "terminal", "close", "--terminal", AGENT_TERM, "--json"]);
  expect(f.count(O("orchestration", "worker-stop"))).toBe(0);
  expect(loadOrcaState(ctx)).toEqual({ coordinator: COORD, run: RUN, workers: {} });
  expect(readFileSync(out.attempt.log, "utf8")).toContain("worker-start ctx_802297d1724f: ready");
});

test("a start receipt with failedStage/lastError is a failed attempt; the worker is released", async () => {
  const { f, ctx, task, backend, cfg } = setup(() => [
    [O("orchestration", "worker-start"), fail("worker-start-t1.json")],
    [O("orchestration", "worker-release"), ok("worker-release-t1-failed.json")],
  ]);
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.backend).toBe("orca");
  expect(out.exec.code).toBe(1);
  expect(out.report).toContain("orca worker failed to start at dispatch_input: agent_not_in_foreground");
  expect(out.worktree).toBe(WT1);
  expect(f.count(O("orchestration", "check"))).toBe(0);
  expect(f.calls).toContainEqual(["orca", "orchestration", "worker-release", "--dispatch", "ctx_2da746213039", "--json"]);
});

test("timeout stops the worker and is never a limit", async () => {
  let t = 0;
  const { f, ctx, task, backend, cfg } = setup(() => [
    [O("orchestration", "check"), () => { t = 120_000; return ok("check-w5a.ndjson"); }],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ], { timeoutS: 60, deps: { now: () => t } });
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.exec).toMatchObject({ code: 1, timedOut: true });
  expect(out.attempt).toMatchObject({ timedOut: true, limitHit: false });
  expect(out.report).toContain("timed out");
  expect(f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_802297d1724f", "--json"]);
  expect(f.count(O("orchestration", "worker-release"))).toBe(0);
});

test("stopping the task stops the worker", async () => {
  const { f, ctx, task, backend, cfg } = setup((h) => [
    [O("orchestration", "check"), () => { updateTask(h.ctx, h.taskId, (x) => { x.state = "stopped"; }); return ok("check-w5a.ndjson"); }],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ]);
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.exec.code).toBe(1);
  expect(out.report).toContain("stopped by the planner");
  expect(f.count(O("orchestration", "worker-stop"))).toBe(1);
});

test("a failed worker_done that reports a usage limit marks limitHit", async () => {
  const limited = fixture("check-1.ndjson")
    .replace('\\"outcome\\":\\"succeeded\\"', '\\"outcome\\":\\"failed\\"')
    .replace('"subject": "Task 1 done"', '"subject": "You have hit your usage limit"');
  const { ctx, task, backend, cfg } = setup(() => [[O("orchestration", "check"), [raw(limited), ok("ack-1.json")]], [O("orchestration", "worker-read"), ok("worker-read-tail.json")]]);
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.exec.code).toBe(1);
  expect(out.attempt.limitHit).toBe(true);
  expect(out.exec.stderr).toContain("usage limit");
});

test("release refused for an active worker falls back to worker-stop", async () => {
  const { f, ctx, task, backend, cfg } = setup(() => [[O("orchestration", "worker-release"), fail("worker-release-t1-freeplan.json")]]);
  await backend.runAttempt(ctx, cfg, task);
  expect(f.count(O("orchestration", "worker-stop"))).toBe(1);
});

test("dirty repo note: uncommitted changes are not in the new worktree", async () => {
  const { ctx, task, backend, cfg } = setup(() => [[["git", "-C", REPO, "status"], raw(" M src/a.ts\n")]]);
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.report).toContain("/work/app has uncommitted changes; the worker's new worktree starts from main without them");
});

test("a repo subdirectory maps into the worker's worktree", async () => {
  const { f, ctx, task, backend, cfg } = setup(() => [
    [["git", "-C", REPO, "rev-parse"], raw("/work\nmain\n")],
    [["git", "-C", "/work", "status"], raw("")],
  ]);
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.worktree).toBe(`${WT1}/app`);
  expect(arg(startArgs(f), "--spec")).toContain("Work in its app/ subdirectory");
});

test("worktree current: the repo itself, no creation flags; OpenCode providers get their model", async () => {
  const { f, ctx, task, backend, cfg } = setup(() => [], { provider: "byteplus", exec: { worktree: "current" } });
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.backend).toBe("orca");
  expect(out.worktree).toBe(REPO);
  const a = startArgs(f);
  expect(arg(a, "--agent")).toBe("opencode");
  expect(arg(a, "--model")).toBe("coding-plan/dola-seed-2.0-code");
  expect(arg(a, "--worktree")).toBe("path:/work/app");
  expect(a).not.toContain("--name");
  expect(a).not.toContain("--base-branch");
  expect(arg(a, "--spec")).toContain("## Repository\n/work/app");
});

test("falls back to direct when the Orca runtime is not ready", async () => {
  const { f, ctx, task, backend, cfg, direct } = setup(() => [[O("status"), ok("status-down.json")]]);
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(direct).toEqual(["cursor"]);
  expect(out.backend).toBe("direct");
  expect(out.report.startsWith("(orca backend not used: the Orca runtime is not ready")).toBe(true);
  expect(out.report).toContain("direct report");
  expect(f.count(O("orchestration", "worker-start"))).toBe(0);
});

test("falls back to direct for an OpenCode provider with new-child, without calling orca or git", async () => {
  const { f, ctx, task, backend, cfg, direct } = setup(() => [], { provider: "byteplus" });
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(direct).toEqual(["byteplus"]);
  expect(out.report).toContain("existing worktree");
  expect(f.calls).toHaveLength(0);
});

test("falls back to direct when the repo is not git, or HEAD is detached without base_branch", async () => {
  const a = setup(() => [[["git", "-C", REPO, "rev-parse"], raw("", 128, "fatal: not a git repository")]]);
  const outA = await a.backend.runAttempt(a.ctx, a.cfg, a.task);
  expect(outA.backend).toBe("direct");
  expect(outA.report).toContain("is not a git repository");
  const b = setup(() => [[["git", "-C", REPO, "rev-parse"], raw(`${REPO}\nHEAD\n`)]]);
  const outB = await b.backend.runAttempt(b.ctx, b.cfg, b.task);
  expect(outB.report).toContain("detached HEAD");
  const c = setup(() => [[["git", "-C", REPO, "rev-parse"], raw(`${REPO}\nHEAD\n`)]], { exec: { baseBranch: "main" } });
  const outC = await c.backend.runAttempt(c.ctx, c.cfg, c.task);
  expect(outC.backend).toBe("orca");
  expect(arg(startArgs(c.f), "--base-branch")).toBe("main");
});

test("falls back to direct on an invalid execution section or a refused worker-start", async () => {
  const a = setup(() => [], { deps: { loadExecution: () => { throw new ExecutionError(['execution.backend must be one of auto, orca, direct (got "x")']); } } });
  const outA = await a.backend.runAttempt(a.ctx, a.cfg, a.task);
  expect(outA.backend).toBe("direct");
  expect(outA.report).toContain("invalid execution section");
  const b = setup(() => [[O("orchestration", "worker-start"), raw('{"ok":false,"error":{"code":"task_not_startable","message":"Task cannot start now."}}', 1)]]);
  const outB = await b.backend.runAttempt(b.ctx, b.cfg, b.task);
  expect(outB.backend).toBe("direct");
  expect(outB.report).toContain("task_not_startable");
});

test("available: needs execution.backend auto|orca and a ready runtime", async () => {
  const strat = (execution: Record<string, unknown>) => validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} }, execution }, "/x");
  const ready = fakeCtx({ run: fakeRun([[O("status"), ok("status-ready.json")]]).run });
  const down = fakeCtx({ run: fakeRun([[O("status"), ok("status-down.json")]]).run });
  const none = fakeRun([]);
  expect(await orcaBackend.available(ready, strat({}))).toBe(true);
  expect(await orcaBackend.available(ready, strat({ backend: "orca" }))).toBe(true);
  expect(await orcaBackend.available(down, strat({}))).toBe(false);
  expect(await orcaBackend.available(fakeCtx({ run: none.run }), strat({ backend: "direct" }))).toBe(false);
  expect(none.calls).toHaveLength(0);
  await expect(orcaBackend.available(ready, strat({ backend: "x" }))).rejects.toThrow(ExecutionError);
});

test("registered as the extra backend; selectBackend picks it only when Orca is ready", async () => {
  expect(EXTRA_BACKENDS.map((b) => b.id)).toEqual(["orca"]);
  const strat = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");
  const ready = fakeCtx({ run: fakeRun([[O("status"), ok("status-ready.json")]]).run });
  const down = fakeCtx({ run: fakeRun([[O("status"), raw("", 127)]]).run });
  expect((await selectBackend(ready, strat)).id).toBe("orca");
  expect((await selectBackend(down, strat)).id).toBe("direct");
});

const statusFor = (id: string): Status => ({
  generatedAt: 0, strategy: "d", planner: "claude-code", mode: "normal", disabled: false, calendarPace: true,
  executors: { ranked: [], excluded: [] },
  providers: [{ id, usage: "reactive", windows: [], binding: null, verdict: "OK", installed: true, stale: false } as ProviderStatus],
});

test("through the runner: the result records backend orca and verification runs in the worker's worktree", async () => {
  const { ctx, task, backend } = setup();
  const s1 = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, cursor: { model: "auto" } } }, "/x");
  const verified: string[] = [];
  const rec = await runTask(ctx, task.id, {
    loadStrategy: () => s1,
    computeStatus: async () => statusFor("cursor"),
    runAttempt: backend.runAttempt,
    verifyRepo: async (repo) => { verified.push(repo); return { files: " src/a.ts | 2 +-" }; },
  });
  expect(verified).toEqual([WT1]);
  expect(rec.result).toMatchObject({ status: "done", executor: "cursor", backend: "orca", worktree: WT1 });
  expect(rec.attempts).toHaveLength(1);
});


test("pre-dispatch runtime exceptions fall back to direct", async () => {
  for (const prefix of [O("status"), O("repo", "list"), O("orchestration", "run-create")]) {
    const { ctx, task, backend, cfg, direct } = setup(() => [
      [prefix, () => { throw new Error("runtime connection lost"); }],
    ]);
    const out = await backend.runAttempt(ctx, cfg, task);
    expect(out.backend).toBe("direct");
    expect(out.report).toContain("runtime connection lost");
    expect(direct).toEqual(["cursor"]);
  }
});

test("worker-start holds no coordinator lock and registration waits for the lock", async () => {
  let held: Promise<void> | undefined;
  let unlock: (() => void) | undefined;
  let registrationChecked = false;
  const { ctx, task, backend, cfg } = setup((h) => [
    [O("orchestration", "worker-start"), () => {
      expect(existsSync(join(h.ctx.pacerHome, "orca", "coordinator.lock"))).toBe(false);
      held = withLock(h.ctx, "coordinator", async () => {
        await new Promise<void>((resolve) => { unlock = resolve; });
      });
      return ok("worker-start-t1-auto.json");
    }],
  ]);
  const pending = backend.runAttempt(ctx, cfg, task);
  for (let i = 0; i < 100 && !unlock; i++) await Bun.sleep(1);
  try {
    expect(unlock).toBeDefined();
    await Bun.sleep(10);
    expect(loadOrcaState(ctx).workers).toEqual({});
    registrationChecked = true;
  } finally {
    unlock?.();
    await held;
    await pending;
  }
  expect(registrationChecked).toBe(true);
  expect(loadOrcaState(ctx).workers).toEqual({});
});

test("settled workers without a report map their state and release", async () => {
  for (const [receipt, code] of [["worker-show-succeeded.json", 0], ["worker-show-failed.json", 1]] as const) {
    const { f, ctx, task, backend, cfg } = setup(() => [
      [O("orchestration", "check"), ok("check-w5a.ndjson")],
      [O("orchestration", "worker-show"), ok(receipt)],
    ]);
    const out = await backend.runAttempt(ctx, cfg, task);
    expect(out.exec).toMatchObject({ code, timedOut: false });
    expect(out.report).toContain("without a worker_done report");
    expect(f.count(O("orchestration", "worker-release"))).toBe(1);
    expect(f.count(O("orchestration", "worker-stop"))).toBe(0);
    expect(f.count(O("orchestration", "worker-read"))).toBeGreaterThan(0);
  }
});

test("an idle worker with a usage limit fails early and is stopped even if release would succeed", async () => {
  let t = 0;
  const { f, ctx, task, backend, cfg, direct } = setup(() => [
    [O("orchestration", "check"), () => { t += 1_000; return ok("check-w5a.ndjson"); }],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
    [O("orchestration", "worker-read"), [ok("worker-read-tail.json"), raw('{"ok":true,"result":{"terminal":{"tail":[]}}}')]],
  ], { deps: { now: () => t } });
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.exec).toMatchObject({ code: 1, timedOut: false });
  expect(out.attempt.limitHit).toBe(true);
  expect(out.exec.stderr).toContain("usage limit");
  expect(t).toBeLessThan(10_000);
  expect(direct).toEqual([]);
  expect(f.count(O("orchestration", "worker-stop"))).toBe(1);
});

for (const busy of [false, true]) {
  test(`limit words in the dispatched goal do not stop the worker (busy: ${busy})`, async () => {
    const { f, ctx, task, backend, cfg } = setup(() => [
      [O("orchestration", "check"), [ok("check-w5a.ndjson"), ok("check-1.ndjson"), ok("ack-1.json")]],
      [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
      [O("orchestration", "worker-read"), () => raw(JSON.stringify({
        ok: true, result: { terminal: { tail: [
          `> ${arg(startArgs(f), "--spec").split("\n").find((line) => line.includes("rate limit exceeded"))}`,
          busy ? "Working (esc to interrupt)" : "Ready",
        ] } },
      }))],
    ]);
    task.brief.goal = "Fix rate limit exceeded errors";
    const out = await backend.runAttempt(ctx, cfg, task);
    expect(out.exec).toMatchObject({ code: 0, timedOut: false });
    expect(out.attempt.limitHit).toBe(false);
    expect(f.count(O("orchestration", "worker-read"))).toBe(1);
    expect(f.count(O("orchestration", "worker-stop"))).toBe(0);
  });
}

for (const indicator of ["esc to interrupt", "ctrl+c to stop", "terminal preview"]) {
  test(`worker output about 429 while working does not stop it (${indicator})`, async () => {
    const { f, ctx, task, backend, cfg } = setup(() => [
      [O("orchestration", "check"), [ok("check-w5a.ndjson"), ok("check-1.ndjson"), ok("ack-1.json")]],
      [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
      [O("orchestration", "worker-read"), raw(JSON.stringify({
        ok: true, result: { terminal: { tail: ["Investigating HTTP 429 handling", indicator] } },
      }))],
      ...(indicator === "terminal preview" ? [[O("terminal", "show"), ok("terminal-show-working.json")] as Route] : []),
    ]);
    const out = await backend.runAttempt(ctx, cfg, task);
    expect(out.exec).toMatchObject({ code: 0, timedOut: false });
    expect(out.attempt.limitHit).toBe(false);
    expect(f.count(O("orchestration", "worker-read"))).toBe(1);
    expect(f.count(O("orchestration", "worker-stop"))).toBe(0);
  });
}

test("a limit message outside the last 15 terminal lines does not stop the worker", async () => {
  const { f, ctx, task, backend, cfg } = setup(() => [
    [O("orchestration", "check"), [ok("check-w5a.ndjson"), ok("check-1.ndjson"), ok("ack-1.json")]],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
    [O("orchestration", "worker-read"), raw(JSON.stringify({
      ok: true, result: { terminal: { tail: ["HTTP 429", ...Array(15).fill("Checked another file")] } },
    }))],
  ]);
  const out = await backend.runAttempt(ctx, cfg, task);
  expect(out.exec.code).toBe(0);
  expect(out.attempt.limitHit).toBe(false);
  expect(f.count(O("orchestration", "worker-stop"))).toBe(0);
});

for (const waitFails of [false, true]) {
  test(`a registration lock failure still supervises the worker (wait failure: ${waitFails})`, async () => {
    const original = new Error("wait connection lost");
    const { f, ctx, task, backend, cfg } = setup((h) => [
      [O("orchestration", "worker-start"), () => {
        const dir = join(h.ctx.pacerHome, "orca");
        rmSync(dir, { recursive: true, force: true });
        writeFileSync(dir, "block lock creation");
        return ok("worker-start-t1-auto.json");
      }],
      [O("orchestration", "check"), () => {
        if (waitFails) throw original;
        return ok("check-w5a.ndjson");
      }],
    ]);
    try {
      if (waitFails) {
        await expect(backend.runAttempt(ctx, cfg, task)).rejects.toBe(original);
        expect(f.count(O("orchestration", "worker-stop"))).toBe(1);
      } else {
        const out = await backend.runAttempt(ctx, cfg, task);
        expect(out.exec.code).toBe(0);
        expect(readFileSync(out.attempt.log, "utf8")).toContain("registration failed");
        expect(f.count(O("orchestration", "worker-release"))).toBe(1);
      }
      expect(f.count(O("orchestration", "check"))).toBeGreaterThan(0);
    } finally {
      rmSync(join(ctx.pacerHome, "orca"), { force: true });
    }
  });
}

for (const response of [
  raw("", 124, "worker-start timed out"),
  raw("not JSON", 0),
  raw('{"ok":false,"error":{"code":"timeout","message":"worker-start timed out"}}', 1),
  raw('{"ok":true,"result":{"state":"ready"}}'),
  () => { throw new Error("worker-start connection lost"); },
]) {
  test("an ambiguous worker-start fails without launching a duplicate direct attempt", async () => {
    const { f, ctx, task, backend, cfg, direct } = setup(() => [[O("orchestration", "worker-start"), response]]);
    const out = await backend.runAttempt(ctx, cfg, task);
    expect(out.backend).toBe("orca");
    expect(out.exec).toMatchObject({ code: 1, timedOut: false });
    expect(out.attempt.limitHit).toBe(false);
    expect(out.report).toContain("cannot tell whether Orca created the worker");
    expect(direct).toEqual([]);
    expect(f.count(O("orchestration", "worker-start"))).toBe(1);
  });
}

test("a new-child receipt without a worktree fails the task without verifying the original repo", async () => {
  const receipt = JSON.parse(fixture("worker-start-t1-auto.json"));
  receipt.result.effects = receipt.result.effects.filter((e: { kind: string }) => e.kind !== "worktree");
  const { f, ctx, task, backend, direct } = setup(() => [
    [O("orchestration", "worker-start"), raw(JSON.stringify(receipt))],
  ]);
  const verified: string[] = [];
  const rec = await runTask(ctx, task.id, {
    loadStrategy: () => validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, cursor: {} } }, "/x"),
    computeStatus: async () => statusFor("cursor"),
    runAttempt: backend.runAttempt,
    verifyRepo: async (repo) => { verified.push(repo); return { files: "" }; },
  });
  expect(rec.result?.status).toBe("failed");
  expect(rec.result?.report).toContain("worktree path");
  expect(verified).toEqual([]);
  expect(direct).toEqual([]);
  expect(f.count(O("orchestration", "worker-stop"))).toBe(1);
  expect(f.count(O("orchestration", "check"))).toBe(0);
  expect(loadOrcaState(ctx).workers).toEqual({});
});


test("an idle worker limit marks the executor exhausted and the runner tries the next executor", async () => {
  let t = 0;
  const { f, ctx, task, backend, direct } = setup(() => [
    [O("orchestration", "check"), [
      () => { t += 1_000; return ok("check-w5a.ndjson"); },
      ok("check-1.ndjson"), ok("ack-1.json"),
    ]],
    [O("orchestration", "worker-read"), ok("worker-read-tail.json")],
  ], { deps: { now: () => t } });
  const st = statusFor("codex");
  st.providers.push(...statusFor("cursor").providers);
  const verified: string[] = [];
  const rec = await runTask(ctx, task.id, {
    loadStrategy: () => validateStrategy({
      planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} }, pacing: { policy: "priority" },
    }, "/x"),
    computeStatus: async () => st,
    runAttempt: backend.runAttempt,
    verifyRepo: async (repo) => { verified.push(repo); return { files: "" }; },
  });
  expect(rec.result).toMatchObject({ status: "done", executor: "cursor", backend: "orca" });
  expect(rec.attempts.map((a) => [a.executor, a.limitHit])).toEqual([["codex", true], ["cursor", false]]);
  expect(readMarks(ctx).codex).toBeGreaterThan(Date.now() / 1000);
  expect(verified).toEqual([WT1]);
  expect(direct).toEqual([]);
  expect(f.count(O("orchestration", "worker-stop"))).toBe(1);
});
