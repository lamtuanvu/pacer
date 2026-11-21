import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseTasks, taskStop } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { TERMINAL_STATES } from "../src/tasks/types";
import { readRun, startRun, stopRun } from "../src/supervisor/run";
import { fakeCtx, readPid, waitPid } from "./helpers";

/**
 * Regression for the S10 live defect: task.stop / run stop set stopPending on a
 * provider-owned attempt, but superviseTasks skipped any task whose runnerPid was
 * still alive. Nothing called executor.stop, so a hang that traps SIGTERM lived
 * forever and kept machine.used elevated.
 */
test("superviseTasks reconciles stopPending while the local runner pid is still alive", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-stop-alive-runner-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current, launch_mode: headless}\n",
    { mode: 0o600 });
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH ?? "" } });
  const repo = join(home, "repo");
  mkdirSync(repo, { mode: 0o700 });
  const task = createTask(ctx, {
    brief: { goal: "hang forever", repo },
    kind: "orchestrate",
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  const dir = join(pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let wrapper: number | undefined;
  try {
    const launched = startRun({
      dir,
      argv: ["/bin/sh", "-c", "trap '' TERM; while :; do sleep 0.1; done"],
      cwd: repo,
      env: { ...process.env, HOME: home, PACER_HOME: pacerHome },
      session: "pipe",
    });
    if ("error" in launched) throw new Error(launched.error);
    wrapper = launched.pid;
    chmodSync(dir, 0o700);
    const child = await waitPid(join(dir, "child"), 5000);
    expect(readRun(dir).alive).toBe(true);
    expect(process.kill(child, 0)).toBe(true);

    updateTask(ctx, task.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      // Simulate a live `_run` process that has not exited yet.
      current.runnerPid = process.pid;
      current.attemptStartedAt = ctx.now;
      current.run = {
        dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: repo, logFile: join(dir, "log"),
      };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
    });

    const pending = taskStop(ctx, task.id)!;
    expect(pending.state).toBe("running");
    expect(pending.stopPending?.reason).toBe("user");

    await superviseTasks(ctx, () => undefined);

    const settled = await (async () => {
      let latest = readTask(ctx, task.id);
      for (let i = 0; i < 40 && latest && !TERMINAL_STATES.includes(latest.state); i++) {
        await superviseTasks(ctx, () => undefined);
        latest = readTask(ctx, task.id);
        await Bun.sleep(50);
      }
      return latest;
    })();

    expect(settled?.state).toBe("stopped");
    expect(settled?.stopPending).toBeUndefined();
    expect(readRun(dir).alive).toBe(false);
    const childState = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child)]).stdout.toString().trim();
    expect(childState === "" || childState.startsWith("Z")).toBe(true);
    expect(existsSync(join(dir, "exit")) || readPid(join(dir, "pid")) !== child).toBe(true);
  } finally {
    if (wrapper) {
      try { await stopRun(dir, { graceMs: 500 }); } catch { /* already gone */ }
      try { process.kill(-wrapper, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
