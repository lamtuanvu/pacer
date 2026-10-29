// Regressions from live round 2 and re-review 2: run-end reports, turn ids, rejected resumes, wait matching and answers.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { main } from "../src/cli";
import * as core from "../src/core";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runTask, type RunnerDeps } from "../src/tasks/runner";
import { runAttempt } from "../src/exec/direct";
import { validateStrategy } from "../src/config/strategy";
import { sendMessage } from "../src/messaging/send";
import { claimTurnMessages, onRunEnded, renderTurnPrompt } from "../src/messaging/turns";
import * as store from "../src/messaging/store";
import type { TaskRecord } from "../src/tasks/types";
import type { Ctx } from "../src/types";

const PARENT = "external:claude-code";

function finished(executor = "codex", edit: (t: TaskRecord) => void = () => {}) {
  const ctx = fakeCtx({ env: { CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const t = createTask(ctx, { brief: { goal: "the brief", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, t.id, x => {
    x.origin = PARENT; x.state = "done";
    x.run = { dir: tmpDir(), attempt: 1, executor, startedAt: 1, mode: "new", workdir: tmpDir(), logFile: "/dev/null", agentSession: { id: "sid-1", source: "header" } };
    x.attempts = [{ executor, model: null, startedAt: ctx.now, endedAt: ctx.now + 1, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
    x.result = { status: "done", executor, model: null, files: "", report: "first report", backend: "direct" };
    edit(x);
  });
  return { ctx, id: t.id };
}
const spawner = () => { const spawned: string[] = []; return { spawned, spawn: (_c: unknown, id: string) => { spawned.push(id); return 1; } }; };
/** The runner finishing the turn's attempt: a new attempt and the run that belongs to it. */
function endRun(ctx: Ctx, id: string, state: TaskRecord["state"], report: string, exitCode = state === "failed" ? 1 : 0) {
  updateTask(ctx, id, t => {
    t.state = state;
    t.attempts.push({ ...t.attempts[0]!, startedAt: ctx.now + 5, endedAt: ctx.now + 6, exitCode });
    t.run = { ...t.run!, attempt: t.attempts.length };
    t.result = { status: state as never, executor: t.pendingTurn?.executor ?? "codex", model: null, files: "", report, backend: "direct" };
  });
}
const reportsTo = (ctx: Ctx, to: string, id: string) => store.inbox(ctx, to).filter(m => m.from === `task:${id}`).map(m => m.body);

// R1
test("a mid-turn message or question to the parent does not swallow the turn's report", async () => {
  const { ctx, id } = finished();
  const { spawn } = spawner();
  await sendMessage(ctx, { to: `task:${id}`, body: "do X and tell me" }, { spawnRunner: spawn });
  claimTurnMessages(ctx, readTask(ctx, id)!);
  const exec = { ...ctx, now: ctx.now + 1, env: { PACER_ROLE: "executor", PACER_TASK_ID: id } };
  await sendMessage(exec, { to: PARENT, body: "progress: halfway" });
  await sendMessage(exec, { to: PARENT, body: "which flavor?", kind: "question" });
  endRun(ctx, id, "done", "X is done");
  onRunEnded({ ...ctx, now: ctx.now + 10 }, id, spawn);
  expect(reportsTo(ctx, PARENT, id).sort()).toEqual(["[done] X is done", "progress: halfway", "which flavor?"]);
});

test("a report the agent already sent to its parent during the turn suppresses the run-end report", async () => {
  const { ctx, id } = finished();
  const { spawn } = spawner();
  await sendMessage(ctx, { to: `task:${id}`, body: "do X" }, { spawnRunner: spawn });
  claimTurnMessages(ctx, readTask(ctx, id)!);
  await sendMessage({ ...ctx, now: ctx.now + 1, env: { PACER_ROLE: "executor", PACER_TASK_ID: id } }, { to: PARENT, body: "X done, details", kind: "report" });
  endRun(ctx, id, "done", "X is done");
  onRunEnded({ ...ctx, now: ctx.now + 10 }, id, spawn);
  expect(reportsTo(ctx, PARENT, id)).toEqual(["X done, details"]);
});

test("msg.wait accepts a later question from the original recipient", async () => {
  const { ctx, id } = finished();
  updateTask(ctx, id, t => { t.state = "running"; });
  const sent = await callOp(ctx, "msg.send", { to: `task:${id}`, body: "do X" }, { spawnRunner: () => 1 }) as any;
  await callOp({ ...ctx, now: ctx.now + 1, env: { PACER_ROLE: "executor", PACER_TASK_ID: id } }, "msg.send", { to: PARENT, body: "which X?", kind: "question" });
  const waited = await callOp(ctx, "msg.wait", { reply_to: sent.message.id, timeout_s: 1 }) as any;
  expect(waited.messages.map((m: any) => [m.kind, m.body])).toEqual([["question", "which X?"]]);
});

// n1
test("msg.wait stamps read_at with the current time", async () => {
  const { ctx, id } = finished();
  const past = { ...ctx, now: 1000 };
  await callOp({ ...past, env: { PACER_ROLE: "executor", PACER_TASK_ID: id } }, "msg.send", { to: PARENT, body: "hi" });
  const before = Date.now() / 1000;
  const waited = await callOp(past, "msg.wait", { timeout_s: 1 }) as any;
  expect(waited.messages[0].readAt).toBeGreaterThanOrEqual(before - 1);
});

// n3
test("a turn's report also reaches a sender that is not the parent", async () => {
  const { ctx, id } = finished();
  const { spawn } = spawner();
  const human = { appAuthenticated: true, spawnRunner: spawn };
  await sendMessage(ctx, { to: `task:${id}`, body: "from the human" }, human);
  claimTurnMessages(ctx, readTask(ctx, id)!);
  endRun(ctx, id, "done", "answered");
  onRunEnded({ ...ctx, now: ctx.now + 10 }, id, spawn);
  expect(reportsTo(ctx, PARENT, id)).toEqual(["[done] answered"]);
  expect(reportsTo(ctx, "human", id)).toEqual(["[done] answered"]);
});

// R2
test("turn ids are unique even when a run ends before any attempt", async () => {
  const { ctx, id } = finished("codex", t => { t.messaging = { max_turns: 50 }; });
  const { spawned, spawn } = spawner();
  await sendMessage(ctx, { to: `task:${id}`, body: "one" }, { spawnRunner: spawn });
  const first = readTask(ctx, id)!.pendingTurn!.id;
  // The runner fails before runAttempt: no attempt is appended and nothing is claimed.
  updateTask(ctx, id, t => { t.state = "failed"; t.result = { status: "failed", executor: "codex", model: null, files: "", report: "boom", backend: "direct" }; });
  onRunEnded(ctx, id, spawn);
  await sendMessage(ctx, { to: `task:${id}`, body: "two" }, { spawnRunner: spawn });
  const second = readTask(ctx, id)!.pendingTurn!.id;
  expect(second).not.toBe(first);
  expect(store.turnsForRoot(ctx, `task:${id}`)).toBe(2);
  // This run claims both; "three" arrives mid-run and must start the next turn.
  claimTurnMessages(ctx, readTask(ctx, id)!);
  await sendMessage(ctx, { to: `task:${id}`, body: "three" }, { spawnRunner: spawn });
  updateTask(ctx, id, t => { t.state = "running"; });
  endRun(ctx, id, "done", "did one and two");
  const before = spawned.length;
  onRunEnded({ ...ctx, now: ctx.now + 10 }, id, spawn);
  expect(spawned.length).toBe(before + 1);
  expect(readTask(ctx, id)!.pendingTurn?.id).not.toBe(second);
});

test("recording a turn id twice fails instead of being ignored", () => {
  const { ctx, id } = finished();
  store.recordTurn(ctx, { id: "dup", taskId: id, rootId: `task:${id}`, at: 1 });
  expect(() => store.recordTurn(ctx, { id: "dup", taskId: id, rootId: `task:${id}`, at: 2 })).toThrow();
});

// R7
test("a resumed turn rejected with a nonzero exit replays even when the task settled partial", async () => {
  const { ctx, id } = finished();
  const { spawned, spawn } = spawner();
  await sendMessage(ctx, { to: `task:${id}`, body: "do Z" }, { spawnRunner: spawn });
  claimTurnMessages(ctx, readTask(ctx, id)!);
  const raw = '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["No conversation found with session ID: sid-1"]}';
  endRun(ctx, id, "partial", raw, 1);
  onRunEnded(ctx, id, spawn);
  expect(spawned.length).toBe(2);
  expect(readTask(ctx, id)!.pendingTurn?.replay).toBe(true);
  expect(store.pendingFor(ctx, `task:${id}`).map(m => m.body)).toEqual(["do Z"]);
  expect(reportsTo(ctx, PARENT, id)).toEqual([]);
});

test("a rejected resume that cannot replay reports a readable error, not raw JSON", async () => {
  const { ctx, id } = finished("codex", t => { t.messaging = { max_turns: 1 }; });
  const { spawn } = spawner();
  await sendMessage(ctx, { to: `task:${id}`, body: "do Z" }, { spawnRunner: spawn });
  claimTurnMessages(ctx, readTask(ctx, id)!);
  endRun(ctx, id, "failed", '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: sid-1"]}', 1);
  onRunEnded(ctx, id, spawn);
  const [body] = reportsTo(ctx, PARENT, id);
  expect(body).toContain("No conversation found with session ID: sid-1");
  expect(body).not.toContain('"type":"result"');
});

const CLAUDE = `#!/bin/sh
n=$(ls "$FAKE_LOG" | grep -c '^claude-argv-')
echo "$@" > "$FAKE_LOG/claude-argv-$((n + 1))"
case "$*" in *--resume*)
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["No conversation found with session ID: x"]}'
  exit 1;;
esac
echo '{"type":"result","subtype":"success","result":"CLAUDE REPORT"}'
`;

test("through runTask: a claude resume rejected in a changed worktree replays the thread once", async () => {
  const bin = tmpDir(), log = tmpDir();
  writeFileSync(join(bin, "claude"), CLAUDE); chmodSync(join(bin, "claude"), 0o755);
  const ctx = fakeCtx({ now: Date.now() / 1000, run: realRun, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_LOG: log, CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders: {claude-code: {}, codex: {}}\nexecution: {launch_mode: headless}\n");
  const strategy = validateStrategy({ planner: "codex", providers: { "claude-code": {}, codex: {} }, execution: { launch_mode: "headless" } }, "/x");
  const spawned: Ctx[] = [];
  const deps: RunnerDeps = {
    loadStrategy: () => strategy,
    computeStatus: async c => ({ generatedAt: c.now, strategy: "default", planner: "codex", mode: "normal", disabled: false, calendarPace: true,
      providers: ["codex", "claude-code"].map(id => ({ id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false })),
      executors: { ranked: [], excluded: [] } }) as never,
    runAttempt,
    // Turn 1 left uncommitted edits, so a nonzero exit settles partial rather than failed.
    verifyRepo: async () => ({ files: "add.py | 2 +" }),
    spawnRunner: (c) => { spawned.push(c); return 1; },
  };
  const task = createTask(ctx, { brief: { goal: "write add", repo: gitRepo() }, kind: "feature", requestedExecutor: "claude-code", timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.origin = PARENT; });
  expect((await runTask(ctx, task.id, deps)).state).toBe("done");
  await sendMessage(ctx, { to: `task:${task.id}`, body: "now add a comment" }, { spawnRunner: deps.spawnRunner });
  const resumed = await runTask(spawned[0]!, task.id, deps);
  expect(resumed.attempts.at(-1)!.exitCode).not.toBe(0);
  expect(spawned.length).toBe(2);
  expect(readTask(ctx, task.id)!.pendingTurn?.replay).toBe(true);
  const replay = await runTask(spawned[1]!, task.id, deps);
  expect(replay.state).toBe("done");
  expect(replay.run?.turnResume).toBe("replayed");
  const bodies = reportsTo(ctx, PARENT, task.id);
  expect(bodies.some(b => b.includes("error_during_execution"))).toBe(false);
  expect(bodies.at(-1)).toContain("CLAUDE REPORT");
}, 30_000);

// 7b
test("the turn prompt tells a headless turn not to use pacer report", () => {
  const { ctx, id } = finished();
  const text = renderTurnPrompt(ctx, readTask(ctx, id)!, []);
  expect(text).toMatch(/do not run `?pacer report`?/i);
});

// 7a
test("msg send --answer marks the question read and records the task's answer", async () => {
  const { ctx, id } = finished();
  updateTask(ctx, id, t => { t.state = "running"; });
  await core.tasks.ask({ ...ctx, env: { PACER_ROLE: "executor", PACER_TASK_ID: id } }, id, "Which table?");
  updateTask(ctx, id, t => { t.state = "needs_input"; t.result = { status: "needs_input", executor: "codex", model: null, files: "", report: "", backend: "direct" }; });
  const q = store.inbox(ctx, PARENT).find(m => m.kind === "question")!;
  const { spawned, spawn } = spawner();
  const r = await sendMessage(ctx, { to: `task:${id}`, kind: "answer", replyTo: q.id, body: "users" }, { spawnRunner: spawn });
  expect(r.delivery).toBe("turn_started");
  expect(spawned).toEqual([id]);
  expect(store.getMessage(ctx, q.id)!.status).toBe("read");
  expect(readTask(ctx, id)!.question?.answer).toBe("users");
});

// n2
test("msg send --wait returns at once with the reason when no turn can start", async () => {
  const { ctx, id } = finished("codex", t => { delete t.run; delete t.result; t.attempts = []; });
  const started = Date.now();
  const out = await main(["msg", "send", id, "hello", "--wait", "--timeout", "30", "--json"], ctx);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(out.code).toBe(0);
  const j = JSON.parse(out.out);
  expect(j.sent.delivery).toBe("no_session");
  expect(j.reply).toBeNull();
  expect(j.reason).toBeTruthy();
});

test("a message turn's runner does not inherit the sender's planner session", async () => {
  const { ctx, id } = finished();
  const envs: Ctx["env"][] = [];
  const sender = { ...ctx, env: { ...ctx.env, CLAUDE_CODE_SESSION_ID: "planner-sid", CLAUDE_CODE_CHILD_SESSION: "1", CODEX_THREAD_ID: "t" } };
  await sendMessage(sender, { to: `task:${id}`, body: "go on" }, { spawnRunner: (c: Ctx) => { envs.push(c.env); return 1; } });
  expect(envs.length).toBe(1);
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CODEX_THREAD_ID", "PACER_PLANNER_SESSION", "PACER_ROLE"]) expect(envs[0]![k]).toBeUndefined();
});
