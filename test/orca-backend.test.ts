import {expect, test} from "bun:test";
import {join} from "node:path";
import {readFileSync} from "node:fs";
import {DEFAULT_EXECUTION, type ExecutionCfg} from "../src/config/execution";
import {validateStrategy} from "../src/config/strategy";
import {selectBackend} from "../src/exec/backend";
import {makeOrcaBackend, type OrcaBackendDeps} from "../src/exec/orca/backend";
import {createTask, updateTask} from "../src/tasks/store";
import {fakeCtx} from "./helpers";
import {reserveIdle, releaseReservation} from "../src/update/desktop/admission";
import {randomUUID} from "node:crypto";
import {fakeRun, raw, type Route} from "./fixtures/orca/fake";

const repo = "/work/app", root = "/work/new", wt = `repo-1::${root}`, terminal = "term_agent", dispatch = "ctx_1";
const O = (...args: string[]) => ["orca", ...args];
const envelope = (result: object) => raw(JSON.stringify({ok: true, result}));
const failure = (code: string) => raw(JSON.stringify({ok: false, error: {code, message: code}}), 1);
const strategy = validateStrategy({planner: "claude-code", providers: {"claude-code": {}, codex: {}}}, "/x");
const arg = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

function setup(over: Route[] = [], execution: Partial<ExecutionCfg> = {}, deps: Partial<OrcaBackendDeps> = {}) {
  const routes: Route[] = [
    [["git", "-C", repo, "rev-parse", "--verify"], raw("a".repeat(40))],
    [["git", "-C", repo, "rev-parse"], raw(`${repo}\nmain\n`)],
    [["git", "-C", repo, "status"], raw("")],
    [["git", "-C", repo, "fetch"], raw("")],
    [["git", "-C", repo, "ls-remote"], raw("ref: refs/heads/main\tHEAD\n")],
    [O("status"), envelope({runtime: {state: "ready", reachable: true}})],
    [O("repo", "list"), envelope({repos: [{id: "repo-1", path: repo}]})],
    [O("terminal", "create", "--worktree", `id:${wt}`), envelope({terminal: {handle: terminal, connected: true, writable: true, incarnationId: "inc"}})],
    [O("terminal", "create", "--worktree", `id:repo-1::${repo}`), envelope({terminal: {handle: terminal, connected: true, writable: true, incarnationId: "inc"}})],
    [O("terminal", "create"), envelope({terminal: {handle: "term_coord", connected: true, writable: true, incarnationId: "inc"}})],
    [O("terminal", "show"), envelope({terminal: {handle: terminal, connected: true, writable: true, incarnationId: "inc"}})],
    [O("terminal", "close"), envelope({close: {handle: terminal, ptyKilled: true}})],
    [O("terminal", "wait"), envelope({wait: {satisfied: true, status: "running"}})],
    [O("worktree", "create"), envelope({worktree: {id: wt, path: root}})],
    [O("worktree", "show"), envelope({worktree: {id: `repo-1::${repo}`, path: repo}})],
    [O("orchestration", "run-create"), envelope({run: {id: "run_1", coordinator_handle: "term_coord"}})],
    [O("orchestration", "run-show"), envelope({run: {id: "run_1", coordinator_handle: "term_coord"}})],
    [O("orchestration", "worker-start"), envelope({dispatchId: dispatch, state: "ready", effects: []})],
    [O("orchestration", "check"), envelope({messages: [{id: "m1", type: "worker_done", subject: "done", body: "ok", payload: JSON.stringify({taskId: "TASK", dispatchId: dispatch, outcome: "succeeded"})}], deliveryId: "d1"})],
    [O("orchestration", "worker-show"), envelope({worker: {state: "succeeded"}})],
    [O("orchestration", "worker-read"), envelope({terminal: {tail: ["ok"]}})],
    [O("orchestration", "worker-release"), envelope({dispatchId: dispatch, state: "retained", processAction: "none"})],
    [O("orchestration", "worker-stop"), envelope({dispatchId: dispatch, state: "stopped", processAction: "none"})],
  ];
  const f = fakeRun([...over, ...routes]);
  const ctx = fakeCtx({run: f.run});
  const task = createTask(ctx, {brief: {goal: "Fix the bug", repo}, kind: null, requestedExecutor: null, timeoutS: 1});
  let direct = 0;
  const backend = makeOrcaBackend({loadExecution: () => ({...DEFAULT_EXECUTION, ...execution}),
    direct: async () => {direct++; return {exec: {code: 0, stdout: "direct", stderr: "", timedOut: false}, report: "direct", backend: "direct", attempt: {executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: ""}};},
    sliceMs: 10, sleep: async () => {}, ...deps});
  return {f, ctx, task, backend, cfg: strategy.providers.codex, get direct() {return direct;}};
}

