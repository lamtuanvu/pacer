import {expect, test} from "bun:test";
import {join} from "node:path";
import {existsSync, readFileSync, readdirSync, statSync} from "node:fs";
import {DEFAULT_EXECUTION, type ExecutionCfg} from "../src/config/execution";
import {validateStrategy} from "../src/config/strategy";
import {selectBackend} from "../src/exec/backend";
import {makeOrcaBackend, type OrcaBackendDeps} from "../src/exec/orca/backend";
import {createTask, updateTask} from "../src/tasks/store";
import {fakeCtx} from "./helpers";
import {bindOrcaWorkSync, beginWorkSync, finishOrcaWorkSync, finishWorkSync, reserveIdle, releaseReservation} from "../src/update/desktop/admission";
import {loadOrcaState} from "../src/exec/orca/state";
import {reconcileHostWork, cleanHostWorktree} from "../src/exec/cleanup";
import {randomUUID} from "node:crypto";
import {fakeRun, raw, type Route} from "./fixtures/orca/fake";

const repo = "/work/app", terminal = "term_agent", dispatch = "ctx_1";
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
    [O("terminal", "create"), (a: string[]) => envelope({terminal: {handle: a.includes("--command") ? terminal : "term_coord", connected: true, writable: true, incarnationId: "inc"}})],
    [O("terminal", "show"), envelope({terminal: {handle: terminal, connected: true, writable: true, incarnationId: "inc"}})],
    [O("terminal", "close"), envelope({close: {handle: terminal, ptyKilled: true}})],
    [O("terminal", "wait"), envelope({wait: {satisfied: true, status: "running"}})],
    [O("worktree", "create"), (a: string[]) => envelope({worktree: {id: `repo-1::/work/${arg(a, "--name")}`, path: `/work/${arg(a, "--name")}`}})],
    [O("worktree", "show"), (a: string[]) => {
      const sel = arg(a, "--worktree");
      if (!sel.startsWith("id:")) return envelope({worktree: {id: `repo-1::${repo}`, path: repo}});
      const path = sel.slice(sel.indexOf("::") + 2);
      return envelope({worktree: {id: sel.slice(3), path, displayName: path.slice(path.lastIndexOf("/") + 1), isMainWorktree: false}});
    }],
    [O("worktree", "rm"), envelope({})],
    [O("orchestration", "worker-list"), envelope({workers: [], page: {hasMore: false}, scope: {run: "run_1"}})],
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
  const directLog = join(ctx.pacerHome, "direct.log");
  const backend = makeOrcaBackend({loadExecution: () => ({...DEFAULT_EXECUTION, ...execution}),
    direct: async () => {direct++; await Bun.write(directLog, ""); return {exec: {code: 0, stdout: "direct", stderr: "", timedOut: false}, report: "direct", backend: "direct", attempt: {executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: directLog}};},
    sliceMs: 10, sleep: async () => {}, ...deps});
  const root = `/work/pacer-${task.id}-codex`;
  return {f, ctx, task, backend, cfg: strategy.providers.codex, root, wt: `repo-1::${root}`, directLog, get direct() {return direct;}};
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
  expect(arg(calls[terminalCreate], "--worktree")).toBe(`id:${x.wt}`);
  const cmd = arg(calls[terminalCreate], "--command");
  expect(cmd).toContain(`PACER_TASK_ID=${x.task.id}`);
  expect(cmd).toContain("codex --no-daemon");
  expect(cmd).not.toContain("Fix the bug");
  expect(arg(calls[start], "--terminal")).toBe(terminal);
  expect(arg(calls[start], "--worktree")).toBe(`id:${x.wt}`);
  expect(calls[start]).not.toContain("--agent");
  expect(calls[start]).not.toContain("--model");
});

