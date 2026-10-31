import {afterEach, expect, test} from "bun:test";
import {join} from "node:path";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {DEFAULT_EXECUTION, type ExecutionCfg} from "../src/config/execution";
import {validateStrategy} from "../src/config/strategy";
import {selectBackend} from "../src/exec/backend";
import {makeOrcaBackend as makeRoute, type OrcaRouteDeps as OrcaBackendDeps} from "../src/plugins/executor-orca";
import {inProcessOrca, sourcePluginRegistry} from "./fixtures/orca/in-process";
import {shutdownPlugins} from "../src/plugins";
import type {Ctx} from "../src/types";
import type {HostClient} from "@pacer/plugin";
/** The production Orca route with the bundled provider served in this process, so the test clock reaches its lookups. */
const makeOrcaBackend = (deps: Partial<OrcaBackendDeps> = {}, provider: Parameters<typeof inProcessOrca>[0] = {}) =>
  makeRoute(deps, inProcessOrca({sleep: deps.sleep ?? (async () => {}), ...provider}));
import {createTask, readTask, updateTask} from "../src/tasks/store";
import { progressBase } from "../src/tasks/types";
import {fakeCtx} from "./helpers";
import {bindOrcaWorkSync, beginWorkSync, finishOrcaWorkSync, finishWorkSync, reserveIdle, releaseReservation} from "../src/update/desktop/admission";
import {loadOrcaState, updateOrcaState} from "../src/exec/orca/state";
import {reconcileHostWork, cleanHostWorktree} from "../src/exec/cleanup";
import {randomUUID} from "node:crypto";
import {fakeRun, raw, type Route} from "./fixtures/orca/fake";
import {readActivity} from "../src/activity/log";

const repo = "/work/app", terminal = "term_agent", dispatch = "ctx_1";
const O = (...args: string[]) => ["orca", ...args];
const envelope = (result: object) => raw(JSON.stringify({ok: true, result}));
const failure = (code: string) => raw(JSON.stringify({ok: false, error: {code, message: code}}), 1);
const strategy = validateStrategy({planner: "claude-code", providers: {"claude-code": {}, codex: {}}}, "/x");
const arg = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

/** `orca terminal list --worktree id:<id>` as Orca 1.4 replies: Orca's own "Terminal 1", then pacer's agent terminal once created. */
const listing = (state: {agent: boolean; shell: boolean}) => (a: string[]) => {
  const id = arg(a, "--worktree").slice(3);
  return envelope({terminals: [
    ...(state.shell ? [{handle: "term_shell", incarnationId: "shell-inc", worktreeId: id, title: "Terminal 1", connected: true, writable: true}] : []),
    ...(state.agent ? [{handle: terminal, incarnationId: "inc", worktreeId: id, title: "pacer", connected: true, writable: true}] : []),
    {handle: "term_elsewhere", worktreeId: "repo-1::/work/other", title: "Terminal 2", connected: true, writable: true},
  ], totalCount: 3, truncated: false});
};

const homes: Ctx[] = [];
afterEach(async () => { for (const ctx of homes.splice(0)) await shutdownPlugins(ctx); });

function setup(over: Route[] = [], execution: Partial<ExecutionCfg> = {}, deps: Partial<OrcaBackendDeps> = {}, fallthrough: Route[] = [],
  provider: Parameters<typeof inProcessOrca>[0] = {}) {
  const state = {agent: false, shell: true};
  const routes: Route[] = [
    [["git", "-C", repo, "rev-parse", "--verify"], raw("a".repeat(40))],
    [["git", "-C", repo, "rev-parse"], raw(`${repo}\nmain\n`)],
    [["git", "-C", repo, "status"], raw("")],
    [["git", "-C", repo, "fetch"], raw("")],
    [["git", "-C", repo, "ls-remote"], raw("ref: refs/heads/main\tHEAD\n")],
    [O("status"), envelope({runtime: {state: "ready", reachable: true}})],
    [O("repo", "list"), envelope({repos: [{id: "repo-1", path: repo}]})],
    [O("terminal", "create"), (a: string[]) => {if (a.includes("--command")) state.agent = true; return envelope({terminal: {handle: a.includes("--command") ? terminal : "term_coord", connected: true, writable: true, incarnationId: "inc"}});}],
    [O("terminal", "list"), listing(state)],
    [O("terminal", "close", "--terminal", "term_shell"), () => {state.shell = false; return envelope({close: {handle: "term_shell", ptyKilled: true}});}],
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
  const f = fakeRun([...over, ...routes, ...fallthrough]);
  const ctx = fakeCtx({run: f.run});
  // Paths outside an attempt (task.stop, the supervision pass) reach the provider through the production registry.
  sourcePluginRegistry(ctx);
  homes.push(ctx);
  const task = createTask(ctx, {brief: {goal: "Fix the bug", repo}, kind: null, requestedExecutor: null, timeoutS: 1});
  let direct = 0;
  const directLog = join(ctx.pacerHome, "direct.log");
  const routeDeps: Partial<OrcaBackendDeps> = {loadExecution: () => ({...DEFAULT_EXECUTION, ...execution}),
    direct: async () => {direct++; await Bun.write(directLog, ""); return {exec: {code: 0, stdout: "direct", stderr: "", timedOut: false}, report: "direct", backend: "direct", attempt: {executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: directLog}};},
    sliceMs: 10, sleep: async () => {}, ...deps};
  const backend = makeOrcaBackend(routeDeps, provider);
  const root = `/work/pacer-${task.id}-codex`;
  return {f, ctx, task, backend, routeDeps, state, cfg: strategy.providers.codex, root, wt: `repo-1::${root}`, directLog, get direct() {return direct;}};
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
  // The agent replaces the terminal's login shell, so once it exits no shell is left to receive typed input.
  expect(cmd.startsWith("exec env ")).toBe(true);
  expect(arg(calls[start], "--terminal")).toBe(terminal);
  expect(arg(calls[start], "--worktree")).toBe(`id:${x.wt}`);
  expect(calls[start]).not.toContain("--agent");
  expect(calls[start]).not.toContain("--model");
});

test("new child finds Orca's initial terminal by listing the new worktree (the create reply names none) and closes it before launching the agent", async () => {
  const x = setup();
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const list = x.f.calls.findIndex(a => a[1] === "terminal" && a[2] === "list");
  const closed = x.f.calls.findIndex(a => a[1] === "terminal" && a[2] === "close" && a.includes("term_shell"));
  const launched = x.f.calls.findIndex(a => a[1] === "terminal" && a[2] === "create" && a.includes("--command"));
  expect(x.f.calls[list]).toEqual(["orca", "terminal", "list", "--worktree", `id:${x.wt}`, "--json"]);
  expect(list).toBeLessThan(closed);
  expect(closed).toBeLessThan(launched);
  expect(x.f.count(O("terminal", "close", "--terminal", "term_shell"))).toBe(1);
  expect(x.f.calls.some(a => a.includes("term_elsewhere"))).toBe(false);
  expect(x.f.count(O("terminal", "list"))).toBe(1);
  expect(readFileSync(out.attempt.log, "utf8")).toContain("closed Orca initial terminal term_shell: ok");
});

test("terminals that appear after the agent terminal are never closed; other worktrees are never touched", async () => {
  const late = {handle: "term_late", worktreeId: "", title: "Terminal 1", connected: true, writable: true};
  const x = setup([
    [O("terminal", "list"), [envelope({terminals: []}), (a: string[]) => envelope({terminals: [{...late, worktreeId: arg(a, "--worktree").slice(3)},
      {handle: terminal, worktreeId: arg(a, "--worktree").slice(3)}, {handle: "term_elsewhere", worktreeId: "repo-1::/work/other"}]})]],
    [O("terminal", "close", "--terminal", "term_late"), envelope({close: {handle: "term_late", ptyKilled: true}})],
  ]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("orca");
  expect(x.f.calls.some(a => a[2] === "close" && a.includes("term_late"))).toBe(false);
  expect(x.f.calls.some(a => a.includes("term_elsewhere"))).toBe(false);
  expect(closes(x.f.calls)).toHaveLength(1);
});

test("an older create reply naming the initial terminal is still closed", async () => {
  const x = setup([
    [O("worktree", "create"), (a: string[]) => envelope({worktree: {id: `repo-1::/work/${arg(a, "--name")}`}, terminal: {handle: "term_named", incarnationId: "named-inc"}})],
    [O("terminal", "list"), envelope({terminals: []})],
    [O("terminal", "close", "--terminal", "term_named"), envelope({close: {handle: "term_named", ptyKilled: true}})],
  ]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const closed = x.f.calls.findIndex(a => a[2] === "close" && a.includes("term_named"));
  expect(closed).toBeGreaterThanOrEqual(0);
  expect(closed).toBeLessThan(x.f.calls.findIndex(a => a[2] === "create" && a.includes("--command")));
});

test("current placement records the start commit and resolves a worktree id", async () => {
  const x = setup([], {worktree: "current"});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "create")).toBe(false);
  expect(out.worktree).toBe(repo);
  expect(readTask(x.ctx, x.task.id)?.startSha).toBe("a".repeat(40));
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
  expect(x.f.calls.filter(a => a[1] === "terminal" && a[2] === "close" && !a.includes("term_shell"))).toEqual([["orca", "terminal", "close", "--terminal", terminal, "--json"]]);
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
  expect(x.f.calls.filter(a => a[1] === "terminal" && a[2] === "close" && a.includes(terminal))).toHaveLength(2);
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
  expect(x.f.calls.filter(a => a[1] === "terminal" && a[2] === "close" && !a.includes("term_shell"))).toEqual([["orca", "terminal", "close", "--terminal", terminal, "--json"]]);
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
    expect(cmd.startsWith(`exec env -u ${id === "claude-code" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"} PACER_ROLE=executor PACER_TASK_ID=${x.task.id} PACER_HOME=${x.ctx.pacerHome}`)).toBe(true);
    expect(cmd).toContain(id === "claude-code" ? " CLAUDE_CODE_SANDBOXED=1 claude " : " codex ");
    expect(cmd.includes("CLAUDE_CODE_SANDBOXED")).toBe(id === "claude-code");
    expect(existsSync(join(x.ctx.home, ".claude.json"))).toBe(false);
    expect(existsSync(join(x.ctx.pacerHome, "orca", "trusted.json"))).toBe(false);
  }
});

test("the Orca backend never edits Claude folder trust", () => {
  // Folder trust in Orca terminals stays with CLAUDE_CODE_SANDBOXED; the direct launch's .claude.json grant covers pacer's own task worktrees only.
  const files = (dir: string): string[] => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]);
  const offenders = files(join(import.meta.dir, "..", "src", "exec", "orca")).filter(f => /hasTrustDialogAccepted|trusted\.json|grantClaudeFolderTrust/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});

const MCP_KEYS = ["enableAllProjectMcpServers", "disabledMcpjsonServers", "enabledMcpjsonServers"];
const claudeSettings = (x: ReturnType<typeof setup>) => JSON.parse(readFileSync(join(x.ctx.pacerHome, "runs", x.task.id, "1-orca", "claude-settings.json"), "utf8"));
const attemptLog = (out: {attempt: {log: string}}) => readFileSync(out.attempt.log, "utf8");

