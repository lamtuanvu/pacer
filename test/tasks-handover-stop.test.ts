import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { runDir } from "../src/exec/direct";
import { superviseTask, superviseTasks, taskStop } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readRun, startRun } from "../src/supervisor/run";
import { resetHandoverState } from "../src/tasks/handover";
import { registerWork, issueWorkGrant } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { fakeCtx, tmpDir } from "./helpers";

const DEAD = 2 ** 22 + 12345;
const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, cursor: {} } }, "/x");
const deps = { loadStrategy: () => strategy, computeStatus: async () => { throw new Error("no ranking"); }, verifyRepo: async () => ({ files: "(no changes)" }) };
afterEach(() => resetHandoverState());

async function gap(script: string) {
  const ctx = fakeCtx({ now: Date.now() / 1000 }), repo = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: "cursor", timeoutS: 600 });
  const dir = runDir(ctx, t.id, 1), startedAt = Date.now() / 1000;
  const started = startRun({ dir, argv: ["sh", "-c", script], cwd: repo, env: { PATH: process.env.PATH } });
  updateTask(ctx, t.id, x => {
    x.state = "running"; x.executor = "cursor"; x.backend = "direct"; x.attemptStartedAt = startedAt;
    if ("pid" in started) x.childPid = started.pid;
    x.run = { dir, attempt: 1, executor: "cursor", startedAt, mode: "current", workdir: repo, logFile: join(ctx.pacerHome, "tasks", `${t.id}.cursor.log`) };
    x.handover = { protocol: 1, pacer: "0.13.0", identity: { pid: DEAD, bootId: "old", birth: "1" }, state: "handed-over", committedAt: ctx.now };
  });
  return { ctx, id: t.id, dir };
}
async function exited(dir: string) { for (let i = 0; i < 100 && readRun(dir).exit === null; i++) await Bun.sleep(50); }

test("a stop during the gap leaves the outcome to the replacement, which records it from the run", async () => {
  const { ctx, id, dir } = await gap("trap 'exit 143' TERM; while :; do sleep 0.1; done");
  const stopped = taskStop(ctx, id)!;
  expect(stopped.state).toBe("stopped");
  expect(stopped.result).toBeUndefined();
  await exited(dir);
  const done = await runTask(ctx, id, deps);
  expect(done.state).toBe("stopped");
  expect(done.result?.report).not.toContain("stopped before an executor ran");
  expect(done.attempts).toHaveLength(1);
  expect(done.handover).toBeUndefined();
});

test("the sweep launches a replacement for a stopped handed-over task", async () => {
  const { ctx, id, dir } = await gap("sleep 5");
  taskStop(ctx, id, { signal: false });
  const spawned: string[] = [];
  await superviseTasks(ctx, (_c, task) => { spawned.push(task); return 1; });
  expect(spawned).toEqual([id]);
  expect(readTask(ctx, id)?.handover?.replacementAt).toBe(ctx.now);
  process.kill(-readRun(dir).pid!, "SIGKILL");
});

test("without a replacement in 60 seconds the sweep records the stop and does the skipped cleanup", async () => {
  const { ctx, id, dir } = await gap("exit 143");
  registerWork(ctx, id, { allowDelegation: true });
  issueWorkGrant(ctx, id, 1);
  await exited(dir);
  taskStop(ctx, id, { signal: false });
  updateTask(ctx, id, x => { x.handover!.replacementAt = ctx.now - 61; });
  const after = (await superviseTask(ctx, id, () => { throw new Error("no relaunch after the deadline"); }))!;
  expect(after.state).toBe("stopped");
  expect(after.attempts).toHaveLength(1);
  expect(after.attempts[0].exitCode).toBe(143);
  expect(after.result?.report).toBe("Stopped during a runner handover; the run exited with 143.");
  expect(after.handover).toBeUndefined();
  const grant = dispatchDatabase(ctx).query<{ revoked: number }, [string]>("SELECT revoked FROM work_grants WHERE task_id=?").get(id);
  expect(grant?.revoked).toBe(1);
});
