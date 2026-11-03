import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { superviseTask, taskStop, taskWait, summarizeTask } from "../src/tasks/api";
import { parseOutboxEvent } from "../src/link/envelope";
import { taskData } from "../src/link/pump";
import { callOp } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

test("provider-owned stop returns pending before a safe prelaunch settlement", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: tmpDir() }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.backend = "direct";
    current.executorProvider = "pacer-exec-direct";
  });
  const requested = taskStop(ctx, task.id)!;
  expect(requested.state).toBe("running");
  expect(requested.result).toBeUndefined();
  expect(requested.stopPending).toMatchObject({ attempt: 1, providerId: "pacer-exec-direct" });
  expect(summarizeTask(requested)).toHaveProperty("stop_pending");
  expect(taskData(requested)).toHaveProperty("stopPending");
  expect(parseOutboxEvent({ type: "task", data: taskData(requested) }))
    .toHaveProperty("data.stopPending");
  expect((await taskWait(ctx, task.id, 0.1, 20))?.state).toBe("stopped");
  const again = taskStop(ctx, task.id)!;
  expect(again.stopPending).toBeUndefined();
  expect(readTask(ctx, task.id)?.state).toBe("stopped");
});

test("session.end retains a provider-owned conversation until verified exit", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: tmpDir() }, kind: null,
    requestedExecutor: "codex", timeoutS: 60, interactionMode: "conversation",
    conversation: { activity: "working" } });
  const running = updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
  });
  await callOp(ctx, "session.end", { id: task.id, expect_rev: running.rev });
  const current = readTask(ctx, task.id)!;
  expect(current.state).toBe("running");
  expect(current.stopPending).toBeDefined();
  expect(current.conversation?.activity).toBe("working");
  expect(current.conversation?.endReason).toBeUndefined();
});

test("dead runner settles a persisted prelaunch stop without starting a process", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: tmpDir() }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
    current.runnerPid = 999_999;
    current.attemptStartedAt = ctx.now;
    current.runClaim = { attempt: 1, providerId: "pacer-exec-direct", executor: "codex",
      workdir: task.brief.repo, dir: join(ctx.pacerHome, "runs", task.id, "1") };
  });
  taskStop(ctx, task.id);
  const observed = await superviseTask(ctx, task.id, () => undefined);
  expect(observed?.state).toBe("stopped");
  expect(observed?.stopPending).toBeUndefined();
  expect(observed?.runClaim).toBeUndefined();
  expect(observed?.result?.status).toBe("stopped");
});

test("restart leaves an uncertain persisted wrapper pending", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: tmpDir() }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const dir = join(ctx.pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
    current.runnerPid = 999_999;
    current.attemptStartedAt = ctx.now;
    current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
      mode: "current", workdir: task.brief.repo, logFile: join(dir, "stdout") };
    current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
  });
  taskStop(ctx, task.id);
  const observed = await superviseTask(ctx, task.id, () => undefined);
  expect(observed?.state).toBe("running");
  expect(observed?.stopPending?.attempt).toBe(1);
  expect(observed?.result).toBeUndefined();
});

test("a claimed run with no durable start intent settles a prelaunch stop", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: tmpDir() }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const dir = join(ctx.pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
    current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
      mode: "current", workdir: task.brief.repo, logFile: join(dir, "stdout") };
  });
  taskStop(ctx, task.id);
  const observed = await superviseTask(ctx, task.id, () => undefined);
  expect(observed?.state).toBe("stopped");
  expect(observed?.stopPending).toBeUndefined();
  expect(observed?.executorExitReceipt).toBeUndefined();
});

test("supervisor restarts a provider-owned placement journal without a run", async () => {
  const ctx = fakeCtx();
  const repo = tmpDir();
  const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
    current.runnerPid = 999_999;
    current.attemptStartedAt = ctx.now;
    current.worktreeIntent = { attempt: 1, providerId: "pacer-exec-direct",
      repoTop: repo, repoMain: repo, path: join(ctx.pacerHome, "worktrees", task.id),
      workdir: join(ctx.pacerHome, "worktrees", task.id), branch: `pacer/${task.id}`,
      baseSha: "a".repeat(40) };
  });
  let launches = 0;
  const observed = await superviseTask(ctx, task.id, () => { launches++; return 1; });
  expect(launches).toBe(1);
  expect(observed?.state).toBe("running");
  expect(observed?.worktreeIntent?.attempt).toBe(1);
});
