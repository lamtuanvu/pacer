import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { executorRunState } from "../src/plugins/executor-protocol";
import { inspectOwnedExecutorRun } from "../src/plugins/executor-run-state";
import { readOutput, readRun, startRun, stopRun } from "../src/supervisor/run";
import { fakeCtx } from "./helpers";

test("host recovers a task-owned detached run from durable reader files", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-exec-state-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH ?? "" } });
  const task = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const dir = join(pacerHome, "runs", task.id, "1"), startedAt = Date.now() / 1000;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.executor = "codex";
    t.run = { dir, attempt: 1, executor: "codex", startedAt, mode: "current",
      workdir: home, logFile: join(pacerHome, "tasks", `${task.id}.codex.log`) }; });
  let stopped = false;
  try {
    expect(startRun({ dir, argv: ["sh", "-c", "echo started; sleep 30"], cwd: home, env: ctx.env })).toHaveProperty("pid");
    const deadline = Date.now() + 5000;
    while (!readRun(dir).alive) {
      if (Date.now() > deadline) throw Error("wrapper did not start");
      await Bun.sleep(25);
    }
    const running = inspectOwnedExecutorRun(ctx, task.id, 1);
    expect(executorRunState.safeParse(running).success).toBe(true);
    expect(running).toMatchObject({ task: { id: task.id, rev: readTask(ctx, task.id)!.rev },
      attempt: 1, runDir: 1, dir, state: "running", exitCode: null });
    expect(running.pid).toBeGreaterThan(1);
    expect(executorRunState.safeParse({ ...running, state: "lost" }).success).toBe(false);
    expect((await stopRun(dir, { graceMs: 3000 })).code).toBe(143);
    stopped = true;
    const afterRestart = inspectOwnedExecutorRun({ ...ctx }, task.id, 1);
    expect(afterRestart).toMatchObject({ state: "exited", exitCode: 143, dir });
    expect(executorRunState.safeParse(afterRestart).success).toBe(true);
    expect(readOutput(dir).stdout).toContain("started\n");
    updateTask(ctx, task.id, t => { if (t.run) t.run.attempt = 2; });
    expect(() => inspectOwnedExecutorRun(ctx, task.id, 1)).toThrow();
  } finally {
    if (!stopped) await stopRun(dir, { graceMs: 1000 }).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test("host refuses a replaced task-owned run directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-exec-state-swap-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  const ctx = fakeCtx({ home, pacerHome });
  const task = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const dir = join(pacerHome, "runs", task.id, "1"), moved = join(home, "moved");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.executor = "codex";
    t.run = { dir, attempt: 1, executor: "codex", startedAt: Date.now() / 1000,
      mode: "current", workdir: home, logFile: join(home, "log") }; });
  try {
    expect(inspectOwnedExecutorRun(ctx, task.id, 1).state).toBe("uncertain");
    chmodSync(dir, 0o755);
    expect(() => inspectOwnedExecutorRun(ctx, task.id, 1)).toThrow();
    chmodSync(dir, 0o700);
    renameSync(dir, moved);
    symlinkSync(moved, dir);
    expect(() => inspectOwnedExecutorRun(ctx, task.id, 1)).toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