test("the Claude terminal reuses the direct interactive launch's per-run settings file without pacer's PTY hooks", async () => {
  const x = setup();
  await x.backend.runAttempt(x.ctx, strategy.providers["claude-code"], x.task);
  const settings = join(x.ctx.pacerHome, "runs", x.task.id, "1-orca", "claude-settings.json");
  expect(commandOf(x.f.calls)).toContain(`CLAUDE_CODE_SANDBOXED=1 claude --settings ${settings} --dangerously-skip-permissions`);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({skipDangerousModePermissionPrompt: true, enableAllProjectMcpServers: true});
  expect(statSync(settings).mode & 0o777).toBe(0o600);
});

test("a new-child Orca run carries the source checkout's MCP answers, so a rejected server stays off, and never writes .claude.json", async () => {
  const x = setup();
  const config = join(x.ctx.home, ".claude.json");
  const text = JSON.stringify({primaryApiKey: "secret", projects: {[repo]: {disabledMcpjsonServers: ["rejected"], enabledMcpjsonServers: ["approved", "rejected"], allowedTools: ["x"]}}});
  writeFileSync(config, text, {mode: 0o600});
  const out = await x.backend.runAttempt(x.ctx, strategy.providers["claude-code"], x.task);
  expect(out.backend).toBe("orca");
  expect(claudeSettings(x)).toEqual({skipDangerousModePermissionPrompt: true, enableAllProjectMcpServers: true, disabledMcpjsonServers: ["rejected"], enabledMcpjsonServers: ["approved"]});
  expect(readFileSync(config, "utf8")).toBe(text);
  expect(commandOf(x.f.calls)).toContain("CLAUDE_CODE_SANDBOXED=1");
  expect(attemptLog(out)).not.toContain("secret");
  expect(attemptLog(out)).not.toContain("claude project MCP servers");
});

