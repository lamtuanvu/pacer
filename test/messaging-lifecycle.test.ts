// Turn lifecycle regressions: session capture, headless-only turns, work nodes, failed turns and run-end reports.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runAttempt } from "../src/exec/direct";
import { validateStrategy } from "../src/config/strategy";
import { registerWork } from "../src/dispatch/work";
import { sendMessage } from "../src/messaging/send";
import { claimTurnMessages, onRunEnded, startTurnIfIdle } from "../src/messaging/turns";
import * as store from "../src/messaging/store";
import type { TaskRecord } from "../src/tasks/types";

const PARENT = "external:claude-code";

function finished(executor = "codex", edit: (t: TaskRecord) => void = () => {}) {
  const ctx = fakeCtx({ env: { CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}, agy: {}}\n");
  const t = createTask(ctx, { brief: { goal: "the original brief", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
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
/** Simulate the runner finishing the turn's attempt. */
function endRun(ctx: ReturnType<typeof fakeCtx>, id: string, state: TaskRecord["state"], report = "turn report") {
  updateTask(ctx, id, t => {
    t.state = state;
    t.attempts.push({ ...t.attempts[0]!, startedAt: ctx.now + 5, endedAt: ctx.now + 6, exitCode: state === "failed" ? 1 : 0 });
    if (t.run) t.run = { ...t.run, attempt: t.attempts.length };
    t.result = { status: state as never, executor: t.pendingTurn?.executor ?? "codex", model: null, files: "", report, backend: "direct" };
  });
}
function fakeBin(name: string, script: string) {
  const bin = tmpDir();
  writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" > "${bin}/argv"\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  return bin;
}
const CODEX = (bin: string) => `cat > "${bin}/stdin"\nout=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done\necho "TURN REPORT" > "$out"`;
const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, agy: {} } }, "/x");

test("the turn captures the session at start, so a cleared run still resumes it", async () => {
  const bin = fakeBin("codex", "");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "$@" > "${bin}/argv"\n${CODEX(bin)}\n`);
  const { ctx: base, id } = finished();
  const ctx = { ...base, env: { ...base.env, PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } };
  const { spawn } = spawner();
  await sendMessage(ctx, { to: `task:${id}`, body: "also handle X" }, { spawnRunner: spawn });
  expect(readTask(ctx, id)!.pendingTurn?.session).toEqual({ id: "sid-1", source: "header" });
  // The runner deletes run when the attempt starts.
  updateTask(ctx, id, t => { delete t.run; t.state = "running"; });
  // A modern codex would launch interactive by default; a message turn runs headless regardless.
  ctx.run = async () => ({ code: 0, stdout: "codex-cli 0.164.0", stderr: "" });
  const out = await runAttempt(ctx, s.providers.codex!, readTask(ctx, id)!);
  const argv = readFileSync(join(bin, "argv"), "utf8");
  expect(argv).toContain("exec resume");
  expect(argv).toContain("sid-1");
  expect(readFileSync(join(bin, "stdin"), "utf8")).toContain("also handle X");
  expect(out.report).toContain("TURN REPORT");
  expect(readTask(ctx, id)!.run?.agentSession?.id).toBe("sid-1");
});

test("the turn is counted when it starts, not when it is claimed", async () => {
  const { ctx, id } = finished();
  await sendMessage(ctx, { to: `task:${id}`, body: "x" }, { spawnRunner: () => 1 });
  expect(store.turnsForRoot(ctx, `task:${id}`)).toBe(1);
});

for (const [name, executor, edit] of [
  ["remote runners", "codex@devbox", () => {}],
  ["other backends", "codex", (t: TaskRecord) => { t.result!.backend = "orca"; }],
  ["executors without a headless launcher", "gemini", () => {}],
] as const) {
  test(`no turn starts for ${name}; messages stay pending`, async () => {
    const { ctx, id } = finished(executor, edit);
    const { spawned, spawn } = spawner();
    const r = await sendMessage(ctx, { to: `task:${id}`, body: "x" }, { spawnRunner: spawn });
    expect(r.delivery).toBe("no_session");
    expect(spawned).toEqual([]);
    expect(readTask(ctx, id)!.state).toBe("done");
    expect(store.pendingFor(ctx, `task:${id}`).length).toBe(1);
    expect(store.turnsForRoot(ctx, `task:${id}`)).toBe(0);
  });
}

test("a run that never claimed its turn does not restart and reports the undelivered messages once", async () => {
  const { ctx, id } = finished("codex", t => { t.messaging = { max_turns: 50 }; });
  const { spawned, spawn } = spawner();
  await sendMessage(ctx, { to: `task:${id}`, body: "please do Y" }, { spawnRunner: spawn });
  expect(spawned.length).toBe(1);
  endRun(ctx, id, "failed", "duplicate brief");
  // The run end is processed after the attempt ended.
  const later = { ...ctx, now: ctx.now + 10 };
  await onRunEnded(later, id, spawn);
  await onRunEnded(later, id, spawn);
  expect(spawned.length).toBe(1);
  const t = readTask(ctx, id)!;
  expect(t.pendingTurn).toBeUndefined();
  expect(store.pendingFor(ctx, `task:${id}`).map(m => m.body)).toEqual(["please do Y"]);
  const reports = store.inbox(ctx, PARENT).filter(m => m.from === `task:${id}`);
  expect(reports.length).toBe(1);
  expect(reports[0]!.body).toMatch(/not delivered/);
  expect(reports[0]!.body).toContain("duplicate brief");
});

test("managed work nodes are never resumed by messages; they pull with their grant", async () => {
  const { ctx, id } = finished();
  registerWork(ctx, id);
  const { spawned, spawn } = spawner();
  const r = await sendMessage(ctx, { to: `task:${id}`, body: "x" }, { spawnRunner: spawn });
  expect(r.delivery).toBe("pull");
  expect(startTurnIfIdle(ctx, id, spawn)).toBe("pull");
  expect(spawned).toEqual([]);
  expect(readTask(ctx, id)!.result?.report).toBe("first report");
  expect(store.pendingFor(ctx, `task:${id}`).length).toBe(1);
});

test("a work child does not report to its work parent", async () => {
  const { ctx, id: parent } = finished("codex", t => { t.state = "running"; });
  registerWork(ctx, parent, { allowDelegation: true });
  const child = createTask(ctx, { brief: { goal: "c", repo: readTask(ctx, parent)!.brief.repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, child.id, {}, parent);
  updateTask(ctx, parent, t => { t.state = "done"; });
  updateTask(ctx, child.id, t => { t.state = "done"; t.result = { status: "done", executor: "codex", model: null, files: "", report: "child", backend: "direct" }; });
  const { spawned, spawn } = spawner();
  await onRunEnded(ctx, child.id, spawn);
  await onRunEnded(ctx, parent, spawn);
  expect(store.inbox(ctx, `task:${parent}`)).toEqual([]);
  expect(spawned).toEqual([]);
  expect(readTask(ctx, parent)!.state).toBe("done");
});

test("a failed resumed turn releases its messages and retries once with a replay", async () => {
  const { ctx, id } = finished();
  const { spawned, spawn } = spawner();
  await sendMessage(ctx, { to: `task:${id}`, body: "do Z" }, { spawnRunner: spawn });
  claimTurnMessages(ctx, readTask(ctx, id)!);
  endRun(ctx, id, "failed", "session not found");
  await onRunEnded(ctx, id, spawn);
  expect(spawned.length).toBe(2);
  const t = readTask(ctx, id)!;
  expect(t.pendingTurn?.replay).toBe(true);
  expect(t.state).toBe("queued");
  expect(store.pendingFor(ctx, `task:${id}`).map(m => m.body)).toEqual(["do Z"]);
  expect(store.inbox(ctx, PARENT).filter(m => m.from === `task:${id}`)).toEqual([]);
  // The replay fails too: no further retry, the failure is reported.
  claimTurnMessages(ctx, t);
  updateTask(ctx, id, x => { x.run = { ...x.run!, turnResume: "replayed" }; });
  endRun(ctx, id, "failed", "still broken");
  await onRunEnded(ctx, id, spawn);
  expect(spawned.length).toBe(2);
  expect(store.inbox(ctx, PARENT).filter(m => m.from === `task:${id}`).map(m => m.body)).toEqual(["[failed] still broken"]);
});

test("a replay turn launches fresh with the brief and the thread", async () => {
  const bin = fakeBin("codex", "");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "$@" > "${bin}/argv"\n${CODEX(bin)}\n`);
  const { ctx: base, id } = finished();
  const ctx = { ...base, env: { ...base.env, PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } };
  await sendMessage(ctx, { to: `task:${id}`, body: "earlier note" }, { spawnRunner: () => 1 });
  claimTurnMessages(ctx, readTask(ctx, id)!);
  endRun(ctx, id, "failed", "session not found");
  await onRunEnded(ctx, id, () => 1);
  updateTask(ctx, id, t => { delete t.run; t.state = "running"; });
  await runAttempt(ctx, s.providers.codex!, readTask(ctx, id)!);
  const argv = readFileSync(join(bin, "argv"), "utf8");
  expect(argv).not.toContain("resume");
  const stdin = readFileSync(join(bin, "stdin"), "utf8");
  expect(stdin).toContain("the original brief");
  expect(stdin).toContain("earlier note");
  expect(readTask(ctx, id)!.run?.turnResume).toBe("replayed");
});

test("a provider without headless resume replays instead of failing", async () => {
  const bin = fakeBin("agy", "echo AGY REPORT");
  const { ctx: base, id } = finished("agy");
  const ctx = { ...base, env: { ...base.env, PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } };
  const { spawned, spawn } = spawner();
  expect((await sendMessage(ctx, { to: `task:${id}`, body: "agy follow-up" }, { spawnRunner: spawn })).delivery).toBe("turn_started");
  updateTask(ctx, id, t => { delete t.run; t.state = "running"; });
  const out = await runAttempt(ctx, s.providers.agy!, readTask(ctx, id)!);
  expect(out.exec.code).toBe(0);
  const argv = readFileSync(join(bin, "argv"), "utf8");
  expect(argv).toContain("the original brief");
  expect(argv).toContain("agy follow-up");
  expect(readTask(ctx, id)!.run?.turnResume).toBe("replayed");
  expect(spawned.length).toBe(1);
});

test("starting a turn clears settled state and keeps the result's worktree", async () => {
  const wt = tmpDir();
  const { ctx, id } = finished("codex", t => {
    t.settledAt = 5; t.reviewRequest = { note: "n", at: 1 }; t.runnerPid = 999999;
    t.progress = { lastOutputAt: null, lastChangeAt: null, files: 0, commits: 0, logBytes: 0, host: "local", phase: "done", updatedAt: 1 } as never;
    t.queue = { reason: "no_slot", since: 1, position: 1 };
    t.result!.worktree = wt;
  });
  await sendMessage(ctx, { to: `task:${id}`, body: "x" }, { spawnRunner: () => 1 });
  const t = readTask(ctx, id)!;
  for (const k of ["settledAt", "reviewRequest", "runnerPid", "progress", "queue", "result"] as const) expect(t[k]).toBeUndefined();
  expect(t.worktree).toBe(wt);
});

test("legacy tasks without an origin do not report", async () => {
  const { ctx, id } = finished("codex", t => { delete t.origin; t.source = "planner"; });
  await onRunEnded(ctx, id);
  expect(store.inbox(ctx, "external:planner")).toEqual([]);
});

test("a question from an earlier attempt of the same run does not replace the run-end report", async () => {
  const { ctx, id } = finished("codex", t => {
    t.attempts = [
      { ...t.attempts[0]!, startedAt: t.createdAt + 1, limitHit: true },
      { ...t.attempts[0]!, startedAt: t.createdAt + 100 },
    ];
  });
  store.insertMessage({ ...ctx, now: ctx.now + 50 }, { taskId: id, rootId: `task:${id}`, from: `task:${id}`, to: PARENT, kind: "question", body: "which?", replyTo: null, requestId: null });
  await onRunEnded({ ...ctx, now: ctx.now + 200 }, id);
  expect(store.inbox(ctx, PARENT).map(m => m.kind)).toEqual(["question", "report"]);
});

test("a duplicate request id returns the stored message before any routing check", async () => {
  const { ctx, id } = finished();
  updateTask(ctx, id, t => { t.state = "running"; });
  const first = await sendMessage(ctx, { to: `task:${id}`, body: "hello", requestId: "r1" }, { spawnRunner: () => 1 });
  expect(first.delivery).toBe("queued");
  updateTask(ctx, id, t => { t.msgClosed = true; });
  const again = await sendMessage(ctx, { to: `task:${id}`, body: "hello", requestId: "r1" }, { spawnRunner: () => 1 });
  expect(again.duplicate).toBe(true);
  expect(again.message.id).toBe(first.message.id);
  await expect(sendMessage(ctx, { to: `task:${id}`, body: "other", requestId: "r1" })).rejects.toMatchObject({ code: "conflict", data: { reason: "msg_request_mismatch" } });
  await expect(sendMessage(ctx, { to: "human", body: "hello", requestId: "r1" })).rejects.toMatchObject({ code: "conflict", data: { reason: "msg_request_mismatch" } });
});

test("a duplicate whose first delivery never started delivers again", async () => {
  const { ctx, id } = finished();
  updateTask(ctx, id, t => { t.state = "running"; });
  const { spawned, spawn } = spawner();
  expect((await sendMessage(ctx, { to: `task:${id}`, body: "hello", requestId: "r2" }, { spawnRunner: spawn })).delivery).toBe("queued");
  updateTask(ctx, id, t => { t.state = "done"; });
  const again = await sendMessage(ctx, { to: `task:${id}`, body: "hello", requestId: "r2" }, { spawnRunner: spawn });
  expect(again.duplicate).toBe(true);
  expect(again.delivery).toBe("turn_started");
  expect(spawned).toEqual([id]);
});