test("new child worktree is created before agent terminal and worker attaches after idle", async () => {
  expect(typeof selectBackend).toBe("function");
  const x = setup();
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const calls = x.f.calls;
  const create = calls.findIndex(a => a[1] === "worktree" && a[2] === "create");
  const terminalCreate = calls.findIndex(a => a[1] === "terminal" && a[2] === "create" && a.includes("--command"));
  const wait = calls.findIndex(a => a[1] === "terminal" && a[2] === "wait");
  const start = calls.findIndex(a => a[1] === "orchestration" && a[2] === "worker-start");
  expect(create).toBeGreaterThanOrEqual(0);
  expect(create).toBeLessThan(terminalCreate);
  expect(terminalCreate).toBeLessThan(wait);
  expect(wait).toBeLessThan(start);
  expect(arg(calls[create], "--repo")).toBe("id:repo-1");
  expect(arg(calls[terminalCreate], "--worktree")).toBe(`id:${wt}`);
  const cmd = arg(calls[terminalCreate], "--command");
  expect(cmd).toContain(`PACER_TASK_ID=${x.task.id}`);
  expect(cmd).toContain("codex --no-daemon");
  expect(cmd).not.toContain("Fix the bug");
  expect(arg(calls[start], "--terminal")).toBe(terminal);
  expect(arg(calls[start], "--worktree")).toBe(`id:${wt}`);
  expect(calls[start]).not.toContain("--agent");
  expect(calls[start]).not.toContain("--model");
});

test("new child closes Orca's initial shell terminal before launching the agent", async () => {
  const x = setup([
    [O("worktree", "create"), envelope({worktree: {id: wt, path: root}, terminal: {handle: "term_shell", incarnationId: "shell-inc"}})],
    [O("terminal", "close", "--terminal", "term_shell"), envelope({close: {handle: "term_shell", ptyKilled: true}})],
  ]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const closed = x.f.calls.findIndex(a => a[1] === "terminal" && a[2] === "close" && a.includes("term_shell"));
  const launched = x.f.calls.findIndex(a => a[1] === "terminal" && a[2] === "create" && a.includes("--command"));
  expect(closed).toBeGreaterThanOrEqual(0);
  expect(closed).toBeLessThan(launched);
});

test("current placement resolves a worktree id", async () => {
  const x = setup([], {worktree: "current"});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "create")).toBe(false);
  expect(out.worktree).toBe(repo);
  expect(arg(x.f.calls.find(a => a[2] === "worker-start")!, "--worktree")).toBe(`id:repo-1::${repo}`);
});

for (const result of [envelope({wait: {satisfied: false, status: "timeout"}}), envelope({wait: {satisfied: false, blockedReason: "agent-trust-workspace"}}), failure("timeout")]) {
  test("non-idle agent closes terminal and falls back without worker", async () => {
    const x = setup([[O("terminal", "wait"), result]]);
    const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
    expect(out.backend).toBe("direct");
    expect(x.direct).toBe(1);
    expect(x.f.calls.some(a => a[2] === "worker-start")).toBe(false);
    expect(x.f.calls).toContainEqual(["orca", "terminal", "close", "--terminal", terminal, "--json"]);
  });
}

test("terminal is closed after worker release", async () => {
  const x = setup();
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("orca");
  expect(out.worktree).toBe(root);
  expect(x.f.calls.filter(a => a[1] === "terminal" && a[2] === "close")).toEqual([["orca", "terminal", "close", "--terminal", terminal, "--json"]]);
  expect(readFileSync(out.attempt.log, "utf8")).toContain(`closed pacer terminal ${terminal}: ok`);
  updateTask(x.ctx, x.task.id, task => {task.state = "done";});
  const reservation = randomUUID();
  expect((await reserveIdle(x.ctx, reservation)).reserved).toBe(true);
  await releaseReservation(x.ctx, reservation);
});