test("a new-child Orca run approves nothing when the account's Claude config is unusable, and the attempt log says so", async () => {
  const folder = mkdtempSync(join(tmpdir(), "pacer-orca-claude-"));
  // A directory is unusable as the config for every user; file modes do not stop root on CI runners.
  mkdirSync(join(folder, ".claude.json"));
  try {
    const x = setup([], {}, {terminalEnv: async ctx => ({env: {...ctx.env, CLAUDE_CONFIG_DIR: folder}, source: "login-shell", shell: "/bin/zsh", umask: {mask: "022"}, profileKeys: ["CLAUDE_CONFIG_DIR"], folder: []})});
    const out = await x.backend.runAttempt(x.ctx, strategy.providers["claude-code"], x.task);
    expect(out.backend).toBe("orca");
    for (const key of MCP_KEYS) expect(claudeSettings(x)).not.toHaveProperty(key);
    expect(attemptLog(out)).toContain("claude project MCP servers: not pre-approved (the Claude config path is not a file); Claude may ask whether to use this project's MCP servers");
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test("an in-place Orca run reads no MCP answers and keeps Claude's MCP prompt", async () => {
  const x = setup([], {worktree: "current"});
  writeFileSync(join(x.ctx.home, ".claude.json"), JSON.stringify({projects: {[repo]: {enabledMcpjsonServers: ["approved"]}}}), {mode: 0o600});
  const out = await x.backend.runAttempt(x.ctx, strategy.providers["claude-code"], x.task);
  expect(out.backend).toBe("orca");
  expect(claudeSettings(x)).toEqual({skipDangerousModePermissionPrompt: true});
  expect(attemptLog(out)).toContain("claude project MCP servers: not pre-approved (only pacer-created task worktrees are)");
});

test("the Codex terminal command carries no per-run settings or hook overrides", async () => {
  const x = setup();
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const cmd = commandOf(x.f.calls);
  expect(cmd).not.toContain("--settings");
  expect(cmd).not.toContain("hooks.");
  expect(cmd).not.toContain("--dangerously-bypass-hook-trust");
});

test("a default account uses the account folder the login profile sets, as a direct launch does", async () => {
  for (const id of ["claude-code", "codex"] as const) {
    const key = id === "claude-code" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME", folder = `/profile/${id}`;
    const x = setup([], {}, {terminalEnv: async ctx => ({env: {...ctx.env, [key]: folder}, source: "login-shell", shell: "/bin/zsh", umask: {mask: "022"}, profileKeys: [key], folder: []})});
    await x.backend.runAttempt(x.ctx, strategy.providers[id], x.task);
    const cmd = commandOf(x.f.calls);
    expect(cmd).not.toContain(`-u ${key}`);
    expect(cmd).toContain(`${key}=${folder} `);
    const out = await runCommand(cmd, x.ctx.home, {CLAUDE_CONFIG_DIR: "/planner/claude", CODEX_HOME: "/planner/codex"});
    expect(out).toContain(id === "claude-code" ? `home=${folder}|/planner/codex` : `home=/planner/claude|${folder}`);
  }
});

test("the attempt log records each Orca step", async () => {
  const x = setup();
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const text = readFileSync(out.attempt.log, "utf8");
  const order = [`worktree create ${x.wt}: ${x.root}`, `terminal create ${terminal}: exec env -u CODEX_HOME PACER_ROLE=executor PACER_TASK_ID=${x.task.id}`,
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
  ["initial terminal close", [[O("terminal", "close", "--terminal", "term_shell"), failure("close_failed")]]],
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

const commandOf = (calls: string[][]) => arg(calls.find(a => a[2] === "create" && a.includes("--command"))!, "--command");
/** Run the visible terminal command with a stub agent that prints its environment and arguments. */
async function runCommand(cmd: string, dir: string, env: Record<string, string>) {
  const {mkdirSync, writeFileSync, chmodSync} = await import("node:fs");
  const bin = join(dir, "bin");
  mkdirSync(bin, {recursive: true});
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(bin, name), '#!/bin/sh\nprintf "home=%s|%s\\n" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"\nfor a in "$@"; do printf "arg=%s\\n" "$a"; done\n');
    chmodSync(join(bin, name), 0o755);
  }
  const p = Bun.spawnSync(["/bin/sh", "-c", cmd], {cwd: dir, env: {PATH: `${bin}:/usr/bin:/bin`, ...env}});
  return p.stdout.toString();
}

test("a default-account Orca command clears an account home inherited from Orca's shell", async () => {
  for (const id of ["claude-code", "codex"] as const) {
    const x = setup();
    await x.backend.runAttempt(x.ctx, strategy.providers[id], x.task);
    const out = await runCommand(commandOf(x.f.calls), x.ctx.home, {CLAUDE_CONFIG_DIR: "/planner/claude", CODEX_HOME: "/planner/codex"});
    expect(out).toContain(id === "claude-code" ? "home=|/planner/codex" : "home=/planner/claude|");
  }
});

test("a model value with shell metacharacters reaches the agent as one literal argument", async () => {
  const model = "m'; touch pwned; echo $(id) `id` \"x\" ~ *";
  const x = setup();
  const cfg = validateStrategy({planner: "codex", providers: {"claude-code": {model}, codex: {}}}, "/x").providers["claude-code"];
  await x.backend.runAttempt(x.ctx, cfg, x.task);
  const out = await runCommand(commandOf(x.f.calls), x.ctx.home, {});
  expect(out).toContain(`arg=--model\narg=${model}\n`);
  expect(existsSync(join(x.ctx.home, "pwned"))).toBe(false);
});

test("a task that allows delegation runs directly and logs why", async () => {
  const x = setup();
  x.ctx.env = {...x.ctx.env, PACER_WORK_GRANT: "secret-grant"};
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("direct");
  expect(x.direct).toBe(1);
  expect(x.f.calls).toHaveLength(0);
  expect(readFileSync(x.directLog, "utf8")).toContain("direct backend: Orca fallback (the task allows delegation");
  expect(readFileSync(join(x.ctx.pacerHome, "orca", "fallback.log"), "utf8")).not.toContain("secret-grant");
});

test("every lease rebind keeps the create-time terminal incarnation", async () => {
  const binds: Parameters<typeof bindOrcaWorkSync>[2][] = [];
  const admission = {begin: beginWorkSync, finishOrca: finishOrcaWorkSync, finish: finishWorkSync,
    bind: (...a: Parameters<typeof bindOrcaWorkSync>) => {binds.push(a[2]); bindOrcaWorkSync(...a);}};
  const x = setup([[O("terminal", "show"), failure("unavailable")]], {}, {admission});
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const agentBinds = binds.filter(b => b.terminal === terminal);
  expect(agentBinds.map(b => b.dispatchId)).toEqual(["pending", dispatch]);
  expect(agentBinds.every(b => b.incarnationId === "inc")).toBe(true);
});

test("a pre-start close without proof is recorded, and clean retries it", async () => {
  const x = setup([[O("terminal", "wait"), failure("timeout")], [O("terminal", "close", "--terminal", terminal), envelope({closed: true})]]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(loadOrcaState(x.ctx).unclosed[terminal]).toMatchObject({taskId: x.task.id, terminal});
  expect(await lease(x)).toBe(true);
  const later = fakeRun([[O("terminal", "close"), envelope({close: {handle: terminal, ptyKilled: true}})], [O("orchestration", "worker-list"), envelope({workers: [], page: {hasMore: false}})]]);
  x.ctx.run = later.run;
  await reconcileHostWork(x.ctx);
  expect(closes(later.calls)).toHaveLength(1);
  expect(loadOrcaState(x.ctx).unclosed).toEqual({});
});

test("a failed close after supervision is recorded; a terminal Orca shows disconnected needs no further close", async () => {
  const x = setup([[O("terminal", "close", "--terminal", terminal), failure("close_failed")]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("orca");
  expect(readFileSync(out.attempt.log, "utf8")).toContain(`recorded terminal ${terminal} for a later close by pacer clean`);
  expect(loadOrcaState(x.ctx).unclosed[terminal]).toMatchObject({taskId: x.task.id});
  const still = fakeRun([[O("terminal", "close"), failure("close_failed")], [O("terminal", "show"), envelope({terminal: {handle: terminal, connected: true, writable: true}})]]);
  x.ctx.run = still.run;
  await reconcileHostWork(x.ctx);
  expect(loadOrcaState(x.ctx).unclosed[terminal]).toBeDefined();
  const gone = fakeRun([[O("terminal", "close"), failure("close_failed")], [O("terminal", "show"), envelope({terminal: {handle: terminal, connected: false, writable: false, orphaned: true}})]]);
  x.ctx.run = gone.run;
  await reconcileHostWork(x.ctx);
  expect(loadOrcaState(x.ctx).unclosed).toEqual({});
});

test("an uncertain start whose worker appears on a later worker-list page is supervised", async () => {
  const x = setup([[O("orchestration", "worker-start"), failure("timeout")],
    [O("orchestration", "worker-list", "--run", "run_1", "--cursor", "c2"), envelope({workers: [{dispatchId: "ctx_9", agentTerminalHandle: terminal, workerState: "ready"}], page: {limit: 100, hasMore: false, nextCursor: null}, scope: {run: "run_1"}})],
    [O("orchestration", "worker-list"), envelope({workers: [{dispatchId: "ctx_other", agentTerminalHandle: "term_other", workerState: "succeeded"}], page: {limit: 100, hasMore: true, nextCursor: "c2"}, scope: {run: "run_1"}})]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(x.direct).toBe(0);
  expect(out.worktree).toBe(x.root);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-list", "--run", "run_1", "--cursor", "c2", "--json"]);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-release", "--dispatch", "ctx_9", "--json"]);
});

test("reconciling a settled uncertain worker attaches its worktree and outcome to the task instead of removing it", async () => {
  const x = setup([[O("orchestration", "worker-start"), failure("timeout")], [O("orchestration", "worker-list"), failure("unavailable")]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  updateTask(x.ctx, x.task.id, t => {t.state = "done"; t.result = {status: "done", executor: "codex", model: null, files: "", report: out.report, backend: "orca"};});
  const later = fakeRun([
    [O("orchestration", "worker-list"), envelope({workers: [{dispatchId: "ctx_9", agentTerminalHandle: terminal, workerState: "succeeded"}], page: {hasMore: false}})],
    [O("terminal", "close"), envelope({close: {handle: terminal, ptyKilled: true}})],
  ]);
  x.ctx.run = later.run;
  await reconcileHostWork(x.ctx);
  const state = loadOrcaState(x.ctx);
  expect(state.uncertain).toEqual({});
  expect(state.stranded).toEqual({});
  const t = (await import("../src/tasks/store")).readTask(x.ctx, x.task.id)!;
  expect(t.worktree).toBe(x.root);
  expect(t.result?.worktree).toBe(x.root);
  expect(t.result?.report).toContain(`Orca worker ctx_9 was found succeeded after the uncertain start; its work is in ${x.root}`);
});

const gone = (handle: string, worktreeId: string, incarnationId = "inc") =>
  envelope({terminal: {handle, incarnationId, worktreeId, connected: false, writable: false, exitCause: {kind: "unknown", reason: "stop_unverified"}}});

test("Orca's initial terminal that cannot be closed never holds the session lease; after pacer removes the worktree, clean retires its record", async () => {
  const x = setup([[O("terminal", "close", "--terminal", "term_shell"), failure("close_failed")]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("direct");
  expect(x.f.count(O("terminal", "close", "--terminal", "term_shell"))).toBe(2);
  expect(has(x.f.calls, "worktree", "rm")).toBe(true);
  expect(loadOrcaState(x.ctx).unclosed.term_shell).toMatchObject({taskId: x.task.id, worktreeId: x.wt});
  expect(loadOrcaState(x.ctx).removed[x.wt]).toMatchObject({id: x.wt, path: x.root});
  const later = fakeRun([[O("terminal", "close"), failure("close_failed")], [O("terminal", "show"), gone("term_shell", x.wt, "shell-inc")]]);
  x.ctx.run = later.run;
  await reconcileHostWork(x.ctx);
  expect(loadOrcaState(x.ctx).unclosed).toEqual({});
  expect(loadOrcaState(x.ctx).removed).toEqual({});
  expect(await lease(x)).toBe(false);
});

test("a pacer terminal whose close failed twice has its lease released once reconcile proves it died with the worktree pacer removed", async () => {
  const x = setup([[O("terminal", "wait"), failure("timeout")], [O("terminal", "close", "--terminal", terminal), failure("close_failed")]]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(has(x.f.calls, "worktree", "rm")).toBe(true);
  expect(loadOrcaState(x.ctx).unclosed[terminal]).toMatchObject({worktreeId: x.wt});
  expect(await lease(x)).toBe(true);
  // Disconnected in some other worktree, or with another incarnation, is not proof.
  for (const reply of [gone(terminal, "repo-1::/work/other"), gone(terminal, x.wt, "other-inc")]) {
    x.ctx.run = fakeRun([[O("terminal", "close"), failure("close_failed")], [O("terminal", "show"), reply]]).run;
    await reconcileHostWork(x.ctx);
    expect(await lease(x)).toBe(true);
    updateOrcaState(x.ctx, s => {s.unclosed[terminal] = {taskId: x.task.id, terminal, worktreeId: x.wt, at: 1}; s.removed[x.wt] = {id: x.wt, path: x.root, at: 1};});
  }
  x.ctx.run = fakeRun([[O("terminal", "close"), failure("close_failed")], [O("terminal", "show"), gone(terminal, x.wt)]]).run;
  await reconcileHostWork(x.ctx);
  expect(loadOrcaState(x.ctx).unclosed).toEqual({});
  expect(await lease(x)).toBe(false);
});

test("a failed close of a terminal in a worktree pacer did not remove keeps its lease", async () => {
  const x = setup([[O("terminal", "close", "--terminal", terminal), failure("close_failed")]]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  x.ctx.run = fakeRun([[O("terminal", "close"), failure("close_failed")], [O("terminal", "show"), gone(terminal, x.wt)]]).run;
  await reconcileHostWork(x.ctx);
  expect(await lease(x)).toBe(true);
});

test("a reviewed uncertain task whose settled worker is found needs review again, and clean --force keeps its worktree", async () => {
  const x = setup([[O("orchestration", "worker-start"), failure("timeout")], [O("orchestration", "worker-list"), failure("unavailable")]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  updateTask(x.ctx, x.task.id, t => {
    t.state = "done"; t.review = {accepted: true, kind: null, note: null, at: 1}; t.dismissed = true; t.resolved = "resolved";
    t.result = {status: "done", executor: "codex", model: null, files: "", report: out.report, backend: "orca"};
  });
  const later = fakeRun([
    [O("orchestration", "worker-list"), envelope({workers: [{dispatchId: "ctx_9", agentTerminalHandle: terminal, workerState: "succeeded"}], page: {hasMore: false}})],
    [O("terminal", "close"), envelope({close: {handle: terminal, ptyKilled: true}})],
    [O("worktree", "show"), envelope({worktree: {id: x.wt, path: x.root, displayName: `pacer-${x.task.id}-codex`, isMainWorktree: false}})],
    [O("worktree", "rm"), envelope({})],
    [["git"], raw(`${x.root}\n`)],
  ]);
  x.ctx.run = later.run;
  const {clean} = await import("../src/core/tasks");
  for (let pass = 0; pass < 2; pass++) expect((await clean(x.ctx, {force: true})).removed).toEqual([]);
  expect(has(later.calls, "worktree", "rm")).toBe(false);
  const t = (await import("../src/tasks/store")).readTask(x.ctx, x.task.id)!;
  expect(t.worktree).toBe(x.root);
  expect([t.review, t.dismissed, t.resolved]).toEqual([undefined, undefined, undefined]);
});

const named = [O("worktree", "create"), (a: string[]) => envelope({worktree: {id: `repo-1::/work/${arg(a, "--name")}`}, terminal: {handle: "term_named", incarnationId: "named-inc"}})] as Route;
const ownedRoute = (x: ReturnType<typeof setup>) => [O("worktree", "show"), envelope({worktree: {id: x.wt, path: x.root, displayName: `pacer-${x.task.id}-codex`, isMainWorktree: false}})] as Route;

for (const [name, list] of [["failed", failure("unknown_flag")], ["truncated", envelope({terminals: [], totalCount: 40, truncated: true})]] as const) {
  test(`a ${name} worktree terminal listing records only the initial terminal Orca named; clean closes no other terminal`, async () => {
    const x = setup([named, [O("terminal", "list"), list], [O("terminal", "close", "--terminal", "term_named"), envelope({close: {handle: "term_named", ptyKilled: true}})]]);
    const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
    expect(out.backend).toBe("orca");
    expect(readFileSync(out.attempt.log, "utf8")).toContain(`recorded worktree ${x.wt} for a stray terminal sweep by pacer clean`);
    expect(loadOrcaState(x.ctx).strays[x.wt]).toMatchObject({taskId: x.task.id, id: x.wt, path: x.root, initial: ["term_named"]});
    updateTask(x.ctx, x.task.id, t => {t.state = "done";});
    x.ctx.run = fakeRun([ownedRoute(x), [O("terminal", "list"), list]]).run;
    await reconcileHostWork(x.ctx);
    expect(loadOrcaState(x.ctx).strays[x.wt]).toBeDefined();
    updateOrcaState(x.ctx, s => {s.unclosed.term_kept = {taskId: x.task.id, terminal: "term_kept", at: 1};});
    // term_user was opened after pacer's agent terminal (for example, by the user): never closed.
    const sweep = fakeRun([ownedRoute(x),
      [O("terminal", "list"), envelope({terminals: [{handle: "term_named", worktreeId: x.wt}, {handle: "term_user", worktreeId: x.wt}, {handle: "term_kept", worktreeId: x.wt}, {handle: "term_elsewhere", worktreeId: "repo-1::/work/other"}], truncated: false})],
      [O("terminal", "close", "--terminal", "term_named"), envelope({close: {handle: "term_named", ptyKilled: true}})],
      [O("terminal", "close"), failure("close_failed")],
      [O("terminal", "show"), envelope({terminal: {handle: "term_kept", connected: true, writable: true}})],
    ]);
    x.ctx.run = sweep.run;
    await reconcileHostWork(x.ctx);
    expect(sweep.count(O("terminal", "close", "--terminal", "term_named"))).toBe(1);
    expect(sweep.calls.some(a => a.includes("term_user") || a.includes("term_elsewhere"))).toBe(false);
    expect(sweep.calls.filter(a => a[2] === "close" && a.includes("term_kept"))).toHaveLength(2);
    expect(loadOrcaState(x.ctx).strays).toEqual({});
  });
}

test("a failed listing with no initial terminal named records nothing to sweep", async () => {
  const x = setup([[O("terminal", "list"), failure("unknown_flag")]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("orca");
  expect(readFileSync(out.attempt.log, "utf8")).toContain(`pacer cannot tell Orca's initial terminal in ${x.wt} from others; it closes only terminals it recorded`);
  expect(loadOrcaState(x.ctx).strays).toEqual({});
});

test("a stray record without recorded initial terminals closes nothing and is dropped", async () => {
  const x = setup();
  updateOrcaState(x.ctx, s => {s.strays[x.wt] = {taskId: x.task.id, id: x.wt, path: x.root, name: `pacer-${x.task.id}-codex`, initial: [], at: 1};});
  const sweep = fakeRun([ownedRoute(x), [O("terminal", "list"), envelope({terminals: [{handle: "term_user", worktreeId: x.wt}], truncated: false})]]);
  x.ctx.run = sweep.run;
  await reconcileHostWork(x.ctx);
  expect(sweep.calls.some(a => a[1] === "terminal")).toBe(false);
  expect(loadOrcaState(x.ctx).strays).toEqual({});
});

test("the stray sweep waits while a task runs in the worktree", async () => {
  const x = setup([named, [O("terminal", "list"), failure("unknown_flag")], [O("terminal", "close", "--terminal", "term_named"), envelope({close: {handle: "term_named", ptyKilled: true}})]]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  updateTask(x.ctx, x.task.id, t => {t.state = "running";});
  const sweep = fakeRun([ownedRoute(x)]);
  x.ctx.run = sweep.run;
  await reconcileHostWork(x.ctx);
  expect(sweep.calls.some(a => a[1] === "terminal")).toBe(false);
  expect(loadOrcaState(x.ctx).strays[x.wt]).toBeDefined();
});

test("an uncertain-start terminal Orca already shows disconnected is reconciled without a close receipt", async () => {
  const x = setup([[O("orchestration", "worker-start"), failure("timeout")], [O("orchestration", "worker-list"), failure("unavailable")]]);
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  x.ctx.run = fakeRun([
    [O("orchestration", "worker-list"), envelope({workers: [], page: {hasMore: false}})],
    [O("terminal", "close"), failure("terminal_not_found")],
    [O("terminal", "show"), envelope({terminal: {handle: terminal, connected: false, writable: false}})],
  ]).run;
  await reconcileHostWork(x.ctx);
  expect(loadOrcaState(x.ctx).uncertain).toEqual({});
  expect(loadOrcaState(x.ctx).stranded[x.task.id]).toMatchObject({id: x.wt});
});

const question = envelope({messages: [{id: "q1", type: "question", from_handle: terminal, subject: "q", body: "Should I also update the README?", payload: JSON.stringify({dispatchId: dispatch})}], deliveryId: "d1"});

test("group: creates one parent worktree per group, nests each lane's own worktree under it", async () => {
  const x = setup();
  const task = updateTask(x.ctx, x.task.id, t => {t.group = "feature-x";});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, task);
  expect(out.backend).toBe("orca");
  expect(out.worktree).toBe(x.root);
  const creates = x.f.calls.filter(a => a[1] === "worktree" && a[2] === "create");
  expect(creates).toHaveLength(2);
  expect(arg(creates[0], "--name")).toBe("pacer-group-feature-x");
  expect(creates[0]).toContain("--no-parent");
  expect(arg(creates[1], "--name")).toBe(`pacer-${task.id}-codex`);
  expect(arg(creates[1], "--parent-worktree")).toBe("path:/work/pacer-group-feature-x");
  expect(arg(x.f.calls.find(a => a[2] === "worker-start")!, "--worktree")).toBe(`id:${x.wt}`);
  expect(loadOrcaState(x.ctx).groups).toEqual({"repo-1:feature-x": {selector: "path:/work/pacer-group-feature-x"}});
});

/** `orca worktree show` for a group parent: Orca lists the lanes still nested under it. */
const groupShow = (children: () => string[]) => [O("worktree", "show", "--worktree", "path:/work/pacer-group-feature-x"),
  () => envelope({worktree: {id: "repo-1::/work/pacer-group-feature-x", path: "/work/pacer-group-feature-x", displayName: "pacer-group-feature-x", isMainWorktree: false, childWorktreeIds: children()}})] as Route;
const groupClean = [["git", "-C", "/work/pacer-group-feature-x", "status"], raw("")] as Route;
const groupRemoved = (calls: string[][]) => calls.some(a => a[1] === "worktree" && a[2] === "rm" && arg(a, "--worktree") === "id:repo-1::/work/pacer-group-feature-x");

test("group: a refused worker-start removes the lane worktree and the group parent it just created, so a direct fallback leaves nothing in Orca", async () => {
  let lane = true;
  const x = setup([[O("orchestration", "worker-start"), failure("task_not_startable")],
    [O("worktree", "rm"), (a: string[]) => {if (arg(a, "--worktree") !== "id:repo-1::/work/pacer-group-feature-x") lane = false; return envelope({});}],
    groupShow(() => lane ? [`repo-1::/work/pacer-x`] : []), groupClean]);
  const task = updateTask(x.ctx, x.task.id, t => {t.group = "feature-x";});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, task);
  expect(out.backend).toBe("direct");
  const removes = x.f.calls.filter(a => a[1] === "worktree" && a[2] === "rm");
  expect(removes.map(a => arg(a, "--worktree"))).toEqual([`id:${x.wt}`, "id:repo-1::/work/pacer-group-feature-x"]);
  expect(loadOrcaState(x.ctx).groups).toEqual({});
});

test("group: a fallback keeps a group parent that another lane still uses", async () => {
  const x = setup([[O("orchestration", "worker-start"), failure("task_not_startable")], groupShow(() => ["repo-1::/work/pacer-other-lane"]), groupClean]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, updateTask(x.ctx, x.task.id, t => {t.group = "feature-x";}));
  expect(out.backend).toBe("direct");
  expect(groupRemoved(x.f.calls)).toBe(false);
  expect(loadOrcaState(x.ctx).groups["repo-1:feature-x"]).toEqual({selector: "path:/work/pacer-group-feature-x"});
});

test("group: a second lane in the same group reuses the cached parent worktree", async () => {
  const x = setup();
  await x.backend.runAttempt(x.ctx, x.cfg, updateTask(x.ctx, x.task.id, t => {t.group = "feature-x";}));
  const second = createTask(x.ctx, {brief: {goal: "Second lane", repo}, kind: null, requestedExecutor: null, timeoutS: 1, group: "feature-x"});
  await x.backend.runAttempt(x.ctx, x.cfg, second);
  const creates = x.f.calls.filter(a => a[1] === "worktree" && a[2] === "create");
  expect(creates).toHaveLength(3); // group parent once, plus one lane worktree per task
  expect(creates.filter(a => arg(a, "--name") === "pacer-group-feature-x")).toHaveLength(1);
});

test("an interactive lane's escalation keeps its worker and terminal alive instead of stopping them", async () => {
  const x = setup([[O("orchestration", "check"), question], [O("orchestration", "reply"), envelope({})]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, updateTask(x.ctx, x.task.id, t => {t.interactionMode = "conversation"; t.state = "running";}));
  expect(out.exec.code).toBe(1);
  expect(x.f.count(O("orchestration", "worker-stop"))).toBe(0);
  expect(x.f.count(O("orchestration", "worker-release"))).toBe(0);
  expect(closes(x.f.calls)).toHaveLength(0);
  expect(loadOrcaState(x.ctx).workers[dispatch]).toMatchObject({taskId: x.task.id, terminal});
  expect(readTask(x.ctx, x.task.id)?.question?.text).toBe("Should I also update the README?");
  expect(readTask(x.ctx, x.task.id)?.live).toMatchObject({backend: "orca", worker: dispatch, terminal, executor: "codex", agent: "codex", incarnation: "inc"});
});

test("an interactive lane whose worker ownership was not recorded is not kept alive", async () => {
  const ref: {x?: ReturnType<typeof setup>} = {};
  // The task loses (or never got) its `live` record before the question arrives, as when registration failed.
  const x = ref.x = setup([[O("orchestration", "check"), () => { updateTask(ref.x!.ctx, ref.x!.task.id, t => { delete t.live; }); return question; }], [O("orchestration", "reply"), envelope({})]]);
  await x.backend.runAttempt(x.ctx, x.cfg, updateTask(x.ctx, x.task.id, t => {t.interactionMode = "conversation"; t.state = "running";}));
  expect(x.f.count(O("orchestration", "worker-stop"))).toBe(1);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(loadOrcaState(x.ctx).workers).toEqual({});
});

test("a delegated (non-interactive) lane's escalation still stops its worker, unlike an interactive lane", async () => {
  const x = setup([[O("orchestration", "check"), question], [O("orchestration", "reply"), envelope({})]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, updateTask(x.ctx, x.task.id, t => {t.state = "running";}));
  expect(out.exec.code).toBe(1);
  expect(x.f.count(O("orchestration", "worker-stop"))).toBe(1);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(loadOrcaState(x.ctx).workers).toEqual({});
  expect(readTask(x.ctx, x.task.id)?.live).toBeUndefined();
});

const agentInForeground = [O("terminal", "show"), envelope({terminal: {handle: terminal, connected: true, writable: true, incarnationId: "inc", agentIdentity: "codex"}})] as Route;
const shellInForeground = [O("terminal", "show"), envelope({terminal: {handle: terminal, connected: true, writable: true, incarnationId: "inc", agentIdentity: null}})] as Route;
const liveWorker = [O("orchestration", "worker-show"), [envelope({worker: {state: "ready"}}), envelope({worker: {state: "ready"}}), envelope({worker: {state: "succeeded"}})]] as Route;
const LIVE = {backend: "orca", worker: "ctx_live", terminal, executor: "codex", agent: "codex", incarnation: "inc", since: 1};

/** A plain interactive lane, started from base commit aaaa…, that asked a question and kept its worker `ctx_live` alive. */
function askedLane(x: ReturnType<typeof setup>, answer?: string) {
  const asked = updateTask(x.ctx, x.task.id, t => {
    t.interactionMode = "conversation"; t.state = "needs_input"; t.worktree = x.root; t.baseSha = "a".repeat(40); t.live = {...LIVE};
    t.question = {text: "which approach?", at: 1, ...(answer ? {answer} : {})};
  });
  updateOrcaState(x.ctx, s => {
    s.coordinator = "term_coord"; s.run = "run_1";
    s.workers.ctx_live = {dispatchId: "ctx_live", taskId: asked.id, executor: "codex", worktree: x.root, terminal, startedAt: 1};
  });
  return asked;
}
function answerOf(x: ReturnType<typeof setup>, of: {id: string; brief: object}, a: string) {
  updateTask(x.ctx, of.id, t => { t.question!.answer = a; });
  const retry = createTask(x.ctx, {brief: {...(of as {brief: {goal: string; repo: string}}).brief, qa: [{q: "which approach?", a}]}, kind: null, requestedExecutor: "codex", timeoutS: 1, interactionMode: "conversation"});
  const running = updateTask(x.ctx, retry.id, t => {t.retryOf = of.id; t.state = "running";});
  updateTask(x.ctx, of.id, t => { t.retriedBy = running.id; });
  return running;
}
const sendsOf = (calls: string[][], text: string) => calls.filter(a => a[1] === "terminal" && a[2] === "send" && a.includes(text));

test("answering an interactive lane with a live worker delivers the answer live and moves the worker to the answer", async () => {
  const x = setup([liveWorker, agentInForeground, [O("terminal", "send"), envelope({})]]);
  const asked = askedLane(x);
  const retry = answerOf(x, asked, "go with B");
  const out = await x.backend.runAttempt(x.ctx, x.cfg, retry);
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(0);
  expect(x.f.calls.filter(a => a[1] === "worktree" && a[2] === "create")).toHaveLength(0);
  expect(sendsOf(x.f.calls, "go with B")).toHaveLength(1);
  expect(out.backend).toBe("orca");
  expect(out.worktree).toBe(x.root);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  // The worker finished this round, so it is settled and released rather than kept.
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(loadOrcaState(x.ctx).workers).toEqual({});
  expect(readTask(x.ctx, retry.id)?.live).toBeUndefined();
});

test("stopping an answered group lane removes its original worktree and empty group parent", async () => {
  const ref: {x?: ReturnType<typeof setup>} = {}, state = {lane: true};
  const x = ref.x = setup([
    [O("orchestration", "worker-show"), envelope({worker: {state: "ready"}})],
    agentInForeground,
    [O("terminal", "send"), envelope({})],
    [O("orchestration", "check"), () => {
      updateTask(x.ctx, retry.id, t => { t.state = "stopped"; });
      return envelope({messages: []});
    }],
    ...groupLaneShows(ref, state),
  ], {}, {}, laneGit(() => ref.x!.root, 0));
  updateOrcaState(x.ctx, s => { s.groups["repo-1:feature-x"] = {selector: "path:/work/pacer-group-feature-x"}; });
  const asked = askedLane(x);
  updateTask(x.ctx, asked.id, t => { t.interactive = true; t.group = "feature-x"; t.baseBranch = "main"; });
  const retry = answerOf(x, asked, "go with B");
  const out = await x.backend.runAttempt(x.ctx, x.cfg, retry);
  expect(out.worktree).toBeUndefined();
  expect(x.f.calls.filter(a => a[1] === "worktree" && a[2] === "rm").map(a => arg(a, "--worktree")))
    .toEqual([`id:${x.wt}`, "id:repo-1::/work/pacer-group-feature-x"]);
  expect(loadOrcaState(x.ctx).groups).toEqual({});
  expect(readTask(x.ctx, asked.id)?.state).not.toBe("needs_input");
  expect(readTask(x.ctx, asked.id)?.dismissed).toBe(true);
  expect(readTask(x.ctx, retry.id)?.worktree).toBeUndefined();
});

test("stopping an answered lane keeps its worktree when it holds commits beyond the asking lane's base", async () => {
  const ref: {x?: ReturnType<typeof setup>} = {}, state = {lane: true};
  const askedBase = "a".repeat(40);
  const x = ref.x = setup([
    [O("orchestration", "worker-show"), envelope({worker: {state: "ready"}})],
    agentInForeground,
    [O("terminal", "send"), envelope({})],
    [O("orchestration", "check"), () => {
      updateTask(x.ctx, retry.id, t => { t.state = "stopped"; });
      return envelope({messages: []});
    }],
    ...groupLaneShows(ref, state),
    // Two commits beyond the lane's own base; none beyond its current head.
  ], {}, {}, laneGit(() => ref.x!.root, range => range === `${askedBase}..HEAD` ? 2 : 0));
  const asked = askedLane(x);
  updateTask(x.ctx, asked.id, t => { t.interactive = true; });
  // The answer was delegated from the asking worktree's head, which is not where the lane started.
  const retry = updateTask(x.ctx, answerOf(x, asked, "go with B").id, t => { t.baseSha = LANE_HEAD; });
  const out = await x.backend.runAttempt(x.ctx, x.cfg, retry);
  expect(out.worktree).toBe(x.root);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "rm")).toBe(false);
  expect(attemptLog(out)).toContain("it holds work");
});

test("Orca agent receives the task's pacer home and port", async () => {
  const x = setup();
  x.ctx.env = {...x.ctx.env, PACER_PORT: "54321"};
  await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  const launch = x.f.calls.find(a => a[1] === "terminal" && a[2] === "create" && a.includes("--command"))!;
  const command = arg(launch, "--command");
  expect(command).toContain(`PACER_HOME=${x.ctx.pacerHome}`);
  expect(command).toContain("PACER_PORT=54321");
  expect(command).toContain(`PACER_RUN_DIR=${x.ctx.pacerHome}/runs/${x.task.id}/1-orca`);
  expect(command).toContain(`PACER_TRANSCRIPT_REPORT=${x.ctx.pacerHome}/runs/${x.task.id}/1-orca/transcript-report.md`);
});

test("a second question and answer reattach to the same worker again, and pacer send reaches it after an answer", async () => {
  const x = setup([
    [O("orchestration", "worker-show"), envelope({worker: {state: "running"}})], agentInForeground,
    [O("orchestration", "check"), [envelope({messages: [{id: "q1", type: "question", from_handle: terminal, subject: "q", body: "Should I also update the README?", payload: JSON.stringify({dispatchId: "ctx_live"})}], deliveryId: "d1"}), envelope({messages: [{id: "m1", type: "worker_done", subject: "done", body: "ok", payload: JSON.stringify({dispatchId: "ctx_live", outcome: "succeeded"})}], deliveryId: "d2"})]],
    [O("orchestration", "reply"), envelope({})], [O("terminal", "send"), envelope({})],
  ]);
  const first = askedLane(x);
  const second = answerOf(x, first, "go with B");
  // Round two: the reattached attempt asks again, so the worker is kept and owned by the second attempt.
  await x.backend.runAttempt(x.ctx, x.cfg, second);
  expect(readTask(x.ctx, second.id)?.state).toBe("running");
  expect(readTask(x.ctx, second.id)?.question?.text).toBe("Should I also update the README?");
  expect(readTask(x.ctx, second.id)?.live).toMatchObject({worker: "ctx_live", terminal});
  expect(loadOrcaState(x.ctx).workers.ctx_live?.taskId).toBe(second.id);
  expect(closes(x.f.calls)).toHaveLength(0);
  // pacer send finds the worker under the attempt that now owns it while that attempt runs.
  const {send} = await import("../src/session/send");
  await send(x.ctx, second.id, "also keep the old flag", {by: "planner"});
  expect(sendsOf(x.f.calls, "also keep the old flag")).toHaveLength(1);
  updateTask(x.ctx, second.id, t => { t.state = "needs_input"; });
  // Round three: answering the second question reattaches to the same worker; no new worker or worktree.
  const third = answerOf(x, readTask(x.ctx, second.id)!, "yes, update it");
  await x.backend.runAttempt(x.ctx, x.cfg, third);
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(0);
  expect(sendsOf(x.f.calls, "yes, update it")).toHaveLength(1);
  expect(readTask(x.ctx, second.id)?.live).toBeUndefined();
});

test("a managed work answer (same task id, no retryOf) also reattaches to its live worker", async () => {
  const x = setup([liveWorker, agentInForeground, [O("terminal", "send"), envelope({})]]);
  askedLane(x);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, updateTask(x.ctx, x.task.id, t => {t.state = "running"; t.brief.qa = [{q: "which approach?", a: "go with B"}];}));
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(0);
  expect(sendsOf(x.f.calls, "go with B")).toHaveLength(1);
  expect(out.worktree).toBe(x.root);
});

test("an answer is never typed into a shell: the stale worker is released and the answer respawns", async () => {
  const x = setup([liveWorker, shellInForeground]);
  const asked = askedLane(x);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, answerOf(x, asked, "go with B"));
  expect(sendsOf(x.f.calls, "go with B")).toHaveLength(0);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  expect(loadOrcaState(x.ctx).workers.ctx_live).toBeUndefined();
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(1);
  expect(out.backend).toBe("orca");
});

test("an answer routed to another executor releases the old worker before starting fresh", async () => {
  const x = setup([liveWorker, agentInForeground]);
  const asked = askedLane(x);
  updateTask(x.ctx, asked.id, t => { t.live = {...LIVE, executor: "claude-code", agent: "claude"}; });
  await x.backend.runAttempt(x.ctx, x.cfg, answerOf(x, asked, "go with B"));
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(1);
});

test("task.stop on a kept-alive lane stops its worker and closes its terminal", async () => {
  const x = setup();
  const asked = askedLane(x);
  const {taskStop} = await import("../src/tasks/api");
  expect(taskStop(x.ctx, asked.id)?.state).toBe("stopped");
  for (let i = 0; i < 400 && readTask(x.ctx, asked.id)?.live; i++) await Bun.sleep(5);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  expect(loadOrcaState(x.ctx).workers.ctx_live).toBeUndefined();
});

test("a kept-alive worker expires after the idle limit, and settled or reviewed lanes are released", async () => {
  const {LIVE_IDLE_S, reapLiveWorkers} = await import("../src/exec/live");
  const x = setup();
  const asked = askedLane(x);
  const backends = [x.backend];
  expect(await reapLiveWorkers({...x.ctx, now: 1 + LIVE_IDLE_S - 1}, backends)).toEqual([]);
  expect(x.f.count(O("orchestration", "worker-stop"))).toBe(0);
  expect(await reapLiveWorkers({...x.ctx, now: 1 + LIVE_IDLE_S}, backends)).toEqual([asked.id]);
  expect(x.f.count(O("orchestration", "worker-stop"))).toBe(1);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  for (const settle of [(t: TaskRecordish) => { t.state = "done"; }, (t: TaskRecordish) => { t.review = {verdict: "reject", at: 1}; }]) {
    const y = setup();
    const lane = askedLane(y);
    updateTask(y.ctx, lane.id, settle as never);
    expect(await reapLiveWorkers(y.ctx, [y.backend])).toEqual([lane.id]);
    expect(readTask(y.ctx, lane.id)?.live).toBeUndefined();
  }
});
type TaskRecordish = {state: string; review?: unknown; dismissed?: number};

test("a pending answer keeps the worker for its reattach; a failed one releases it", async () => {
  const {reapLiveWorkers} = await import("../src/exec/live");
  const x = setup();
  const asked = askedLane(x);
  const retry = answerOf(x, asked, "go with B");
  updateTask(x.ctx, retry.id, t => { t.state = "queued"; });
  expect(await reapLiveWorkers(x.ctx, [x.backend])).toEqual([]);
  updateTask(x.ctx, retry.id, t => { t.state = "failed"; });
  expect(await reapLiveWorkers(x.ctx, [x.backend])).toEqual([asked.id]);
});

test("a kept-alive worker holds its executor slot until an answer takes it over", async () => {
  const {slotUse} = await import("../src/engine/slots");
  const x = setup();
  const asked = askedLane(x);
  updateTask(x.ctx, asked.id, t => { t.executor = "codex"; });
  expect(slotUse([readTask(x.ctx, asked.id)!]).byExecutor).toEqual({codex: 1});
  expect(slotUse([{...readTask(x.ctx, asked.id)!, live: undefined}]).byExecutor).toEqual({});
  const retry = answerOf(x, asked, "go with B");
  updateTask(x.ctx, retry.id, t => { t.executor = "codex"; });
  expect(slotUse([readTask(x.ctx, asked.id)!, readTask(x.ctx, retry.id)!]).byExecutor).toEqual({codex: 1});
});

const workerStops = (x: ReturnType<typeof setup>) => x.f.count(O("orchestration", "worker-stop"));

test("dispatch.stop on managed work stops a lane waiting on its question and releases its live worker", async () => {
  const {callOp} = await import("../src/api/ops");
  const {registerWork} = await import("../src/dispatch/work");
  const {settleLiveReleases} = await import("../src/tasks/api");
  const x = setup();
  const root = createTask(x.ctx, {brief: {goal: "root", repo}, kind: null, requestedExecutor: null, timeoutS: 600});
  registerWork(x.ctx, root.id, {allowDelegation: true});
  updateTask(x.ctx, root.id, t => { t.state = "running"; });
  registerWork(x.ctx, x.task.id, {}, root.id);
  const asked = askedLane(x);
  await callOp(x.ctx, "dispatch.stop", {id: root.id, expect_rev: readTask(x.ctx, root.id)!.rev});
  await settleLiveReleases();
  expect(readTask(x.ctx, asked.id)?.state).toBe("stopped");
  expect(workerStops(x)).toBe(1);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
});

test("task.stop on a managed lane waiting on its question goes through stopWork and releases its live worker", async () => {
  const {callOp} = await import("../src/api/ops");
  const {registerWork} = await import("../src/dispatch/work");
  const {settleLiveReleases} = await import("../src/tasks/api");
  const x = setup();
  registerWork(x.ctx, x.task.id, {allowDelegation: true});
  const asked = askedLane(x);
  await callOp(x.ctx, "task.stop", {id: asked.id});
  await settleLiveReleases();
  expect(readTask(x.ctx, asked.id)?.state).toBe("stopped");
  expect(workerStops(x)).toBe(1);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
});

test("pacer stop releases a kept-alive lane's worker before the command returns", async () => {
  const {main} = await import("../src/cli");
  const x = setup();
  const asked = askedLane(x);
  const result = await main(["stop", asked.id], x.ctx);
  expect(result).toMatchObject({code: 0, out: `${asked.id} stopped`});
  expect(workerStops(x)).toBe(1);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
});

test("the supervision pass releases a live worker once it hits the idle limit", async () => {
  const {LIVE_IDLE_S} = await import("../src/exec/live");
  const {superviseTasks} = await import("../src/tasks/api");
  const x = setup();
  const asked = askedLane(x);
  await superviseTasks({...x.ctx, now: 1 + LIVE_IDLE_S - 1}, () => 0);
  expect(workerStops(x)).toBe(0);
  expect(readTask(x.ctx, asked.id)?.live).toBeDefined();
  await superviseTasks({...x.ctx, now: 1 + LIVE_IDLE_S}, () => 0);
  expect(workerStops(x)).toBe(1);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  expect(loadOrcaState(x.ctx).workers.ctx_live).toBeUndefined();
});

test("the supervision pass releases a live worker after dismissal, review, settlement or a stop whose release never ran", async () => {
  const {superviseTasks} = await import("../src/tasks/api");
  const ends: Array<(t: TaskRecordish) => void> = [
    t => { t.dismissed = 1; }, t => { t.review = {verdict: "reject", at: 1}; }, t => { t.state = "done"; }, t => { t.state = "stopped"; },
  ];
  for (const end of ends) {
    const x = setup();
    const asked = askedLane(x);
    updateTask(x.ctx, asked.id, end as never);
    await superviseTasks(x.ctx, () => 0);
    expect(workerStops(x)).toBe(1);
    expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  }
});

test("the supervision pass retries a live-worker release that failed", async () => {
  const {superviseTasks} = await import("../src/tasks/api");
  const unreachable = () => { throw Error("orca is not reachable"); };
  const x = setup([[O("orchestration", "worker-stop"), [unreachable, unreachable, envelope({dispatchId: "ctx_live", state: "stopped"})]]]);
  const asked = askedLane(x);
  updateTask(x.ctx, asked.id, t => { t.state = "stopped"; });
  await superviseTasks(x.ctx, () => 0);
  // The provider's stop failed, then the host's own closure of the same worker failed too.
  expect(workerStops(x)).toBe(2);
  expect(readTask(x.ctx, asked.id)?.live).toBeDefined();
  await superviseTasks(x.ctx, () => 0);
  expect(workerStops(x)).toBe(3);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
});

test("group: a cached parent worktree Orca no longer shows is created again", async () => {
  const x = setup([[O("worktree", "show", "--worktree", "path:/work/pacer-group-feature-x"), failure("selector_not_found")]]);
  updateOrcaState(x.ctx, s => { s.groups["repo-1:feature-x"] = {selector: "path:/work/pacer-group-feature-x"}; });
  await x.backend.runAttempt(x.ctx, x.cfg, updateTask(x.ctx, x.task.id, t => {t.group = "feature-x";}));
  const creates = x.f.calls.filter(a => a[1] === "worktree" && a[2] === "create");
  expect(creates.filter(a => arg(a, "--name") === "pacer-group-feature-x")).toHaveLength(1);
  expect(loadOrcaState(x.ctx).groups["repo-1:feature-x"]).toEqual({selector: "path:/work/pacer-group-feature-x"});
});

test("an agent that exits between the reattach check and the answer gets nothing typed; the answer respawns", async () => {
  const x = setup([liveWorker, [O("terminal", "show"), [envelope({terminal: {handle: terminal, connected: true, writable: true, incarnationId: "inc", agentIdentity: "codex"}}),
    envelope({terminal: {handle: terminal, connected: true, writable: true, incarnationId: "inc", agentIdentity: null}})]]]);
  const asked = askedLane(x);
  const retry = answerOf(x, asked, "go with B");
  await x.backend.runAttempt(x.ctx, x.cfg, retry);
  expect(sendsOf(x.f.calls, "go with B")).toHaveLength(0);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
  expect(readTask(x.ctx, retry.id)?.live?.worker).not.toBe("ctx_live");
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(1);
});

test("a live answer Orca fails to deliver is not swallowed: the worker is released, the timeline says why and the answer respawns", async () => {
  const x = setup([liveWorker, agentInForeground, [O("terminal", "send"), [failure("terminal_gone"), envelope({})]]]);
  const asked = askedLane(x);
  const retry = answerOf(x, asked, "go with B");
  await x.backend.runAttempt(x.ctx, x.cfg, retry);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
  expect(loadOrcaState(x.ctx).workers.ctx_live).toBeUndefined();
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(1);
  const {entries} = readActivity(x.ctx, {taskId: retry.id, kinds: ["message"]});
  expect(entries.map(e => e.text)).toContainEqual(expect.stringContaining("the answer could not be delivered (terminal_gone)"));
});

/** Orca stores a new worktree under its sanitized name (Tbe in Orca 1.4): `#`, `@` and other symbols become `-`. */
const orcaSanitized = (name: string) => name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/-+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "");
const sanitizingCreate = [O("worktree", "create"), (a: string[]) => {
  const name = orcaSanitized(arg(a, "--name"));
  return envelope({worktree: {id: `repo-1::/work/${name}`, path: `/work/${name}`, displayName: arg(a, "--name")}});
}] as Route;

test("a runner id with an account (codex#work) names its lane worktree the way Orca stores it, so the lane runs in Orca", async () => {
  const x = setup([sanitizingCreate]);
  const home = join(x.ctx.home, ".codex-work");
  mkdirSync(home, {recursive: true});
  writeFileSync(join(x.ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: "claude-code",
    accounts: {main: {kind: "claude"}, codex: {kind: "codex"}, work: {kind: "codex", home}}, routing: [{default: ["codex#work"]}]}));
  const cfg = {...x.cfg, id: "codex#work"};
  const out = await x.backend.runAttempt(x.ctx, cfg, x.task);
  expect(out.backend).toBe("orca");
  expect(x.direct).toBe(0);
  const create = x.f.calls.find(a => a[1] === "worktree" && a[2] === "create")!;
  expect(arg(create, "--name")).toBe(`pacer-${x.task.id}-codex-work`);
  expect(out.worktree).toBe(`/work/pacer-${x.task.id}-codex-work`);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "rm")).toBe(false);
});

/** Git in a lane's worktree, routed after the defaults: clean, with `commits` commits beyond its base, at LANE_HEAD. */
const LANE_HEAD = "b".repeat(40);
const laneGit = (root: () => string, commits: number | ((range: string) => number)): Route[] => [
  [["git", "-C"], (a: string[]) => a[2] !== root() ? raw("", 99)
    : a[3] === "status" ? raw("") : a[3] === "rev-list" ? raw(`${typeof commits === "number" ? commits : commits(a[5])}\n`)
    : a[3] === "rev-parse" ? raw(a[4] === "--verify" ? `${LANE_HEAD}\n` : `${root()}\n`) : raw("", 99)],
];
/** `orca worktree show` that knows a group lane: its own worktree by path or id, and the group parent listing it until removed. */
function groupLaneShows(ref: {x?: ReturnType<typeof setup>}, state: {lane: boolean}): Route[] {
  return [
    [O("worktree", "rm"), (a: string[]) => {if (arg(a, "--worktree") === `id:${ref.x!.wt}`) state.lane = false; return envelope({});}],
    groupShow(() => state.lane ? [ref.x!.wt] : []), groupClean,
    [O("worktree", "show"), (a: string[]) => {
      const sel = arg(a, "--worktree"), x = ref.x!;
      if (sel === `path:${x.root}` || sel === `id:${x.wt}`) return envelope({worktree: {id: x.wt, path: x.root, displayName: `pacer-${x.task.id}-codex`, isMainWorktree: false}});
      return envelope({worktree: {id: `repo-1::${repo}`, path: repo}});
    }],
  ];
}

test("stopping a running interactive lane removes its unused worktree and its now-empty group parent", async () => {
  const ref: {x?: ReturnType<typeof setup>} = {}, state = {lane: true};
  const x = ref.x = setup(groupLaneShows(ref, state), {}, {}, laneGit(() => ref.x!.root, 0));
  updateTask(x.ctx, x.task.id, t => {t.interactionMode = "conversation"; t.interactive = true; t.group = "feature-x"; t.state = "stopped";});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, readTask(x.ctx, x.task.id)!);
  expect(out.report).toContain("stopped by the planner");
  expect(out.worktree).toBeUndefined();
  expect(x.f.count(O("orchestration", "worker-stop"))).toBe(1);
  expect(closes(x.f.calls)).toHaveLength(1);
  const removes = x.f.calls.filter(a => a[1] === "worktree" && a[2] === "rm").map(a => arg(a, "--worktree"));
  expect(removes).toEqual([`id:${x.wt}`, "id:repo-1::/work/pacer-group-feature-x"]);
  expect(loadOrcaState(x.ctx).groups).toEqual({});
  expect(attemptLog(out)).toContain("removed group feature-x parent worktree");
});

test("stopping a lane that holds work keeps its worktree and group parent for review", async () => {
  const ref: {x?: ReturnType<typeof setup>} = {}, state = {lane: true};
  const x = ref.x = setup(groupLaneShows(ref, state), {}, {}, laneGit(() => ref.x!.root, 2));
  updateTask(x.ctx, x.task.id, t => {t.interactionMode = "conversation"; t.interactive = true; t.group = "feature-x"; t.state = "stopped";});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, readTask(x.ctx, x.task.id)!);
  expect(out.worktree).toBe(x.root);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "rm")).toBe(false);
  expect(attemptLog(out)).toContain("it holds work");
});

test("pacer stop on a kept-alive group lane also removes its unused worktree and the empty group parent", async () => {
  const {main} = await import("../src/cli");
  const ref: {x?: ReturnType<typeof setup>} = {}, state = {lane: true};
  const x = ref.x = setup(groupLaneShows(ref, state), {}, {}, laneGit(() => ref.x!.root, 0));
  updateOrcaState(x.ctx, s => { s.groups["repo-1:feature-x"] = {selector: "path:/work/pacer-group-feature-x"}; });
  const asked = askedLane(x);
  updateTask(x.ctx, asked.id, t => {t.interactive = true; t.group = "feature-x";});
  const recorded = readTask(x.ctx, asked.id)!.worktree!;
  expect(await main(["stop", asked.id], x.ctx)).toMatchObject({code: 0});
  expect(workerStops(x)).toBe(1);
  expect(closes(x.f.calls)).toHaveLength(1);
  const removes = x.f.calls.filter(a => a[1] === "worktree" && a[2] === "rm").map(a => arg(a, "--worktree"));
  expect(removes).toEqual([`id:${x.wt}`, "id:repo-1::/work/pacer-group-feature-x"]);
  expect(loadOrcaState(x.ctx).groups).toEqual({});
  // The task forgets the removed path, so a later retry starts fresh instead of asking for a missing worktree.
  expect(readTask(x.ctx, asked.id)?.worktree).toBeUndefined();
  // and records that pacer removed it, so an answer may start from the lane's base.
  expect(readTask(x.ctx, asked.id)?.worktreeReleased).toEqual({at: x.ctx.now, path: recorded});
});

for (const settled of ["done", "partial", "failed", "limit"] as const) {
  test(`a lane whose kept-alive worker is reaped after it settled ${settled} releases its unused worktree`, async () => {
    const {reapLiveWorkers} = await import("../src/exec/live");
    const ref: {x?: ReturnType<typeof setup>} = {}, state = {lane: true};
    const x = ref.x = setup(groupLaneShows(ref, state), {}, {}, laneGit(() => ref.x!.root, 0));
    const asked = askedLane(x);
    updateTask(x.ctx, asked.id, t => { t.state = settled; t.result = {status: settled, executor: "codex", model: null, files: "", report: "r", backend: "orca", worktree: x.root}; });
    await reapLiveWorkers(x.ctx, [x.backend]);
    expect(workerStops(x)).toBe(1);
    expect(x.f.calls.filter(a => a[1] === "worktree" && a[2] === "rm").map(a => arg(a, "--worktree"))).toEqual([`id:${x.wt}`]);
    expect(readTask(x.ctx, asked.id)?.worktree).toBeUndefined();
    expect(readTask(x.ctx, asked.id)?.result?.worktree).toBeUndefined();
    expect(readTask(x.ctx, asked.id)?.worktreeReleased).toEqual({at: x.ctx.now, path: x.root});
  });
}

test("an answer round that settles with no work releases the lane's worktree; one with commits keeps it", async () => {
  for (const commits of [0, 1]) {
    const ref: {x?: ReturnType<typeof setup>} = {}, state = {lane: true};
    const x = ref.x = setup([liveWorker, agentInForeground, [O("terminal", "send"), envelope({})], ...groupLaneShows(ref, state)], {}, {}, laneGit(() => ref.x!.root, commits));
    const asked = askedLane(x);
    const retry = answerOf(x, asked, "go with B");
    const out = await x.backend.runAttempt(x.ctx, x.cfg, retry);
    const removes = x.f.calls.filter(a => a[1] === "worktree" && a[2] === "rm").map(a => arg(a, "--worktree"));
    expect(removes).toEqual(commits ? [] : [`id:${x.wt}`]);
    expect(out.worktree).toBe(commits ? x.root : undefined);
    expect(readTask(x.ctx, retry.id)?.worktree).toBe(commits ? x.root : undefined);
  }
});

test("an idle-expired lane keeps its worktree, so its open question can still be answered", async () => {
  const {LIVE_IDLE_S, reapLiveWorkers} = await import("../src/exec/live");
  const {answer} = await import("../src/core/tasks");
  const ref: {x?: ReturnType<typeof setup>} = {}, state = {lane: true};
  const x = ref.x = setup(groupLaneShows(ref, state), {}, {}, laneGit(() => ref.x!.root, 0));
  const asked = askedLane(x);
  updateTask(x.ctx, asked.id, t => { t.result = {status: "needs_input", executor: "codex", model: null, files: "", report: "asked", backend: "orca", worktree: x.root}; });
  await reapLiveWorkers({...x.ctx, now: 1 + LIVE_IDLE_S}, [x.backend]);
  expect(workerStops(x)).toBe(1);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "rm")).toBe(false);
  expect(readTask(x.ctx, asked.id)).toMatchObject({state: "needs_input", worktree: x.root, result: {worktree: x.root}});
  // The answer starts a new attempt from the lane's worktree head, as before the worker was released.
  updateTask(x.ctx, asked.id, t => { t.brief.repo = mkdtempSync(join(tmpdir(), "pacer-idle-")); });
  const inputs: {brief: {base?: string}}[] = [];
  await answer(x.ctx, asked.id, "go with B", {}, {delegate: async (c, input) => { inputs.push(input); const create = () => createTask(c, {brief: input.brief, kind: null, requestedExecutor: "codex", timeoutS: 1}); return input.commitWith ? input.commitWith(create) : create(); }});
  expect(inputs[0]?.brief.base).toBe(LANE_HEAD);
});

test("answering a kept-alive current checkout preserves its first start commit", async () => {
  const x = setup([liveWorker, agentInForeground, [O("terminal", "send"), envelope({})]]);
  askedLane(x);
  const asked = updateTask(x.ctx, x.task.id, t => {
    t.startSha = "b".repeat(40);
    t.placement = { requested: "current", mode: "current", why: "test" };
  });
  const retry = answerOf(x, asked, "continue");
  await x.backend.runAttempt(x.ctx, x.cfg, retry);
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(0);
  expect(readTask(x.ctx, retry.id)?.startSha).toBe(asked.startSha);
  expect(progressBase(readTask(x.ctx, retry.id)!)).toBe(asked.startSha!);
});

// SP10: the bundled pacer-exec-orca provider sequences the attempt; the host owns every effect, fallback and closure.

test("the provider serves a whole Orca attempt as a child process through the production registry", async () => {
  const x = setup();
  // No in-process caller: the route reaches the bundled provider spawned for this home.
  const out = await makeRoute(x.routeDeps).runAttempt(x.ctx, x.cfg, x.task);
  expect(out).toMatchObject({backend: "orca", exec: {code: 0}, worktree: x.root});
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(1);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(await makeRoute(x.routeDeps).available(x.ctx, validateStrategy({planner: "codex", providers: {codex: {}}, execution: {backend: "orca"}}, "/x"))).toBe(true);
});

test("the start intent is durable before worker-start and cleared once the dispatch is bound", async () => {
  let seen: Record<string, unknown> = {};
  const x = setup([[O("orchestration", "worker-start"), () => {
    seen = structuredClone(loadOrcaState(x.ctx).starting);
    return envelope({dispatchId: dispatch, state: "ready", effects: []});
  }]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(Object.values(seen)).toEqual([expect.objectContaining({taskId: x.task.id, attempt: 1, terminal, run: "run_1",
    requestId: expect.stringMatching(/^[0-9a-f]{32}$/), worktree: expect.objectContaining({id: x.wt})})]);
  expect(loadOrcaState(x.ctx).starting).toEqual({});
  expect(readFileSync(out.attempt.log, "utf8")).toMatch(/start intent [0-9a-f]{32} recorded for term_agent/);
});

test("a start already recorded for this attempt refuses another worker, releases this attempt's terminal and never falls back", async () => {
  const x = setup();
  updateOrcaState(x.ctx, s => { s.starting.term_other = {taskId: x.task.id, attempt: 1, terminal: "term_other", run: "run_1", requestId: "r", worktree: null, at: 1}; });
  await expect(x.backend.runAttempt(x.ctx, x.cfg, x.task)).rejects.toMatchObject({code: "conflict"});
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(0);
  expect(x.direct).toBe(0);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(loadOrcaState(x.ctx).starting.term_other).toBeDefined();
});

test("a start intent its runner left behind is reconciled as an uncertain start and never started again", async () => {
  const {START_INTENT_STALE_S} = await import("../src/exec/orca/cleanup");
  const x = setup();
  const at = x.ctx.now;
  updateOrcaState(x.ctx, s => { s.starting[terminal] = {taskId: x.task.id, attempt: 1, terminal, run: "run_1", requestId: "r",
    worktree: {id: x.wt, path: x.root, name: `pacer-${x.task.id}-codex`}, at}; });
  await reconcileHostWork({...x.ctx, now: at + START_INTENT_STALE_S - 1});
  expect(loadOrcaState(x.ctx).starting[terminal]).toBeDefined();
  // A runner that still lives settles its own start, however long worker-start and its lookups take.
  updateOrcaState(x.ctx, s => { s.starting[terminal]!.pid = process.pid; });
  await reconcileHostWork({...x.ctx, now: at + 10 * START_INTENT_STALE_S});
  expect(loadOrcaState(x.ctx).starting[terminal]).toBeDefined();
  expect(x.f.count(O("orchestration", "worker-list"))).toBe(0);
  updateOrcaState(x.ctx, s => { delete s.starting[terminal]!.pid; });
  await reconcileHostWork({...x.ctx, now: at + START_INTENT_STALE_S});
  const state = loadOrcaState(x.ctx);
  expect(state.starting).toEqual({});
  expect(state.uncertain).toEqual({});
  expect(state.stranded[x.task.id]).toMatchObject({id: x.wt, path: x.root});
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(0);
});

test("a provider that dies after worker start: the host stops the worker, closes the exact terminal and fails without fallback", async () => {
  const x = setup([], {}, {}, [], {failOn: "capability.orca.wait"});
  await expect(x.backend.runAttempt(x.ctx, x.cfg, x.task)).rejects.toThrow("plugin stdout closed");
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", dispatch, "--json"]);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(x.direct).toBe(0);
  expect(loadOrcaState(x.ctx).workers).toEqual({});
  expect(await lease(x)).toBe(false);
});

test("a provider that dies before any worker exists falls back to direct with the reason in the attempt log", async () => {
  const x = setup([], {}, {}, [], {failOn: "capability.orca.terminal"});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("direct");
  expect(x.direct).toBe(1);
  expect(readFileSync(x.directLog, "utf8")).toContain("direct backend: Orca fallback (the Orca executor plugin failed: plugin stdout closed)");
  expect(x.f.calls.some(a => a[1] === "terminal" && a[2] === "create" && a.includes("--command"))).toBe(false);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "rm")).toBe(true);
});

test("a provider that asks for direct after starting a worker is refused; the host settles the worker", async () => {
  const handlers = {"executor.run": async (params: unknown, host: HostClient) => {
    const ids = {taskId: (params as {task: {id: string}}).task.id, attempt: 1};
    for (const step of ["liveAnswer", "prepare", "place", "terminal", "start"]) await host.call(`capability.orca.${step}`, ids);
    return {orca: {fallback: {reason: "provider wants direct"}}};
  }};
  const x = setup([], {}, {}, [], {handlers});
  await expect(x.backend.runAttempt(x.ctx, x.cfg, x.task)).rejects.toMatchObject({code: "conflict"});
  expect(x.direct).toBe(0);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", dispatch, "--json"]);
  expect(closes(x.f.calls)).toHaveLength(1);
});

test("Orca effects are bound to the host-issued attempt: out of order, cross-task, foreign provider and unissued calls are refused", async () => {
  const handlers = {"executor.run": async (params: unknown, host: HostClient) => {
    const id = (params as {task: {id: string}}).task.id, refused: unknown[] = [];
    const attempt = async (method: string, input: object) => { try { await host.call(method, input); refused.push("allowed"); } catch (e) { refused.push((e as {code?: string}).code); } };
    await attempt("capability.orca.start", {taskId: id, attempt: 1});
    await attempt("capability.orca.wait", {taskId: id, attempt: 1});
    await attempt("capability.orca.prepare", {taskId: "t-20990101-000000-ffff", attempt: 1});
    await attempt("capability.orca.prepare", {taskId: id, attempt: 2});
    await attempt("capability.orca.prepare", {taskId: id, attempt: 1, argv: ["sh"]});
    await attempt("capability.orca.stop", {taskId: id, attempt: 1});
    throw Object.assign(Error(JSON.stringify(refused)), {code: "probe"});
  }};
  const x = setup([], {}, {}, [], {handlers});
  const error = await x.backend.runAttempt(x.ctx, x.cfg, x.task).catch(e => e as Error);
  expect(x.direct).toBe(1);
  expect(readFileSync(x.directLog, "utf8")).toContain("the Orca executor plugin failed");
  const probe = JSON.parse(String(readFileSync(x.directLog, "utf8").match(/plugin failed: (\[.*\])\)/)?.[1]));
  expect(probe).toEqual(["capability_denied", "capability_denied", "capability_denied", "capability_denied", "invalid_input", "capability_denied"]);
  expect(x.f.count(O("terminal", "create"))).toBe(0);
  void error;
});

test("executor.sessionState reports the live worker's exact terminal through the provider", async () => {
  const {orcaLiveSessionState} = await import("../src/plugins/executor-orca");
  const x = setup([
    [O("orchestration", "worker-show"), envelope({worker: {state: "ready"}})],
    [O("terminal", "show"), envelope({terminal: {handle: terminal, incarnationId: "inc", connected: true, writable: true, agentIdentity: "codex"}})],
  ]);
  const asked = askedLane(x);
  expect(await orcaLiveSessionState(x.ctx, readTask(x.ctx, asked.id)!)).toEqual({state: "running", host: "orca", handle: terminal});
  const y = setup([[O("orchestration", "worker-show"), envelope({worker: {state: "succeeded"}})]]);
  const settled = askedLane(y);
  expect(await orcaLiveSessionState(y.ctx, readTask(y.ctx, settled.id)!)).toEqual({state: "exited", host: "orca", handle: terminal});
  expect(y.f.count(O("orchestration", "worker-stop"))).toBe(0);
});

test("a cancelled owning call ends supervision; the host stops the worker and closes its terminal without fallback", async () => {
  const x = setup([
    [O("orchestration", "check"), envelope({messages: []})],
    [O("orchestration", "worker-show"), envelope({worker: {state: "ready"}})],
  ], {}, {}, [], {deadlineMs: 300});
  updateTask(x.ctx, x.task.id, t => { t.timeoutS = 60; });
  // Real Orca calls take time; yield so the owning call's deadline timer can fire.
  const ctx = {...x.ctx, run: async (...a: Parameters<typeof x.ctx.run>) => { await Bun.sleep(2); return x.ctx.run(...a); }};
  const started = Date.now();
  await expect(x.backend.runAttempt(ctx, x.cfg, readTask(x.ctx, x.task.id)!)).rejects.toBeDefined();
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", dispatch, "--json"]);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(x.direct).toBe(0);
  expect(loadOrcaState(x.ctx).workers).toEqual({});
});

test("brief shell metacharacters reach only worker-start --spec, never the composed terminal command", async () => {
  const x = setup();
  const goal = `Fix it; $(touch /tmp/pwned) \`id\` "quoted" 'single' && echo done | tee x > y`;
  updateTask(x.ctx, x.task.id, t => { t.brief.goal = goal; });
  await x.backend.runAttempt(x.ctx, x.cfg, readTask(x.ctx, x.task.id)!);
  const create = x.f.calls.find(a => a[1] === "terminal" && a[2] === "create" && a.includes("--command"))!;
  const command = arg(create, "--command");
  for (const piece of ["$(touch", "`id`", "Fix it", "tee x"]) expect(command).not.toContain(piece);
  expect(command.startsWith("exec env ")).toBe(true);
  const start = x.f.calls.find(a => a[2] === "worker-start")!;
  expect(arg(start, "--spec")).toContain(goal);
  expect(start.filter(a => a.includes(goal))).toHaveLength(1);
});

test("a reattach that fails after the answer is typed stops the live worker and never runs the answer directly", async () => {
  const x = setup([liveWorker, agentInForeground, [O("terminal", "send"), envelope({})]], {}, {
    admission: {begin: () => { throw Error("Desktop update maintenance is reserved"); }, bind: bindOrcaWorkSync, finishOrca: finishOrcaWorkSync, finish: finishWorkSync},
  });
  const asked = askedLane(x);
  const retry = answerOf(x, asked, "go with B");
  await expect(x.backend.runAttempt(x.ctx, x.cfg, retry)).rejects.toBeDefined();
  expect(sendsOf(x.f.calls, "go with B")).toHaveLength(1);
  expect(x.direct).toBe(0);
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(readTask(x.ctx, retry.id)?.live).toBeUndefined();
});

test("a provider that skips the live-answer check cannot place a worker; the lane's live worker is released before direct runs", async () => {
  const handlers = {"executor.run": async (params: unknown, host: HostClient) =>
    host.call("capability.orca.prepare", {taskId: (params as {task: {id: string}}).task.id, attempt: 1})};
  const x = setup([liveWorker, agentInForeground], {}, {}, [], {handlers});
  const asked = askedLane(x);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, answerOf(x, asked, "go with B"));
  expect(out.backend).toBe("direct");
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "create")).toBe(false);
  expect(readFileSync(x.directLog, "utf8")).toContain("Orca attempt is new; this effect is not issued now");
});

