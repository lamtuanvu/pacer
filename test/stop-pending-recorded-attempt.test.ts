import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { superviseTask } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runningWork, workCounts } from "../src/service/running-work";
import { readRun } from "../src/supervisor/run";
import { writeReport, writeHeldReport } from "../src/session/reports";
import { storedBlockers } from "../src/update/desktop/blockers";
import { fakeCtx, tmpDir } from "./helpers";

/** Exact stuck shape seen after UI stop: attempt already recorded, run cleared, stopPending left. */
function seedRecordedStopPending(opts: {
  reason?: "user" | "deadline";
  exitCode?: number;
  keepRun?: boolean;
  runnerPacer?: string;
  runnerPid?: number;
  childPid?: number;
  /** Omit the exit receipt so a live wrapper can make readRun(dir).alive. */
  liveHost?: boolean;
}) {
  const ctx = fakeCtx();
  const repo = tmpDir();
  const task = createTask(ctx, {
    brief: { goal: "stuck after stop", repo },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  const attempt = 1;
  const dir = join(ctx.pacerHome, "runs", task.id, String(attempt));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "pid"), "999999999\n", { mode: 0o600 });
  if (!opts.liveHost) {
    writeFileSync(join(dir, "exit"), `${opts.exitCode ?? 143}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "session.ended"), `${ctx.now}\n`, { mode: 0o600 });
  }
  writeFileSync(join(dir, "session.host"), "builtin\n", { mode: 0o600 });
  const startedAt = ctx.now - 30;
  const endedAt = ctx.now - 5;
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = null as unknown as string;
    current.executorProvider = "pacer-exec-direct";
    current.runnerPacer = opts.runnerPacer ?? "0.17.5";
    current.attemptStartedAt = startedAt;
    current.attempts = [{
      executor: "codex",
      model: null,
      startedAt,
      endedAt,
      exitCode: opts.exitCode ?? 143,
      timedOut: opts.reason === "deadline",
      limitHit: false,
      log: join(dir, "log"),
    }];
    current.stopPending = {
      attempt,
      requestedAt: endedAt,
      cleanupStartedAt: endedAt,
      providerId: "pacer-exec-direct",
      graceMs: 5000,
      reason: opts.reason ?? "user",
    };
    if (opts.keepRun || opts.liveHost) {
      current.run = {
        dir,
        attempt,
        executor: "codex",
        startedAt,
        mode: "current",
        workdir: repo,
        logFile: join(dir, "log"),
      };
    } else {
      delete current.run;
    }
    if (opts.runnerPid !== undefined) current.runnerPid = opts.runnerPid;
    else delete current.runnerPid;
    if (opts.childPid !== undefined) current.childPid = opts.childPid;
    else delete current.childPid;
    delete current.pendingAttempt;
  });
  return { ctx, task, dir, attempt };
}

test("reconcile settles stopPending when the attempt is already recorded and run is null", async () => {
  const { ctx, task } = seedRecordedStopPending({});
  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    const settled = await superviseTask(ctx, task.id, () => {
      throw new Error("must not relaunch");
    });
    expect(settled?.state).toBe("stopped");
    expect(settled?.stopPending).toBeUndefined();
    expect(settled?.pendingAttempt).toBeUndefined();
    expect(settled?.childPid).toBeUndefined();
    expect(settled?.runnerPid).toBeUndefined();
    expect(settled?.attempts).toHaveLength(1);
    expect(settled?.result?.status).toBe("stopped");
    expect(settled?.result?.executor).toBe("codex");
    expect(errors.some(line => line.includes("stop reconcile failed"))).toBe(false);
    expect(readTask(ctx, task.id)?.state).toBe("stopped");
  } finally {
    errSpy.mockRestore();
  }
});

test("reconcile keeps the report when a user stops a held interactive root", async () => {
  const { ctx, task, dir, attempt } = seedRecordedStopPending({ keepRun: true });
  writeFileSync(join(dir, "interactive.json"), JSON.stringify({ interactionMode: "conversation" }), { mode: 0o600 });
  writeHeldReport(dir, "done", "agent finished the request", attempt);
  updateTask(ctx, task.id, current => {
    current.origin = "human"; current.source = "ui";
    current.interactionMode = "conversation"; current.interactive = true;
  });
  const settled = await superviseTask(ctx, task.id, () => {
    throw new Error("must not relaunch");
  });
  expect(settled?.state).toBe("done");
  expect(settled?.result).toMatchObject({ status: "done", report: "agent finished the request" });
  expect(settled?.conversation).toMatchObject({ activity: "ended", endReason: "user" });
});

test("reconcile settles deadline stopPending as failed without pushing another attempt", async () => {
  const { ctx, task } = seedRecordedStopPending({ reason: "deadline", exitCode: 0 });
  const settled = await superviseTask(ctx, task.id, () => {
    throw new Error("must not relaunch");
  });
  expect(settled?.state).toBe("failed");
  expect(settled?.stopPending).toBeUndefined();
  expect(settled?.attempts).toHaveLength(1);
  expect(settled?.result?.status).toBe("failed");
});

test("reconcile settles when run still points at an already-recorded attempt", async () => {
  const { ctx, task } = seedRecordedStopPending({ keepRun: true });
  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    const settled = await superviseTask(ctx, task.id, () => {
      throw new Error("must not relaunch");
    });
    expect(settled?.state).toBe("stopped");
    expect(settled?.stopPending).toBeUndefined();
    expect(settled?.attempts).toHaveLength(1);
    expect(errors.some(line => line.includes("stop reconcile failed"))).toBe(false);
  } finally {
    errSpy.mockRestore();
  }
});

test("running-work and idle blockers exclude a stuck stopPending record without a live run", async () => {
  const { ctx, task } = seedRecordedStopPending({ runnerPacer: "0.1.0" });
  const work = await runningWork(ctx, "0.17.5");
  expect(work.tasks.some(t => t.taskId === task.id)).toBe(false);
  expect(workCounts(work).olderRunners).toBe(0);
  expect(storedBlockers(ctx).some(b => b.kind === "task" && b.id === task.id)).toBe(false);
});

test("alive runnerPid keeps recorded stopPending running and visible to work/blockers", async () => {
  const { ctx, task } = seedRecordedStopPending({ runnerPid: process.pid, runnerPacer: "0.1.0" });
  const settled = await superviseTask(ctx, task.id, () => {
    throw new Error("must not relaunch");
  });
  expect(settled?.state).toBe("running");
  expect(settled?.stopPending).toBeDefined();
  expect(settled?.runnerPid).toBe(process.pid);
  const work = await runningWork(ctx, "0.17.5");
  expect(work.tasks.some(t => t.taskId === task.id)).toBe(true);
  expect(storedBlockers(ctx).some(b => b.kind === "task" && b.id === task.id)).toBe(true);
});

test("alive childPid keeps recorded stopPending running and visible to work/blockers", async () => {
  // keepRun so supervise takes the owned-run reconcile path (and returns) instead of
  // the dead-runner failure arm; liveness alone must block the recorded-stop settle.
  const { ctx, task } = seedRecordedStopPending({
    childPid: process.pid, keepRun: true, runnerPacer: "0.1.0",
  });
  const settled = await superviseTask(ctx, task.id, () => {
    throw new Error("must not relaunch");
  });
  expect(settled?.state).toBe("running");
  expect(settled?.stopPending).toBeDefined();
  expect(settled?.childPid).toBe(process.pid);
  const work = await runningWork(ctx, "0.17.5");
  expect(work.tasks.some(t => t.taskId === task.id)).toBe(true);
  expect(storedBlockers(ctx).some(b => b.kind === "task" && b.id === task.id)).toBe(true);
});

test("stuck stopPending still lists a live session host in running-work sessions", async () => {
  const { ctx, task, dir } = seedRecordedStopPending({ liveHost: true, runnerPacer: "0.1.0" });
  const script = join(dir, "run.sh");
  writeFileSync(script, "#!/bin/sh\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", script, dir], {
    detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  writeFileSync(join(dir, "pid"), `${proc.pid}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "session.json"), "{}\n", { mode: 0o600 });
  try {
    const end = Date.now() + 5000;
    while (!readRun(dir).alive) {
      if (Date.now() > end) throw new Error("wrapper did not become alive");
      await Bun.sleep(25);
    }
    const work = await runningWork(ctx, "0.17.5");
    expect(work.tasks.some(t => t.taskId === task.id)).toBe(false);
    expect(work.sessions.some(s => s.kind === "task" && s.id === task.id)).toBe(true);
  } finally {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(proc.pid, "SIGKILL"); } catch { /* already gone */ }
    await proc.exited.catch(() => {});
    rmSync(join(dir, "pid"), { force: true });
  }
});