test("new child closes Orca's initial shell terminal before launching the agent", async () => {
  const x = setup([
    [O("worktree", "create"), (a: string[]) => envelope({worktree: {id: `repo-1::/work/${arg(a, "--name")}`}, terminal: {handle: "term_shell", incarnationId: "shell-inc"}})],
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
  expect(out.worktree).toBe(x.root);
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
  expect(out.report).toContain("Direct fallback was skipped");
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

const has = (calls: string[][], ...prefix: string[]) => calls.some(a => prefix.every((p, i) => a[i + 1] === p));
const closes = (calls: string[][]) => calls.filter(a => a[1] === "terminal" && a[2] === "close" && a.includes(terminal));
const lease = async (x: {ctx: import("../src/types").Ctx; task: {id: string}}) => {
  updateTask(x.ctx, x.task.id, task => {task.state = "done";});
  const id = randomUUID(), reserved = (await reserveIdle(x.ctx, id)).reserved;
  if (reserved) await releaseReservation(x.ctx, id);
  return !reserved;
};

test("Claude terminal commands set CLAUDE_CODE_SANDBOXED and write no Claude configuration; Codex commands do not", async () => {
  for (const id of ["claude-code", "codex"] as const) {
    const x = setup([[O("worktree", "create"), (a: string[]) => envelope({worktree: {id: `repo-1::/work/${arg(a, "--name")}`}})]]);
    const out = await x.backend.runAttempt(x.ctx, strategy.providers[id], x.task);
    expect(out.backend).toBe("orca");
    const cmd = arg(x.f.calls.find(a => a[2] === "create" && a.includes("--command"))!, "--command");
    expect(cmd.startsWith(`env PACER_ROLE=executor PACER_TASK_ID=${x.task.id}${id === "claude-code" ? " CLAUDE_CODE_SANDBOXED=1 claude " : " codex "}`)).toBe(true);
    expect(cmd.includes("CLAUDE_CODE_SANDBOXED")).toBe(id === "claude-code");
    expect(existsSync(join(x.ctx.home, ".claude.json"))).toBe(false);
    expect(existsSync(join(x.ctx.pacerHome, "orca", "trusted.json"))).toBe(false);
  }
});

test("no source path edits Claude folder trust", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]);
  const offenders = files(join(import.meta.dir, "..", "src")).filter(f => /hasTrustDialogAccepted|trusted\.json|claude-trust/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});

test("the attempt log records each Orca step", async () => {
  const x = setup();
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const text = readFileSync(out.attempt.log, "utf8");
  const order = [`worktree create ${x.wt}: ${x.root}`, `terminal create ${terminal}: env PACER_ROLE=executor PACER_TASK_ID=${x.task.id} codex `,
    `terminal wait ${terminal}: idle`, `worker-start ${dispatch}: ready`, `worker_done ${dispatch}: succeeded`, "worker-release: retained",
    `closed pacer terminal ${terminal}: ok`, "--- summary\ndone\n\nok"];
  const at = order.map(line => text.indexOf(line));
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

test("a fallback keeps the Orca steps in the direct attempt log", async () => {
  const x = setup([[O("terminal", "wait"), envelope({wait: {satisfied: false, blockedReason: "agent-trust-workspace"}})]]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const text = readFileSync(x.directLog, "utf8");
  expect(text).toContain(`terminal wait ${terminal}: agent-trust-workspace`);
  expect(text).toContain(`removed Orca worktree ${x.wt}`);
  expect(text).toContain("direct backend: Orca fallback (orca terminal did not become idle: agent-trust-workspace)");
});

for (const [name, over] of [
  ["initial terminal close", [[O("worktree", "create"), (a: string[]) => envelope({worktree: {id: `repo-1::/work/${arg(a, "--name")}`}, terminal: {handle: "term_shell"}})],
    [O("terminal", "close", "--terminal", "term_shell"), failure("close_failed")]]],
  ["terminal create", [[O("terminal", "create"), (a: string[]) => a.includes("--command") ? failure("create_failed") : envelope({terminal: {handle: "term_coord", connected: true, writable: true}})]]],
  ["idle wait", [[O("terminal", "wait"), envelope({wait: {satisfied: false, status: "timeout"}})]]],
  ["refused worker start", [[O("orchestration", "worker-start"), failure("task_not_startable")]]],
] as [string, Route[]][]) {
  test(`a ${name} failure removes the exact new worktree before direct fallback`, async () => {
    const x = setup(over);
    const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
    expect(out.backend).toBe("direct");
    const show = x.f.calls.findIndex(a => a[2] === "show" && arg(a, "--worktree") === `id:${x.wt}`);
    const rm = x.f.calls.findIndex(a => a[2] === "rm");
    expect(show).toBeGreaterThanOrEqual(0);
    expect(x.f.calls[rm]).toEqual(["orca", "worktree", "rm", "--worktree", `id:${x.wt}`, "--force", "--json"]);
    expect(show).toBeLessThan(rm);
    expect(loadOrcaState(x.ctx).stranded).toEqual({});
  });
}

test("a worktree that cannot be removed is recorded and removed by clean after review", async () => {
  const x = setup([[O("terminal", "wait"), failure("timeout")], [O("worktree", "rm"), failure("busy")]]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(loadOrcaState(x.ctx).stranded[x.task.id]).toMatchObject({id: x.wt, path: x.root, name: `pacer-${x.task.id}-codex`});
  updateTask(x.ctx, x.task.id, t => {t.state = "done"; t.review = {accepted: true, kind: null, note: null, at: 1};
    t.result = {status: "done", executor: "codex", model: null, files: "", report: "", backend: "direct"};});
  const f = fakeRun([
    [O("worktree", "show"), envelope({worktree: {id: x.wt, path: x.root, displayName: `pacer-${x.task.id}-codex`, isMainWorktree: false}})],
    [O("worktree", "rm"), envelope({})],
  ]);
  x.ctx.run = f.run;
  const t = (await import("../src/tasks/store")).readTask(x.ctx, x.task.id)!;
  expect(await cleanHostWorktree(x.ctx, t, {shared: () => false})).toBeNull();
  expect(f.calls.at(-1)).toEqual(["orca", "worktree", "rm", "--worktree", `id:${x.wt}`, "--json"]);
  expect(loadOrcaState(x.ctx).stranded).toEqual({});
});

for (const [name, over] of [
  ["wrong repository", (a: string[]) => envelope({worktree: {id: `repo-2::/work/${arg(a, "--name")}`}})],
  ["wrong name", () => envelope({worktree: {id: "repo-1::/work/other"}})],
  ["path differing from id", (a: string[]) => envelope({worktree: {id: `repo-1::/work/${arg(a, "--name")}`, path: "/elsewhere"}})],
] as const) {
  test(`a created worktree with a ${name} is neither used nor removed`, async () => {
    const x = setup([[O("worktree", "create"), over]]);
    const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
    expect(out.backend).toBe("direct");
    expect(x.f.calls.some(a => a.includes("--command") || a[2] === "worker-start" || a[2] === "rm")).toBe(false);
    expect(readFileSync(x.directLog, "utf8")).toContain("not removed: its identity is unverified");
  });
}

test("an existing placement resolving to another path falls back", async () => {
  const x = setup([[O("worktree", "show"), envelope({worktree: {id: "repo-1::/work/other", path: "/work/other"}})]], {worktree: "current"});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("direct");
  expect(x.f.calls.some(a => a.includes("--command"))).toBe(false);
});

for (const [name, reply] of [["timeout", failure("timeout")], ["malformed receipt", raw("not json")], ["missing dispatch id", envelope({state: "ready"})]] as const) {
  test(`an uncertain start (${name}) with no worker for the terminal closes it and releases the lease`, async () => {
    const x = setup([[O("orchestration", "worker-start"), reply]]);
    const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
    expect(x.direct).toBe(0);
    expect(out.backend).toBe("orca");
    expect(out.report).toContain("Orca did not create the worker");
    expect(x.f.count(O("orchestration", "worker-list", "--run", "run_1"))).toBe(3);
    expect(closes(x.f.calls)).toHaveLength(1);
    expect(has(x.f.calls, "worktree", "rm")).toBe(true);
    expect(await lease(x)).toBe(false);
  });
}

test("an uncertain start whose worker exists is supervised normally", async () => {
  const x = setup([[O("orchestration", "worker-start"), raw("not json")],
    [O("orchestration", "worker-list"), envelope({workers: [{dispatchId: "ctx_9", agentTerminalHandle: terminal, workerState: "ready"}], page: {hasMore: false}})]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(x.direct).toBe(0);
  expect(out.worktree).toBe(x.root);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-release", "--dispatch", "ctx_9", "--json"]);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(has(x.f.calls, "worktree", "rm")).toBe(false);
});

for (const [name, list] of [["failing lookup", failure("unavailable")], ["incomplete listing", envelope({workers: [], page: {hasMore: true}})]] as const) {
  test(`an uncertain start with a ${name} keeps the terminal, lease and recovery record; a later pass reconciles`, async () => {
    const x = setup([[O("orchestration", "worker-start"), failure("timeout")], [O("orchestration", "worker-list"), list]]);
    const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
    expect(x.direct).toBe(0);
    expect(out.report).toContain("cannot tell whether Orca created the worker");
    expect(closes(x.f.calls)).toHaveLength(0);
    expect(readFileSync(out.attempt.log, "utf8")).toContain(`kept terminal ${terminal} (run run_1)`);
    expect(loadOrcaState(x.ctx).uncertain[terminal]).toMatchObject({taskId: x.task.id, terminal, run: "run_1", worktree: {id: x.wt, path: x.root}});
    expect(await lease(x)).toBe(true);
    const later = fakeRun([
      [O("orchestration", "worker-list"), envelope({workers: [], page: {hasMore: false}})],
      [O("terminal", "close"), envelope({close: {handle: terminal, ptyKilled: true}})],
    ]);
    x.ctx.run = later.run;
    await reconcileHostWork(x.ctx);
    expect(closes(later.calls)).toHaveLength(1);
    expect(loadOrcaState(x.ctx).uncertain).toEqual({});
    expect(loadOrcaState(x.ctx).stranded[x.task.id]).toMatchObject({id: x.wt});
  });
}

test("admission bookkeeping exceptions never skip the exact terminal close", async () => {
  const boom = () => {throw Error("bookkeeping");};
  for (const admission of [
    {begin: beginWorkSync, bind: bindOrcaWorkSync, finishOrca: boom, finish: boom},
    {begin: beginWorkSync, bind: (...a: Parameters<typeof bindOrcaWorkSync>) => a[2].dispatchId === "pending" ? bindOrcaWorkSync(...a) : boom(), finishOrca: finishOrcaWorkSync, finish: finishWorkSync},
  ]) {
    const x = setup([[O("orchestration", "worker-release"), failure("dispatch_inactive")]], {}, {admission});
    const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
    expect(closes(x.f.calls)).toHaveLength(1);
    expect(readFileSync(out.attempt.log, "utf8")).toContain("failed: bookkeeping");
  }
});

test("a supervision exception still stops the worker and closes the terminal", async () => {
  const x = setup([[O("orchestration", "check"), () => {throw Error("check crashed");}]]);
  await expect(x.backend.runAttempt(x.ctx, x.cfg, x.task)).rejects.toThrow("check crashed");
  expect(has(x.f.calls, "orchestration", "worker-stop")).toBe(true);
  expect(closes(x.f.calls)).toHaveLength(1);
});

test("a retry from a worktree subdirectory accepts the containing worktree", async () => {
  const original = "/work/original";
  const x = setup([[O("worktree", "show"), envelope({worktree: {id: `repo-1::${original}`, path: original}})]]);
  x.task.retryOf = "prior-task";
  x.task.worktree = `${original}/pkg`;
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("orca");
  expect(out.worktree).toBe(`${original}/pkg`);
});
