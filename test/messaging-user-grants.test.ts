import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { main, cliDeps } from "../src/cli";
import { callOp } from "../src/api/ops";
import { delegate, userStartedWork } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { authorizeWorkGrant, getWork } from "../src/dispatch/work";
import { loadStrategy, validateStrategy } from "../src/config/strategy";
import { runTask } from "../src/tasks/runner";
import { defaultHooks } from "../src/classify/hooks";
import { certifyExecutor, resolveEnforcementTarget } from "../src/dispatch/enforcement";
import { resolvePolicyRepoInput } from "../src/core/project-policy";
import { sendMessage } from "../src/messaging/send";
import { userStartedGrants, parseMessagingConfig } from "../src/messaging/types";
import type { Ctx } from "../src/types";
import type { TaskRecord } from "../src/tasks/types";

function setup(extra = "", git = false) {
  const ctx = fakeCtx({ now: Date.now() / 1000, ...(git ? { run: realRun } : {}) });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n${extra}`);
  return { ctx, repo: git ? gitRepo() : tmpDir() };
}

async function asTTY<T>(fn: () => Promise<T>): Promise<T> {
  const stdin = process.stdin as { isTTY?: boolean }, before = stdin.isTTY, spawn = cliDeps.spawnRunner;
  stdin.isTTY = true; cliDeps.spawnRunner = () => 1;
  try { return await fn(); } finally { stdin.isTTY = before; cliDeps.spawnRunner = spawn; }
}

const cliDelegate = (ctx: Ctx, repo: string, ...flags: string[]) =>
  asTTY(() => main(["delegate", "--goal", "do it", "--repo", repo, "--json", ...flags], ctx)).then(r => { expect(r.code).toBe(0); return JSON.parse(r.out) as TaskRecord; });

test("a CLI delegate from a TTY human registers strict managed work that can delegate", async () => {
  const { ctx, repo } = setup();
  const t = await cliDelegate(ctx, repo);
  expect(t.origin).toBe("human");
  expect(getWork(ctx, t.id)).toMatchObject({ parentId: null, depth: 0, options: { allowDelegation: true, delegationEnforcement: "strict" } });
});

test("--no-grant keeps a human task unmanaged", async () => {
  const { ctx, repo } = setup();
  const t = await cliDelegate(ctx, repo, "--no-grant");
  expect(t.origin).toBe("human");
  expect(getWork(ctx, t.id)).toBeNull();
});

test("grant:false on task.delegate opts out; an app delegate is managed by default", async () => {
  const { ctx, repo } = setup();
  const deps = { appAuthenticated: true, client: "app", spawnRunner: () => 1 };
  const managed = await callOp(ctx, "task.delegate", { goal: "a", repo }, deps) as { task_id: string };
  const plain = await callOp(ctx, "task.delegate", { goal: "b", repo, grant: false }, deps) as { task_id: string };
  expect(getWork(ctx, managed.task_id)?.options.allowDelegation).toBe(true);
  expect(getWork(ctx, plain.task_id)).toBeNull();
});

test("a planner delegate is not managed", async () => {
  const { ctx, repo } = setup();
  const planner = { ...ctx, env: { ...ctx.env, CLAUDECODE: "1" } };
  const r = await callOp(planner, "task.delegate", { goal: "a", repo }, { spawnRunner: () => 1 }) as { task_id: string };
  expect(readTask(ctx, r.task_id)!.origin).toMatch(/^external:/);
  expect(getWork(ctx, r.task_id)).toBeNull();
  // A non-TTY CLI caller is not the human either.
  const r2 = await main(["delegate", "--goal", "x", "--repo", repo, "--json"], ctx);
  expect(getWork(ctx, JSON.parse(r2.out).id)).toBeNull();
});

test("a conversation is not managed", () => {
  const { ctx, repo } = setup();
  const s = loadStrategy(ctx);
  const created = createTask(ctx, { brief: { goal: "talk", repo }, kind: null, requestedExecutor: null, timeoutS: 600, interactionMode: "conversation" });
  expect(userStartedWork(ctx, s, { brief: created.brief }, created, "human")).toBe(false);
  expect(userStartedWork(ctx, s, { brief: created.brief }, { ...created, interactionMode: "delegated" }, "human")).toBe(true);
});

test("config grants.user_started_tasks off registers no work", async () => {
  const { ctx, repo } = setup("messaging: {grants: {user_started_tasks: \"off\"}}\n");
  const t = await cliDelegate(ctx, repo);
  expect(t.origin).toBe("human");
  expect(getWork(ctx, t.id)).toBeNull();
  expect(userStartedGrants(undefined)).toBe(true);
  expect(userStartedGrants(parseMessagingConfig({ grants: { user_started_tasks: "off" } }))).toBe(false);
});

test("a retry keeps the original's choice", async () => {
  const { ctx, repo } = setup();
  const plain = delegate(ctx, { brief: { goal: "a", repo }, origin: "human", grant: false }, () => 1);
  const managed = delegate(ctx, { brief: { goal: "b", repo }, origin: "human" }, () => 1);
  expect(getWork(ctx, delegate(ctx, { brief: { goal: "a", repo }, origin: "human", retryOf: plain.id }, () => 1).id)).toBeNull();
  expect(getWork(ctx, delegate(ctx, { brief: { goal: "b", repo }, origin: "human", retryOf: managed.id }, () => 1).id)).not.toBeNull();
});

async function strictRun(ctx: Ctx, id: string, runAttempt: (runCtx: Ctx, cfg: { id: string; model?: string | null }, task: TaskRecord) => Promise<unknown>) {
  const repo = readTask(ctx, id)!.brief.repo;
  const s = validateStrategy({ execution: { launch_mode: "headless" }, planner: "codex", accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex", usage: "unmetered" } }, runners: { "claude-code": { models: [{ id: "provider/deep", tier: "frontier" }] } }, dispatch: { timeoutMs: 5000 } }, "test");
  const binary = join(ctx.home, "claude-bin"); writeFileSync(binary, "claude");
  ctx.which = name => name === "claude" ? binary : null;
  const previousRun = ctx.run;
  ctx.run = (argv, timeout, options) => argv[0] === binary ? Promise.resolve({ code: 0, stdout: "2.1.281 (Claude Code)", stderr: "" }) : previousRun(argv, timeout, options);
  const target = await resolveEnforcementTarget(ctx, s, "claude-code", (await resolvePolicyRepoInput(ctx, repo)).path);
  await certifyExecutor(ctx, target, async () => ({ attempted: true, blocked: true, childStarted: false, entries: ["Agent", "Task"] }));
  return runTask(ctx, id, {
    loadStrategy: () => s, hooks: defaultHooks, verifyRepo: async () => ({ files: "" }),
    computeStatus: async (c: Ctx) => ({ generatedAt: c.now, strategy: "test", planner: "codex", mode: "normal", disabled: false, calendarPace: false, providers: [{ id: "claude-code", usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false }], executors: { ranked: [], excluded: [] } }),
    runAttempt,
  } as never);
}
const ok = (ctx: Ctx, cfg: { id: string; model?: string | null }) => ({ exec: { code: 0, stdout: "ok", stderr: "", timedOut: false }, report: "ok", attempt: { executor: cfg.id, model: cfg.model ?? null, startedAt: ctx.now, endedAt: ctx.now + 1, exitCode: 0, timedOut: false, limitHit: false, log: "" } });

test("a managed user task can dispatch.child with its grant during its run, and a message resumes it", async () => {
  const { ctx, repo } = setup("", true);
  const t = await cliDelegate(ctx, repo);
  const children: string[] = [];
  await strictRun(ctx, t.id, async (runCtx, cfg) => {
    // The executor's own `pacer dispatch child` carries only its work grant.
    const now = { ...runCtx, now: Date.now() / 1000, env: { PACER_ROLE: "executor", PACER_TASK_ID: t.id, PACER_WORK_GRANT: runCtx.env.PACER_WORK_GRANT! } };
    expect(authorizeWorkGrant(now, runCtx.env.PACER_WORK_GRANT!).taskId).toBe(t.id);
    const child = await callOp(now, "dispatch.child", { goal: "sub step", requestId: "c1" }, { spawnRunner: () => 1 }) as { task_id: string };
    children.push(child.task_id);
    return ok(ctx, cfg);
  });
  expect(children).toHaveLength(1);
  expect(getWork(ctx, children[0])).toMatchObject({ parentId: t.id, rootId: t.id });
  updateTask(ctx, t.id, x => { x.state = "done"; x.run = { dir: tmpDir(), attempt: 1, executor: "claude-code", startedAt: 1, mode: "new", workdir: repo, logFile: "/dev/null", agentSession: { id: "sid-u", source: "header" } }; });
  const spawned: string[] = [];
  const r = await sendMessage({ ...ctx, now: Date.now() / 1000 }, { to: `task:${t.id}`, body: "one more thing", requestId: "m1" }, { appAuthenticated: true, spawnRunner: (_c, id) => { spawned.push(id); return 1; } });
  expect(r.delivery).toBe("turn_started");
  expect(spawned).toEqual([t.id]);
  expect(readTask(ctx, t.id)!.pendingTurn?.session?.id).toBe("sid-u");
});