test("preparing task without stopPending still appears in running-work and storedBlockers", async () => {
  const ctx = fakeCtx();
  const repo = tmpDir();
  const task = createTask(ctx, {
    brief: { goal: "preparing", repo },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executorProvider = "pacer-exec-direct";
    current.runnerPacer = "0.1.0";
    current.attemptStartedAt = ctx.now;
    current.worktreeIntent = {
      attempt: 1,
      providerId: "pacer-exec-direct",
      repoTop: repo,
      repoMain: repo,
      path: join(ctx.pacerHome, "worktrees", task.id),
      workdir: join(ctx.pacerHome, "worktrees", task.id),
      branch: `pacer/${task.id}`,
      baseSha: "a".repeat(40),
    };
    delete current.run;
    delete current.stopPending;
  });
  const work = await runningWork(ctx, "0.17.5");
  expect(work.tasks.some(t => t.taskId === task.id)).toBe(true);
  expect(workCounts(work).olderRunners).toBe(1);
  expect(storedBlockers(ctx).some(b => b.kind === "task" && b.id === task.id)).toBe(true);
});

test("running task with exit file but unrecorded attempt still blocks idle and running-work", async () => {
  const ctx = fakeCtx();
  const repo = tmpDir();
  const task = createTask(ctx, {
    brief: { goal: "exit not settled", repo },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  const attempt = 1;
  const dir = join(ctx.pacerHome, "runs", task.id, String(attempt));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "pid"), "999999999\n", { mode: 0o600 });
  writeFileSync(join(dir, "exit"), "143\n", { mode: 0o600 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
    current.runnerPacer = "0.1.0";
    current.attemptStartedAt = ctx.now - 10;
    current.attempts = [];
    current.run = {
      dir,
      attempt,
      executor: "codex",
      startedAt: ctx.now - 10,
      mode: "current",
      workdir: repo,
      logFile: join(dir, "log"),
    };
    delete current.stopPending;
  });
  const pending = readTask(ctx, task.id)!;
  expect(pending.attempts.length + 1).toBe(pending.run!.attempt);
  const work = await runningWork(ctx, "0.17.5");
  expect(work.tasks.some(t => t.taskId === task.id)).toBe(true);
  expect(storedBlockers(ctx).some(b => b.kind === "task" && b.id === task.id)).toBe(true);
});
