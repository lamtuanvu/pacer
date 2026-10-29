import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { delegate } from "../src/tasks/api";
import { readTask, updateTask } from "../src/tasks/store";
import { getWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { loadStrategy, validateStrategy } from "../src/config/strategy";
import { runTask } from "../src/tasks/runner";
import { defaultHooks } from "../src/classify/hooks";
import { certifyExecutor, resolveEnforcementTarget } from "../src/dispatch/enforcement";
import { resolvePolicyRepoInput } from "../src/core/project-policy";
import { taskDetail } from "../src/core/task-detail";
import type { Ctx } from "../src/types";
import type { TaskRecord } from "../src/tasks/types";

function setup(strategy = "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n", git = false) {
  const ctx = fakeCtx({ now: Date.now() / 1000, ...(git ? { run: realRun } : {}) });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), strategy);
  return { ctx, repo: git ? gitRepo() : tmpDir() };
}
/** Installs a fake claude binary; `certified` also stores a passing native-control certificate for `repo`. */
async function claude(ctx: Ctx, repo: string, certified: boolean) {
  const binary = join(ctx.home, "claude-bin"); writeFileSync(binary, "claude");
  const codex = join(ctx.home, "codex-bin"); writeFileSync(codex, "codex");
  ctx.which = name => name === "claude" ? binary : name === "codex" ? codex : null;
  const previousRun = ctx.run;
  ctx.run = (argv, timeout, options) => argv[0] === binary ? Promise.resolve({ code: 0, stdout: "2.1.281 (Claude Code)", stderr: "" }) : previousRun(argv, timeout, options);
  if (!certified) return;
  const target = await resolveEnforcementTarget(ctx, loadStrategy(ctx), "claude-code", (await resolvePolicyRepoInput(ctx, repo)).path);
  await certifyExecutor(ctx, target, async () => ({ attempted: true, blocked: true, childStarted: false, entries: ["Agent", "Task"] }));
}
const human = (ctx: Ctx, repo: string, extra: Partial<Parameters<typeof delegate>[1]> = {}) =>
  delegate(ctx, { brief: { goal: `goal ${Math.random()}`, repo }, origin: "human", ...extra }, () => 1);

test("a user task is managed only when an executor it could route to is certified for strict work", async () => {
  const { ctx, repo } = setup();
  await claude(ctx, repo, true);
  const managed = human(ctx, repo);
  expect(getWork(ctx, managed.id)?.options).toMatchObject({ allowDelegation: true, delegationEnforcement: "strict" });
  expect(managed.managedSkip).toBeUndefined();
  // The requested executor is the only route: Codex cannot block its own sub-agents yet.
  const codex = human(ctx, repo, { executor: "codex" });
  expect(getWork(ctx, codex.id)).toBeNull();
  expect(codex.managedSkip).toMatchObject({ reason: "unsupported" });
  expect(codex.managedSkip!.detail).toContain("codex");
  expect(codex.origin).toBe("human");
});

test("with no strict-ready executor the user task starts unmanaged and records a plain reason", async () => {
  const { ctx, repo } = setup();
  await claude(ctx, repo, false);
  const unverified = human(ctx, repo);
  expect(getWork(ctx, unverified.id)).toBeNull();
  expect(unverified.managedSkip).toMatchObject({ reason: "unverified" });
  // Task detail carries only the reason code; the screens map it to copy.
  expect((await taskDetail(ctx, unverified.id)).managedSkip).toEqual({ reason: "unverified" });
  ctx.which = () => null;
  expect(human(ctx, repo).managedSkip).toMatchObject({ reason: "unavailable" });
});

test("an interactive runner is reported as such", async () => {
  const { ctx, repo } = setup("planner: codex\naccounts: {claude-code: {kind: claude}, codex: {kind: codex}}\nrunners: {claude-code: {session: interactive}}\n");
  await claude(ctx, repo, false);
  expect(human(ctx, repo, { executor: "claude-code" }).managedSkip).toMatchObject({ reason: "interactive" });
});