test("a refusal the host did not make is not accepted; the host abandons its effects and falls back", async () => {
  const handlers = {"executor.run": async (params: unknown, host: HostClient) => {
    const ids = {taskId: (params as {task: {id: string}}).task.id, attempt: 1};
    for (const step of ["liveAnswer", "prepare", "place", "terminal"]) await host.call(`capability.orca.${step}`, ids);
    return {orca: {refused: {reason: "provider says no"}}};
  }};
  const x = setup([], {}, {}, [], {handlers});
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.backend).toBe("direct");
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(x.f.calls.some(a => a[1] === "worktree" && a[2] === "rm")).toBe(true);
  expect(x.f.count(O("orchestration", "worker-start"))).toBe(0);
  expect(await lease(x)).toBe(false);
});

test("a provider outcome that disagrees with host supervision is refused and the worker is settled by the host", async () => {
  const handlers = {"executor.run": async (params: unknown, host: HostClient) => {
    const ids = {taskId: (params as {task: {id: string}}).task.id, attempt: 1};
    for (const step of ["liveAnswer", "prepare", "place", "terminal", "start", "wait"]) await host.call(`capability.orca.${step}`, ids);
    return host.call("capability.orca.finish", {...ids, code: 0, timedOut: false, settled: true, summary: "all good", keepAlive: false});
  }};
  const x = setup([[O("orchestration", "check"), envelope({messages: [{id: "m1", type: "worker_done", subject: "done", body: "broke it",
    payload: JSON.stringify({taskId: "TASK", dispatchId: dispatch, outcome: "failed"})}], deliveryId: "d1"})]], {}, {}, [], {handlers});
  await expect(x.backend.runAttempt(x.ctx, x.cfg, x.task)).rejects.toMatchObject({code: "conflict"});
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", dispatch, "--json"]);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(x.direct).toBe(0);
});

