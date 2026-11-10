import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { superviseTask, taskStop, taskWait, summarizeTask } from "../src/tasks/api";
import { parseOutboxEvent } from "../src/link/envelope";
import { taskData } from "../src/link/pump";
import { callOp } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
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

for (const reason of ["user", "deadline"] as const) {
  test(`stop recovery without start intent consumes an existing exit (${reason})`, async () => {
    const ctx = fakeCtx();
    const task = createTask(ctx, { brief: { goal: "fixture", repo: tmpDir() }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    registerWork(ctx, task.id);
    const dir = join(ctx.pacerHome, "runs", task.id, "2");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "pid"), "999999");
    writeFileSync(join(dir, "exit"), "143");
    const running = updateTask(ctx, task.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      current.runnerPid = 999_999;
      current.childPid = 999_999;
      current.attempts.push({ executor: "codex", model: null, startedAt: ctx.now - 100,
        endedAt: ctx.now - 50, exitCode: 0, timedOut: false, limitHit: false, log: "prior-output" });
      current.run = { dir, attempt: 2, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: task.brief.repo, logFile: join(dir, "stdout") };
      current.stopPending = { attempt: 2, requestedAt: ctx.now, providerId: "pacer-exec-direct",
        graceMs: 5000, reason };
      current.progress = { phase: "lost-contact", updatedAt: ctx.now, lastOutputAt: ctx.now,
        lastChangeAt: ctx.now, files: 2, commits: 1, logBytes: 123, host: "local" };
    });
    const db = dispatchDatabase(ctx);
    db.query("INSERT INTO work_reservations VALUES(?,?,?,?,?,?)")
      .run(task.id, task.id, "codex", "[]", 5, ctx.now);
    let launches = 0;
    const settled = await superviseTask(ctx, task.id, () => { launches++; });
    expect(settled?.state).toBe(reason === "deadline" ? "failed" : "stopped");
    expect(settled?.stopPending).toBeUndefined();
    expect(settled?.attempts).toHaveLength(2);
    expect(settled?.attempts[0]).toEqual(running.attempts[0]);
    expect(settled?.attempts[1]).toMatchObject({ exitCode: 143, timedOut: reason === "deadline" });
    expect(settled?.progress).toEqual(running.progress);
    expect(db.query("SELECT * FROM work_reservations WHERE task_id=?").get(task.id)).toBeNull();
    expect(launches).toBe(0);
    await superviseTask(ctx, task.id, () => { launches++; });
    expect(readTask(ctx, task.id)?.attempts).toHaveLength(2);
  });
}

for (const pid of [process.pid, 999_999]) {
  test(`missing start intent does not settle an ambiguous PID without an exit (${pid === process.pid ? "live" : "absent"})`, async () => {
    const ctx = fakeCtx();
    const task = createTask(ctx, { brief: { goal: "fixture", repo: tmpDir() }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    const dir = join(ctx.pacerHome, "runs", task.id, "1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "pid"), String(pid));
    updateTask(ctx, task.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: task.brief.repo, logFile: join(dir, "stdout") };
    });
    taskStop(ctx, task.id);
    let launches = 0;
    const observed = await superviseTask(ctx, task.id, () => { launches++; });
    expect(observed?.state).toBe("running");
    expect(observed?.stopPending).toBeDefined();
    expect(observed?.attempts).toHaveLength(0);
    expect(observed?.executorExitReceipt).toBeUndefined();
    expect(launches).toBe(0);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    // Elapsed cleanup time cannot turn ambiguous evidence into launch ownership.
    const expired = await superviseTask({ ...ctx, now: ctx.now + 601 }, task.id, () => { launches++; });
    expect(expired?.state).toBe("running");
    expect(expired?.stopPending).toBeDefined();
    expect(expired?.attempts).toHaveLength(0);
    expect(expired?.executorExitReceipt).toBeUndefined();
    expect(launches).toBe(0);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
}

for (const mismatch of ["attempt", "provider", "directory"] as const) {
  test(`uncertain stop rejects a mismatched start intent (${mismatch}) after its deadline`, async () => {
    const ctx = fakeCtx();
    const task = createTask(ctx, { brief: { goal: "fixture", repo: tmpDir() }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    const dir = join(ctx.pacerHome, "runs", task.id, "1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "pid"), "999999");
    updateTask(ctx, task.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: task.brief.repo, logFile: join(dir, "stdout") };
      current.startIntent = { attempt: mismatch === "attempt" ? 2 : 1,
        providerId: mismatch === "provider" ? "other-provider" : "pacer-exec-direct",
        dir: mismatch === "directory" ? join(dir, "other") : dir };
      current.stopPending = { attempt: 1, requestedAt: ctx.now - 601,
        cleanupStartedAt: ctx.now - 601, providerId: "pacer-exec-direct", graceMs: 0, reason: "user" };
    });
    let launches = 0;
    const observed = await superviseTask(ctx, task.id, () => { launches++; });
    expect(observed?.state).toBe("running");
    expect(observed?.stopPending).toBeDefined();
    expect(observed?.attempts).toHaveLength(0);
    expect(observed?.executorExitReceipt).toBeUndefined();
    expect(launches).toBe(0);
  });
}