test("opting out, config off and planner delegates record no skip reason", async () => {
  const { ctx, repo } = setup();
  await claude(ctx, repo, false);
  const plain = human(ctx, repo, { grant: false });
  expect(getWork(ctx, plain.id)).toBeNull();
  expect(plain.managedSkip).toBeUndefined();
  expect(human(ctx, repo, { origin: "external:claude-code" }).managedSkip).toBeUndefined();
  const off = setup("planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nmessaging: {grants: {user_started_tasks: \"off\"}}\n");
  await claude(off.ctx, off.repo, false);
  const r = await callOp(off.ctx, "task.delegate", { goal: "a", repo: off.repo }, { appAuthenticated: true, spawnRunner: () => 1 }) as { task_id: string };
  expect(getWork(off.ctx, r.task_id)).toBeNull();
  expect(readTask(off.ctx, r.task_id)!.managedSkip).toBeUndefined();
});

const runnerStrategy = () => validateStrategy({ execution: { launch_mode: "headless" }, planner: "codex", accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex", usage: "unmetered" } }, runners: { "claude-code": { models: [{ id: "provider/deep", tier: "frontier" }] } }, dispatch: { timeoutMs: 5000 } }, "test");
async function run(ctx: Ctx, id: string, seen: Ctx[]) {
  const s = runnerStrategy();
  return runTask(ctx, id, {
    loadStrategy: () => s, hooks: defaultHooks, verifyRepo: async () => ({ files: "" }),
    computeStatus: async (c: Ctx) => ({ generatedAt: c.now, strategy: "test", planner: "codex", mode: "normal", disabled: false, calendarPace: false, providers: [{ id: "claude-code", usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false }], executors: { ranked: [], excluded: [] } }),
    runAttempt: async (runCtx: Ctx, cfg: { id: string; model?: string | null }, _task: TaskRecord) => {
      seen.push(runCtx);
      return { exec: { code: 0, stdout: "ok", stderr: "", timedOut: false }, report: "ok", attempt: { executor: cfg.id, model: cfg.model ?? null, startedAt: ctx.now, endedAt: ctx.now + 1, exitCode: 0, timedOut: false, limitHit: false, log: "" } };
    },
  } as never);
}
/** Registered as managed while certified; the certificate is gone by launch, so strict control is impossible. */
async function lostCertificate() {
  const { ctx, repo } = setup(undefined, true);
  await claude(ctx, repo, true);
  const t = human(ctx, repo);
  expect(getWork(ctx, t.id)).not.toBeNull();
  dispatchDatabase(ctx).query("DELETE FROM enforcement_certificates").run();
  return { ctx, t };
}

test("a managed user task whose strict launch became impossible runs unmanaged instead of queuing forever", async () => {
  const { ctx, t } = await lostCertificate();
  const seen: Ctx[] = [];
  const result = await run(ctx, t.id, seen);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.env.PACER_WORK_GRANT).toBeUndefined();
  expect(seen[0]!.env.PACER_ENFORCEMENT_MODE).toBeUndefined();
  expect(result.state).not.toBe("queued");
  expect(getWork(ctx, t.id)).toBeNull();
  const after = readTask(ctx, t.id)!;
  expect(after.managedSkip).toMatchObject({ reason: "refused" });
  expect(after.managedSkip!.detail).toContain("claude-code");
  const db = dispatchDatabase(ctx);
  for (const table of ["work_nodes", "work_waits", "work_reservations", "work_decisions"])
    expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE task_id=?`).get(t.id)).toEqual({ n: 0 });
});

test("a managed root with children, or one a planner started, keeps waiting for strict control", async () => {
  const withChild = await lostCertificate();
  dispatchDatabase(withChild.ctx).query("INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,?)")
    .run("child-1", withChild.t.id, withChild.t.id, 1, JSON.stringify({ delegationEnforcement: "strict" }), "[]");
  const seen: Ctx[] = [];
  expect((await run(withChild.ctx, withChild.t.id, seen)).queue?.reason).toBe("waiting_retry");
  expect(seen).toHaveLength(0);
  expect(getWork(withChild.ctx, withChild.t.id)).not.toBeNull();
  expect(readTask(withChild.ctx, withChild.t.id)!.managedSkip).toBeUndefined();

  const planner = await lostCertificate();
  updateTask(planner.ctx, planner.t.id, t => { t.origin = "external:claude-code"; });
  expect((await run(planner.ctx, planner.t.id, seen)).queue?.reason).toBe("waiting_retry");
  expect(seen).toHaveLength(0);
  expect(getWork(planner.ctx, planner.t.id)).not.toBeNull();
});