test("an unverified close receipt names the terminal and retains admission", async () => {
  const x = setup([[O("terminal", "close", "--terminal", terminal), envelope({closed: true})]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(readFileSync(out.attempt.log, "utf8")).toContain(`closed pacer terminal ${terminal}: close receipt lacks exact handle`);
  updateTask(x.ctx, x.task.id, task => {task.state = "done";});
  expect((await reserveIdle(x.ctx, randomUUID())).reserved).toBe(false);
});

test("unsupported agents fall back before Orca calls", async () => {
  const x = setup();
  const cursor = validateStrategy({planner: "claude-code", providers: {"claude-code": {}, cursor: {}}}, "/x").providers.cursor;
  const out = await x.backend.runAttempt(x.ctx, cursor, x.task);
  expect(out.backend).toBe("direct");
  expect(x.f.calls).toHaveLength(0);
  expect(readFileSync(join(x.ctx.pacerHome, "orca", "fallback.log"), "utf8")).toContain("not supported");
});

test("a worker timeout stops the dispatch and closes the owned terminal", async () => {
  let now = 0;
  const x = setup([
    [O("orchestration", "check"), () => {now = 2_000; return envelope({messages: []});}],
    [O("orchestration", "worker-show"), envelope({worker: {state: "ready"}})],
  ], {}, {now: () => now});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.exec.timedOut).toBe(true);
  expect(x.f.calls.some(a => a[2] === "worker-stop")).toBe(true);
  expect(x.f.calls).toContainEqual(["orca", "terminal", "close", "--terminal", terminal, "--json"]);
});

test("a refused worker start closes the terminal before direct fallback", async () => {
  const x = setup([[O("orchestration", "worker-start"), failure("task_not_startable")]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("direct");
  expect(x.direct).toBe(1);
  expect(x.f.calls).toContainEqual(["orca", "terminal", "close", "--terminal", terminal, "--json"]);
});

test("a refused start reports an unclosed terminal handle", async () => {
  const x = setup([
    [O("orchestration", "worker-start"), failure("task_not_startable")],
    [O("terminal", "close", "--terminal", terminal), failure("close_failed")],
  ]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(x.f.calls.filter(a => a[1] === "terminal" && a[2] === "close")).toHaveLength(2);
  expect(readFileSync(join(x.ctx.pacerHome, "orca", "fallback.log"), "utf8")).toContain(`terminal close failed ${terminal}`);
});

test("an uncertain worker start never launches direct work", async () => {
  const x = setup([[O("orchestration", "worker-start"), failure("timeout")]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("orca");
  expect(out.report).toContain("cannot tell whether Orca created the worker");
  expect(x.direct).toBe(0);
});

test("release refusal leads to worker stop, then closes the exact terminal", async () => {
  const x = setup([[O("orchestration", "worker-release"), failure("dispatch_inactive")]]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(x.f.calls.some(a => a[2] === "worker-stop")).toBe(true);
  expect(x.f.calls.filter(a => a[1] === "terminal" && a[2] === "close")).toEqual([["orca", "terminal", "close", "--terminal", terminal, "--json"]]);
});

test("planner stop is supervised through worker-stop", async () => {
  const x = setup();
  updateTask(x.ctx, x.task.id, task => {task.state = "stopped";});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.report).toContain("stopped by the planner");
  expect(x.f.calls.some(a => a[2] === "worker-stop")).toBe(true);
});

test("usage limit in worker output stops the worker and marks the attempt", async () => {
  const x = setup([
    [O("orchestration", "check"), envelope({messages: []})],
    [O("orchestration", "worker-read"), envelope({terminal: {tail: ["Error: rate limit reached"]}})],
    [O("orchestration", "worker-show"), envelope({worker: {state: "ready"}})],
  ]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.attempt.limitHit).toBe(true);
  expect(x.f.calls.some(a => a[2] === "worker-stop")).toBe(true);
});

test("dirty current placement is refused before Orca creates a worktree", async () => {
  const x = setup([[["git", "-C", repo, "status"], raw(" M file\n")]], {worktree: "current"});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("orca");
  expect(out.report).toContain("uncommitted changes");
  expect(x.f.calls.some(a => a[1] === "worktree")).toBe(false);
});

test("a retry resolves the original worktree instead of creating another", async () => {
  const original = "/work/original";
  const x = setup([[O("worktree", "show"), envelope({worktree: {id: `repo-1::${original}`, path: original}})]]);
  x.task.retryOf = "prior-task";
  x.task.worktree = original;
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.worktree).toBe(original);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "create")).toBe(false);
  expect(arg(x.f.calls.find(a => a[2] === "worker-start")!, "--worktree")).toBe(`id:repo-1::${original}`);
});
