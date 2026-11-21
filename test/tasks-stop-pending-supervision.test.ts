import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCallAuthority } from "../src/plugins/authority";
import { answerCapability } from "../src/plugins/host";
import { manifestSchema } from "../src/plugins/protocol";
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
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
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
    errSpy.mockRestore();
    if (wrapper) {
      try { await stopRun(dir, { graceMs: 500 }); } catch { /* already gone */ }
      try { process.kill(-wrapper, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("owned running task without stopPending is left alone across supervise passes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-stop-no-pending-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current, launch_mode: headless}\n",
    { mode: 0o600 });
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH ?? "" } });
  const repo = join(home, "repo");
  mkdirSync(repo, { mode: 0o700 });
  const task = createTask(ctx, {
    brief: { goal: "stay running", repo },
    kind: "orchestrate",
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  const dir = join(pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let wrapper: number | undefined;
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
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
    await waitPid(join(dir, "child"), 5000);
    expect(readRun(dir).alive).toBe(true);

    updateTask(ctx, task.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      current.runnerPid = process.pid;
      current.attemptStartedAt = ctx.now;
      current.run = {
        dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: repo, logFile: join(dir, "log"),
      };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
    });

    for (let i = 0; i < 5; i++) {
      await superviseTasks(ctx, () => undefined);
      const latest = readTask(ctx, task.id)!;
      expect(latest.state).toBe("running");
      expect(latest.stopPending).toBeUndefined();
      expect(latest.result).toBeUndefined();
      expect(readRun(dir).alive).toBe(true);
    }
    expect(errSpy).not.toHaveBeenCalled();
  } finally {
    errSpy.mockRestore();
    if (wrapper) {
      try { await stopRun(dir, { graceMs: 500 }); } catch { /* already gone */ }
      try { process.kill(-wrapper, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("stopPending with a dead runner settles stopped", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-stop-dead-runner-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current, launch_mode: headless}\n",
    { mode: 0o600 });
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH ?? "" } });
  const repo = join(home, "repo");
  mkdirSync(repo, { mode: 0o700 });
  const task = createTask(ctx, {
    brief: { goal: "already exited", repo },
    kind: "orchestrate",
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  const dir = join(pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let wrapper: number | undefined;
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const launched = startRun({
      dir,
      argv: ["/bin/sh", "-c", "exit 0"],
      cwd: repo,
      env: { ...process.env, HOME: home, PACER_HOME: pacerHome },
      session: "pipe",
    });
    if ("error" in launched) throw new Error(launched.error);
    wrapper = launched.pid;
    chmodSync(dir, 0o700);
    // Wait until the wrapper is gone so runnerPid is not alive.
    for (let i = 0; i < 40 && readRun(dir).alive; i++) await Bun.sleep(50);
    expect(readRun(dir).alive).toBe(false);

    updateTask(ctx, task.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      current.runnerPid = 1_000_000_000; // not alive
      current.attemptStartedAt = ctx.now;
      current.run = {
        dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: repo, logFile: join(dir, "log"),
      };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
      current.stopPending = {
        attempt: 1, requestedAt: ctx.now, providerId: "pacer-exec-direct", graceMs: 5000, reason: "user",
      };
    });

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
  } finally {
    errSpy.mockRestore();
    if (wrapper) {
      try { await stopRun(dir, { graceMs: 200 }); } catch { /* already gone */ }
      try { process.kill(-wrapper, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("early-settle stopPending with no launch artifacts settles while runner is alive and claim refuses", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-stop-early-settle-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current, launch_mode: headless}\n",
    { mode: 0o600 });
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH ?? "" }, now: Date.now() / 1000 });
  const repo = join(home, "repo");
  mkdirSync(repo, { mode: 0o700 });
  const hang = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; while :; do sleep 0.1; done"], {
    stdout: "ignore", stderr: "ignore",
  });
  const task = createTask(ctx, {
    brief: { goal: "never launched", repo },
    kind: "orchestrate",
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  // Empty run dir: no pid / exit / startIntent / childPid → early-settle branch.
  const dir = join(pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    updateTask(ctx, task.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      current.runnerPid = hang.pid!;
      current.attemptStartedAt = ctx.now;
      current.run = {
        dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: repo, logFile: join(dir, "log"),
      };
      current.stopPending = {
        attempt: 1, requestedAt: ctx.now, providerId: "pacer-exec-direct", graceMs: 5000, reason: "user",
      };
    });
    expect(process.kill(hang.pid!, 0)).toBe(true);
    expect(existsSync(join(dir, "pid"))).toBe(false);
    expect(existsSync(join(dir, "exit"))).toBe(false);

    // Claim must refuse while stopPending is set (production launch path).
    const manifest = manifestSchema.parse({
      id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: ">=1.9.0",
      contributes: { executor: { backends: ["direct"] } },
      capabilities: [{ name: "process.spawn", scopes: ["bun", "codex"] }],
    });
    const executable = realpathSync(process.execPath);
    const binary = statSync(executable);
    const authority = createCallAuthority(ctx, {
      reads: [], commands: [], stores: [],
      executorClaim: {
        taskId: task.id, attempt: 1, providerId: manifest.id, executor: "codex", workdir: repo,
        launch: {
          argv: ["bun", "-e", "process.exit(0)"], cwd: repo, executable,
          executableIdentity: {
            dev: binary.dev, ino: binary.ino, size: binary.size,
            mtimeMs: binary.mtimeMs, mode: binary.mode,
          },
          env: { PATH: ctx.env.PATH ?? "/usr/bin:/bin" },
        },
      },
    }, { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
    try {
      await expect(answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.claimRun", { taskId: task.id, attempt: 1 }, authority))
        .rejects.toMatchObject({ code: "capability_denied" });
    } finally {
      await authority.revoke();
    }
    expect(readTask(ctx, task.id)?.stopPending).toBeDefined();
    expect(readTask(ctx, task.id)?.state).toBe("running");

    await superviseTasks(ctx, () => undefined);
    const settled = readTask(ctx, task.id);
    expect(settled?.state).toBe("stopped");
    expect(settled?.stopPending).toBeUndefined();
    expect(settled?.result?.report).toMatch(/stopped before an executor ran/i);
    // Early settle must not wait for the runner process to die.
    expect(process.kill(hang.pid!, 0)).toBe(true);
  } finally {
    errSpy.mockRestore();
    try { hang.kill("SIGKILL"); } catch { /* already gone */ }
    await hang.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
