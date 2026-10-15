import { expect, test } from "bun:test";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { runDir } from "../src/exec/direct";
import { taskStatus } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readRun, startRun } from "../src/supervisor/run";
import { fakeCtx, tmpDir } from "./helpers";

const DEAD = 2 ** 22 + 12345; // well above typical pid_max; never alive
const env = { PATH: process.env.PATH };

function orphan(script: string) {
  const ctx = fakeCtx(), repo = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: "cursor", timeoutS: 60 });
  const dir = runDir(ctx, t.id, 1), startedAt = Date.now() / 1000;
  startRun({ dir, argv: ["sh", "-c", script], cwd: repo, env });
  updateTask(ctx, t.id, (x) => {
    x.state = "running"; x.runnerPid = DEAD; x.executor = "cursor"; x.backend = "direct"; x.attemptStartedAt = startedAt;
    x.run = { dir, attempt: 1, executor: "cursor", startedAt, mode: "current", workdir: repo, logFile: join(ctx.pacerHome, "tasks", `${t.id}.cursor.log`) };
  });
  return { ctx, t, dir };
}

test("dead runner with a live run is resumed, not failed", () => {
  const { ctx, t } = orphan("sleep 3");
  const spawned: string[] = [];
  const st = taskStatus(ctx, t.id, (_c, id) => { spawned.push(id); return 1; });
  expect(st?.state).toBe("running");
  expect(spawned).toEqual([t.id]);
  taskStatus(ctx, t.id, (_c, id) => { spawned.push(id); return 1; });
  expect(spawned).toEqual([t.id]); // at most once per 60 s
});

test("dead runner whose run vanished without an exit record still fails as before", () => {
  const { ctx, t, dir } = orphan("sleep 30");
  process.kill(-readRun(dir).pid!, "SIGKILL");
  Bun.sleepSync(200);
  expect(taskStatus(ctx, t.id, () => 1)?.state).toBe("failed");
});

test("resumed runner records the attempt's real exit", async () => {
  const { ctx, t } = orphan("echo resumed-output; exit 0");
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, cursor: {} } }, "/x");
  const done = await runTask(ctx, t.id, { loadStrategy: () => s, computeStatus: async () => { throw new Error("resume must not rank executors"); }, verifyRepo: async () => ({ files: "(no changes)" }) });
  expect(done.attempts).toHaveLength(1);
  expect(done.attempts[0]).toMatchObject({ executor: "cursor", exitCode: 0 });
  expect(done.result?.report).toContain("resumed-output");
  expect(readTask(ctx, t.id)?.runnerPid).toBe(process.pid);
});

test("dead runner with an exit record stays running and retries resume after 60 seconds", async () => {
  const { ctx, t, dir } = orphan("exit 7");
  const deadline = Date.now() + 5000;
  while (readRun(dir).exit === null) {
    if (Date.now() > deadline) throw new Error("timeout waiting for exit");
    await Bun.sleep(25);
  }
  let spawned = 0;
  const spawn = () => { spawned++; return 1; };
  expect(taskStatus(ctx, t.id, spawn)?.state).toBe("running");
  taskStatus({ ...ctx, now: ctx.now + 59 }, t.id, spawn);
  expect(spawned).toBe(1);
  taskStatus({ ...ctx, now: ctx.now + 60 }, t.id, spawn);
  expect(spawned).toBe(2);
});

test("resume fails clearly when its executor is no longer configured", async () => {
  const { ctx, t } = orphan("exit 0");
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");
  const done = await runTask(ctx, t.id, {
    loadStrategy: () => s,
    computeStatus: async () => { throw new Error("resume must not rank executors"); },
    verifyRepo: async () => ({ files: "(no changes)" }),
  });
  expect(done.state).toBe("failed");
  expect(done.result?.report).toBe("cannot resume: executor cursor is no longer configured");
  expect(done.attempts).toHaveLength(0);
});
