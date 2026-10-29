import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { finishRun, runDir } from "../src/exec/direct";
import { startRun } from "../src/supervisor/run";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { advertiseHandover, handoverRequested, HANDOVER_PROTOCOL, installHandoverHandler, resetHandoverState, withdrawHandover } from "../src/tasks/handover";
import type { RunRef, RunnerHandover } from "../src/tasks/types";
import { currentVersion } from "../src/update/version";
import { fakeCtx, tmpDir } from "./helpers";

const env = { PATH: process.env.PATH };
const cursor = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, cursor: {} } }, "/x").providers.cursor;
afterEach(() => resetHandoverState());

function supervised(script: string, extra: Partial<RunRef> = {}) {
  const ctx = fakeCtx({ now: Date.now() / 1000 }), repo = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: "cursor", timeoutS: 60 });
  const dir = runDir(ctx, t.id, 1), startedAt = Date.now() / 1000;
  startRun({ dir, argv: ["sh", "-c", script], cwd: repo, env });
  const run: RunRef = { dir, attempt: 1, executor: "cursor", startedAt, mode: "current", workdir: repo, logFile: join(ctx.pacerHome, "tasks", `${t.id}.cursor.log`), ...extra };
  const task = updateTask(ctx, t.id, x => { x.state = "running"; x.runnerPid = process.pid; x.executor = "cursor"; x.attemptStartedAt = startedAt; x.run = run; });
  return { ctx, task, run };
}

test("a direct attempt advertises while it supervises its recorded run and withdraws after", async () => {
  const { ctx, task, run } = supervised("sleep 1");
  let seen: RunnerHandover | undefined;
  await finishRun(ctx, cursor, task, run, "", async () => { seen ??= readTask(ctx, task.id)?.handover; return "continue"; });
  expect(seen).toMatchObject({ protocol: HANDOVER_PROTOCOL, pacer: currentVersion(), identity: { pid: process.pid } });
  expect(seen?.state).toBeUndefined();
  expect(readTask(ctx, task.id)?.handover).toBeUndefined();
});

test("a run driving a takeover never advertises", async () => {
  const { ctx, task, run } = supervised("sleep 1", { takeover: true });
  let seen: RunnerHandover | undefined;
  await finishRun(ctx, cursor, task, run, "", async () => { seen ??= readTask(ctx, task.id)?.handover; return "continue"; });
  expect(seen).toBeUndefined();
});

test("a runner that does not own the task never advertises", () => {
  const { ctx, task, run } = supervised("sleep 1");
  updateTask(ctx, task.id, x => { x.runnerPid = 4194302; });
  expect(advertiseHandover(ctx, task.id, run)).toBe(false);
  expect(readTask(ctx, task.id)?.handover).toBeUndefined();
});

test("a conversation run advertises like a delegated one; the pre-run phase (no recorded run) never does", () => {
  const { ctx, task, run } = supervised("sleep 1", { interactionMode: "conversation" });
  expect(advertiseHandover(ctx, task.id, run)).toBe(true);
  withdrawHandover(ctx, task.id);
  updateTask(ctx, task.id, x => { delete x.run; });
  expect(advertiseHandover(ctx, task.id, run)).toBe(false);
  expect(readTask(ctx, task.id)?.handover).toBeUndefined();
});

test("an ineligible runner ignores SIGUSR2 and an eligible one records the request until it withdraws", async () => {
  installHandoverHandler();
  process.kill(process.pid, "SIGUSR2");
  await Bun.sleep(50);
  expect(handoverRequested()).toBe(false);
  const { ctx, task, run } = supervised("sleep 1");
  expect(advertiseHandover(ctx, task.id, run)).toBe(true);
  process.kill(process.pid, "SIGUSR2");
  await Bun.sleep(50);
  expect(handoverRequested()).toBe(true);
  withdrawHandover(ctx, task.id);
  expect(handoverRequested()).toBe(false);
  expect(readTask(ctx, task.id)?.handover).toBeUndefined();
});
