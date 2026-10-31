import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { authorizeWorkGrant, issueWorkGrant, registerWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { sendMessage } from "../src/messaging/send";
import { claimTurnMessages, onRunEnded } from "../src/messaging/turns";
import * as store from "../src/messaging/store";
import { answer } from "../src/core/tasks";
import { callOp } from "../src/api/ops";
import { validateStrategy } from "../src/config/strategy";
import { runTask } from "../src/tasks/runner";
import { defaultHooks } from "../src/classify/hooks";
import { certifyExecutor, resolveEnforcementTarget } from "../src/dispatch/enforcement";
import { resolvePolicyRepoInput } from "../src/core/project-policy";
import type { Ctx } from "../src/types";
import type { TaskRecord } from "../src/tasks/types";

const attempt = (endedAt: number) => ({ executor: "codex", model: null, startedAt: endedAt - 1, endedAt, exitCode: 0, timedOut: false, limitHit: false, log: "" });
function settle(ctx: Ctx, id: string, o: Partial<TaskRecord> = {}) {
  updateTask(ctx, id, x => {
    x.state = "done";
    x.run = { dir: tmpDir(), attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: tmpDir(), logFile: "/dev/null", agentSession: { id: "sid-1", source: "header" } };
    x.attempts = [attempt(2)];
    x.result = { status: "done", executor: "codex", model: null, files: "", report: "first report", backend: "direct" };
    Object.assign(x, o);
  });
}

function workRoot(options: Record<string, unknown> = { allowDelegation: true }) {
  const ctx = fakeCtx({ env: { CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, t.id, x => { x.origin = "external:claude-code"; });
  registerWork(ctx, t.id, options);
  return { ctx, id: t.id };
}

const events = (ctx: Ctx, id: string) => dispatchDatabase(ctx).query<{ kind: string }, [string]>("SELECT kind FROM work_events WHERE task_id=?").all(id).map(r => r.kind);

test("a message to a settled work root resumes its session through the managed restart", async () => {
  const { ctx, id } = workRoot();
  updateTask(ctx, id, x => { x.state = "running"; });
  const grant = issueWorkGrant(ctx, id, 1);
  settle(ctx, id);
  const spawned: string[] = [];
  const r = await sendMessage(ctx, { to: `task:${id}`, body: "also handle X", requestId: "w1" },
    { spawnRunner: (c, tid) => { spawned.push(`${tid}:${c.env.PACER_WORK_GRANT ?? "none"}`); return 1; } });
  expect(r.delivery).toBe("turn_started");
  expect(spawned).toEqual([`${id}:none`]);
  const t = readTask(ctx, id)!;
  expect(t.state).toBe("queued");
  expect(t.pendingTurn).toMatchObject({ executor: "codex", session: { id: "sid-1" } });
  expect(t.run).toBeUndefined();
  expect(events(ctx, id)).toContain("work.turn_requested");
  // The old attempt's grant is revoked; the next attempt gets its own.
  updateTask(ctx, id, x => { x.state = "running"; });
  expect(() => authorizeWorkGrant(ctx, grant)).toThrow(/revoked/);
  expect(authorizeWorkGrant(ctx, issueWorkGrant(ctx, id, 2)).taskId).toBe(id);
  // The turn is recorded and its messages are claimed at launch, as for any task.
  expect(store.turnsForTask(ctx, id)).toBe(1);
  expect(claimTurnMessages(ctx, readTask(ctx, id)!)!.messages.map(m => m.body)).toEqual(["also handle X"]);
});

test("the attempt budget is honoured: messages stay pending and no runner starts", async () => {
  const { ctx, id } = workRoot({ allowDelegation: true, maxAttempts: 1 });
  settle(ctx, id);
  const spawned: string[] = [];
  const r = await sendMessage(ctx, { to: `task:${id}`, body: "x" }, { spawnRunner: (_c, tid) => { spawned.push(tid); return 1; } });
  expect(r.delivery).toBe("cap");
  expect(spawned).toEqual([]);
  expect(readTask(ctx, id)!.state).toBe("done");
  expect(readTask(ctx, id)!.pendingTurn).toBeUndefined();
  expect(store.pendingFor(ctx, `task:${id}`).length).toBe(1);
  expect(store.turnsForTask(ctx, id)).toBe(0);
});

test("pacer answer on a managed root with a session continues it", async () => {
  const { ctx, id } = workRoot();
  settle(ctx, id, { state: "needs_input", question: { text: "Which colour?", at: 2 } } as Partial<TaskRecord>);
  const spawned: string[] = [];
  const r = await answer(ctx, id, "Blue", {}, { spawnRunner: (_c, tid) => { spawned.push(tid); return 1; } });
  expect(r.task.id).toBe(id);
  expect(r.retry.id).toBe(id);
  expect(spawned).toEqual([id]);
  const t = readTask(ctx, id)!;
  expect(t.state).toBe("queued");
  expect(t.pendingTurn?.session?.id).toBe("sid-1");
  expect(t.question?.answer).toBe("Blue");
  expect(store.pendingFor(ctx, `task:${id}`).map(m => [m.kind, m.body])).toEqual([["answer", "Blue"]]);
});

test("task.answer and task.review send_back take the message path on managed work with a session", async () => {
  const { ctx, id } = workRoot();
  settle(ctx, id, { state: "needs_input", question: { text: "Which colour?", at: 2 } } as Partial<TaskRecord>);
  const spawned: string[] = [];
  const deps = { spawnRunner: (_c: Ctx, tid: string) => { spawned.push(tid); return 1; } };
  const ops = { call: (c: Ctx, name: string, params: unknown) => callOp(c, name, params, deps) };
  await ops.call(ctx, "task.answer", { id, text: "Blue" });
  expect(spawned).toEqual([id]);
  // Without a session the managed refusal stays.
  const other = workRoot();
  settle(other.ctx, other.id, { state: "needs_input", question: { text: "q", at: 2 } } as Partial<TaskRecord>);
  updateTask(other.ctx, other.id, x => { delete x.run!.agentSession; });
  await expect(ops.call(other.ctx, "task.answer", { id: other.id, text: "Blue" })).rejects.toThrow(/dispatch.answer/);
  const sent = workRoot();
  settle(sent.ctx, sent.id);
  await ops.call(sent.ctx, "task.review", { id: sent.id, verdict: "send_back", note: "tighten the tests" });
  expect(spawned).toEqual([id, sent.id]);
  expect(readTask(sent.ctx, sent.id)!.review).toBeUndefined();
  expect(store.pendingFor(sent.ctx, `task:${sent.id}`).map(m => m.body)).toEqual(["Review feedback: tighten the tests"]);
  updateTask(sent.ctx, sent.id, x => { x.state = "done"; delete x.pendingTurn; x.run = { ...readTask(other.ctx, other.id)!.run! }; });
  await expect(ops.call(sent.ctx, "task.review", { id: sent.id, verdict: "send_back", note: "again" })).rejects.toThrow(/dispatch.review/);
});

test("a work child's turn report goes to the sender, not through dispatch", async () => {
  const { ctx, id: root } = workRoot();
  updateTask(ctx, root, x => { x.state = "running"; });
  const child = createTask(ctx, { brief: { goal: "child", repo: readTask(ctx, root)!.brief.repo }, kind: "debug", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, child.id, {}, root);
  settle(ctx, child.id);
  const scoped = { ...ctx, env: { PACER_WORK_GRANT: issueWorkGrant(ctx, root, 1), PACER_ROLE: "executor" } };
  const r = await sendMessage(scoped, { to: `task:${child.id}`, body: "why did X fail?", requestId: "c1" }, { spawnRunner: () => 1 });
  expect(r.delivery).toBe("turn_started");
  claimTurnMessages(ctx, readTask(ctx, child.id)!);
  updateTask(ctx, child.id, x => { x.state = "done"; x.attempts.push(attempt(5)); x.result = { status: "done", executor: "codex", model: null, files: "", report: "because Y", backend: "direct" }; });
  onRunEnded(ctx, child.id, () => 1);
  expect(store.inbox(ctx, `task:${root}`).filter(m => m.kind === "report").map(m => m.body)).toEqual(["[done] because Y"]);
  expect(store.inbox(ctx, "external:claude-code").length).toBe(0);
});

test("dispatch flows are unchanged without messages: a settled work node does not restart", () => {
  const { ctx, id } = workRoot();
  settle(ctx, id);
  const spawned: string[] = [];
  onRunEnded(ctx, id, (_c, tid) => { spawned.push(tid); return 1; });
  expect(spawned).toEqual([]);
  expect(readTask(ctx, id)!.state).toBe("done");
  expect(events(ctx, id)).not.toContain("work.turn_requested");
});

test("the runner issues a fresh work grant for the turn's attempt and keeps the captured session", async () => {
  const { ctx: base, id } = workRoot();
  const ctx = { ...base, now: Date.now() / 1000 };
  const repo = readTask(ctx, id)!.brief.repo;
  const s = validateStrategy({ execution: { launch_mode: "headless" }, planner: "codex", accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex", usage: "unmetered" } }, runners: { "claude-code": { models: [{ id: "provider/deep", tier: "frontier" }] } }, dispatch: { timeoutMs: 5000 } }, "test");
  const binary = join(ctx.home, "claude-bin"); writeFileSync(binary, "claude");
  ctx.which = name => name === "claude" ? binary : null;
  const previousRun = ctx.run;
  ctx.run = (argv, timeout, options) => argv[0] === binary ? Promise.resolve({ code: 0, stdout: "2.1.281 (Claude Code)", stderr: "" }) : previousRun(argv, timeout, options);
  const target = await resolveEnforcementTarget(ctx, s, "claude-code", (await resolvePolicyRepoInput(ctx, repo)).path);
  await certifyExecutor(ctx, target, async () => ({ attempted: true, blocked: true, childStarted: false, entries: ["Agent", "Task"] }));
  settle(ctx, id, { attempts: [{ ...attempt(ctx.now - 1), executor: "claude-code" }] } as Partial<TaskRecord>);
  updateTask(ctx, id, x => { x.run!.executor = "claude-code"; x.result!.executor = "claude-code"; });
  expect((await sendMessage(ctx, { to: `task:${id}`, body: "more" }, { spawnRunner: () => 1 })).delivery).toBe("turn_started");
  const seen: { grant: number; session?: string }[] = [];
  const result = await runTask(ctx, id, {
    loadStrategy: () => s, hooks: defaultHooks, verifyRepo: async () => ({ files: "" }),
    computeStatus: async (c: Ctx) => ({ generatedAt: c.now, strategy: "test", planner: "codex", mode: "normal", disabled: false, calendarPace: false, providers: [{ id: "claude-code", usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false }], executors: { ranked: [], excluded: [] } }),
    runAttempt: async (runCtx: Ctx, cfg: { id: string; model?: string | null }, task: TaskRecord) => {
      const node = authorizeWorkGrant({ ...runCtx, now: Date.now() / 1000 }, runCtx.env.PACER_WORK_GRANT!);
      seen.push({ grant: node.taskId === id ? task.attempts.length + 1 : -1, session: task.pendingTurn?.session?.id });
      return { exec: { code: 0, stdout: "ok", stderr: "", timedOut: false }, report: "ok", attempt: { executor: cfg.id, model: cfg.model ?? null, startedAt: ctx.now, endedAt: ctx.now + 1, exitCode: 0, timedOut: false, limitHit: false, log: "" } };
    },
  } as never);
  expect(seen).toEqual([{ grant: 2, session: "sid-1" }]);
  expect(result.attempts.length).toBe(2);
});