test("a large worker_done report stays within the outcome contract", async () => {
  const body = "x".repeat(300_000);
  const x = setup([[O("orchestration", "check"), envelope({messages: [{id: "m1", type: "worker_done", subject: "done", body,
    payload: JSON.stringify({taskId: "TASK", dispatchId: dispatch, outcome: "succeeded"})}], deliveryId: "d1"})]]);
  const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
  expect(out.exec.code).toBe(0);
  expect(out.exec.stdout.length).toBeLessThanOrEqual(262_144);
  expect(out.report.endsWith("x".repeat(100))).toBe(true);
});

test("releasing a kept-alive lane while the provider is disabled stays host closure: the worker is stopped and its terminal closed", async () => {
  const x = setup();
  const asked = askedLane(x);
  const {pluginRegistry} = await import("../src/plugins");
  writeFileSync(join(x.ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  await pluginRegistry(x.ctx).disable(x.ctx, "pacer-exec-orca");
  const {releaseLiveWorker} = await import("../src/exec/live");
  await releaseLiveWorker(x.ctx, readTask(x.ctx, asked.id)!, "the task was stopped");
  expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
  expect(closes(x.f.calls)).toHaveLength(1);
  expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
});

test("releasing a kept-alive lane while the enabled provider fails stays host closure: the worker is stopped and its terminal closed", async () => {
  for (const stop of [async () => { throw Error("plugin stdout closed"); }, async () => ({unexpected: true})]) {
    const x = setup([], {}, {}, [], {handlers: {"executor.stop": stop}});
    const asked = askedLane(x);
    await x.backend.live!.release(x.ctx, readTask(x.ctx, asked.id)!, "the task was stopped");
    expect(x.f.calls).toContainEqual(["orca", "orchestration", "worker-stop", "--dispatch", "ctx_live", "--json"]);
    expect(closes(x.f.calls)).toHaveLength(1);
    expect(readTask(x.ctx, asked.id)?.live).toBeUndefined();
  }
});

// The owning call runs one capability operation at a time (CallAuthority.exclusive), so a phase check cannot be raced.
test("concurrent Orca effects for one attempt are refused: an answer is typed once and one admission lease is taken", async () => {
  const codes: unknown[] = [];
  const settle = async (calls: Promise<unknown>[]) => {
    for (const r of await Promise.allSettled(calls)) codes.push(r.status === "fulfilled" ? "allowed" : (r.reason as {code?: string}).code);
  };
  const live = {"executor.run": async (params: unknown, host: HostClient) => {
    const ids = {taskId: (params as {task: {id: string}}).task.id, attempt: 1};
    await settle([host.call("capability.orca.liveAnswer", ids), host.call("capability.orca.liveAnswer", ids)]);
    throw Object.assign(Error("probe"), {code: "probe"});
  }};
  const x = setup([liveWorker, agentInForeground, [O("terminal", "send"), envelope({})]], {}, {}, [], {handlers: live});
  const retry = answerOf(x, askedLane(x), "go with B");
  await expect(x.backend.runAttempt(x.ctx, x.cfg, retry)).rejects.toBeDefined();
  expect(codes.sort()).toEqual(["allowed", "conflict"]);
  expect(sendsOf(x.f.calls, "go with B")).toHaveLength(1);

  codes.length = 0;
  let begun = 0;
  const prepare = {"executor.run": async (params: unknown, host: HostClient) => {
    const ids = {taskId: (params as {task: {id: string}}).task.id, attempt: 1};
    await host.call("capability.orca.liveAnswer", ids);
    await settle([host.call("capability.orca.prepare", ids), host.call("capability.orca.prepare", ids)]);
    return {orca: {fallback: {reason: "probe done"}}};
  }};
  const y = setup([], {}, {admission: {begin: (...a: Parameters<typeof beginWorkSync>) => { begun++; return beginWorkSync(...a); },
    bind: bindOrcaWorkSync, finishOrca: finishOrcaWorkSync, finish: finishWorkSync}}, [], {handlers: prepare});
  expect((await y.backend.runAttempt(y.ctx, y.cfg, y.task)).backend).toBe("direct");
  expect(codes.sort()).toEqual(["allowed", "conflict"]);
  expect(begun).toBe(1);
  expect(await lease(y)).toBe(false);
});

test("a host placement refusal stands even if the provider asks for direct or dies", async () => {
  const fallbackInstead = {"executor.run": async (params: unknown, host: HostClient) => {
    const ids = {taskId: (params as {task: {id: string}}).task.id, attempt: 1};
    await host.call("capability.orca.liveAnswer", ids);
    await host.call("capability.orca.prepare", ids);
    return {orca: {fallback: {reason: "provider prefers direct"}}};
  }};
  for (const provider of [{handlers: fallbackInstead}, {failOn: "capability.orca.place"}]) {
    const x = setup([[["git", "-C", repo, "status"], raw(" M file\n")]], {worktree: "current"}, {}, [], provider);
    const out = await x.backend.runAttempt(x.ctx, x.cfg, x.task);
    expect(out.backend).toBe("orca");
    expect(out.report).toContain("uncommitted changes");
    expect(x.direct).toBe(0);
  }
});
