import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { manifest } from "../plugins/pacer-exec-direct/manifest";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import { manifestSchema } from "../src/plugins/protocol";
import { runOwnedExecutorAttempt } from "../src/plugins/executor-attempt";
import { stopOwnedExecutorAttempt } from "../src/plugins/executor-stop";
import { answerDetachedRun } from "../src/plugins/capability-detached-run";
import { answerDetachedStop } from "../src/plugins/capability-detached-stop";
import { createCallAuthority } from "../src/plugins/authority";
import { CoreError } from "../src/core/errors";
import { taskStop } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readOutput, readRun, stopRun } from "../src/supervisor/run";

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-detached-plugin-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  const ctx = fakeCtx({ home, pacerHome, now: Date.now() / 1000,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    which: binary => binary === "bun" ? process.execPath : null });
  const task = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, value => { value.state = "running"; value.executor = "codex"; value.executorProvider = "pacer-exec-direct"; });
  const registry = new PluginRegistry({ bundled: [{ manifest: manifestSchema.parse(manifest),
    main: () => import("../plugins/pacer-exec-direct/index") }],
  spawnBundled: () => ({ argv: [process.execPath, join(import.meta.dir, "../plugins/pacer-exec-direct/index.ts")], cwd: home, env: ctx.env }) });
  return { home, ctx, task, registry };
};

test("bundled executor launches one task-owned detached wrapper with existing reader parity", async () => {
  const { home, ctx, task, registry } = fixture();
  const marker = join(home, "started.txt");
  let dir: string | undefined;
  try {
    const result = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "started"); console.log("detached output"); await Bun.sleep(30000)`],
        cwd: home, timeoutMs: 60000, detached: true });
    expect(result.status).toBe("launched");
    if (result.status !== "launched") throw Error("detached run was not launched");
    dir = readTask(ctx, task.id)?.run?.dir;
    expect(dir).toBeDefined();
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) || !readOutput(dir!).stdout.includes("detached output")) {
      if (Date.now() > deadline || readRun(dir!).exit !== null) throw Error("detached wrapper did not start: " + JSON.stringify(readRun(dir!)));
      await Bun.sleep(25);
    }
    expect(readFileSync(marker, "utf8")).toBe("started");
    expect(readRun(dir!).pid).toBe(result.pid);
    expect(readOutput(dir!).stdout).toContain("detached output");
    for (const name of ["pid", "stdout", "stderr"]) expect(statSync(join(dir!, name)).mode & 0o777).toBe(0o600);
    expect((await stopRun(dir!, { graceMs: 3000 })).code).toBe(143);
    expect(readRun(dir!).exit).toBe(143);
  } finally {
    if (dir) await stopRun(dir, { graceMs: 1000 }).catch(() => {});
    await registry.shutdown(); rmSync(home, { recursive: true, force: true });
  }
});

test("detached launch denies credential references before claiming a run directory", async () => {
  const { home, ctx, task, registry } = fixture();
  try {
    await expect(runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", "console.log('secret')"], cwd: home, timeoutMs: 5000,
        detached: true, secretEnv: { PACER_KEY_FIXTURE: "endpoint:fixture" } },
      [{ ref: "endpoint:fixture", resolve: async () => "fixture-key" }]))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});

test("persisted provider stop intent refuses a later detached launch", async () => {
  const { home, ctx, task, registry } = fixture();
  const marker = join(home, "stop-before-start.txt");
  try {
    updateTask(ctx, task.id, current => { current.executorProvider = "pacer-exec-direct"; });
    expect(taskStop(ctx, task.id)?.stopPending?.attempt).toBe(1);
    await expect(runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "wrong")`],
        cwd: home, timeoutMs: 5000, detached: true })).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(marker)).toBe(false);
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});

test("bundled executor stops only its task-owned detached wrapper", async () => {
  const { home, ctx, task, registry } = fixture();
  const marker = join(home, "stop-started.txt");
  let dir: string | undefined;
  try {
    await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "started"); await Bun.sleep(30000)`],
        cwd: home, timeoutMs: 60000, detached: true });
    dir = readTask(ctx, task.id)?.run?.dir;
    expect(dir).toBeDefined();
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw Error("detached wrapper did not start");
      await Bun.sleep(25);
    }
    expect(taskStop(ctx, task.id)?.stopPending).toBeDefined();
    const stopped = await stopOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, 1, 5000);
    expect(stopped.code).toBe(143);
    expect(stopped.killed).toBe(false);
    expect(readRun(dir!).exit).toBe(143);
    await expect(stopOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, 1, 5000))
      .rejects.toMatchObject({ code: "conflict" });
  } finally {
    if (dir) await stopRun(dir, { graceMs: 1000 }).catch(() => {});
    await registry.shutdown(); rmSync(home, { recursive: true, force: true });
  }
});

test("progress revision churn does not invalidate a pending owned stop", async () => {
  const { home, ctx, task, registry } = fixture();
  let dir: string | undefined;
  try {
    await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", "await Bun.sleep(30000)"], cwd: home,
        timeoutMs: 60000, detached: true });
    dir = readTask(ctx, task.id)?.run?.dir;
    updateTask(ctx, task.id, current => { current.executorProvider = "pacer-exec-direct"; });
    expect(taskStop(ctx, task.id)?.stopPending).toBeDefined();
    const stopped = await stopOwnedExecutorAttempt(ctx, {
      call: (callCtx, pluginId, method, params, options) => {
        updateTask(ctx, task.id, current => { current.progress = {
          phase: "working", lastOutputAt: null, lastChangeAt: null, files: 0, commits: 0,
          logBytes: 0, host: "local", updatedAt: Date.now() / 1000,
        }; });
        return registry.call(callCtx, pluginId, method, params, options);
      },
    }, "pacer-exec-direct", task.id, 1, 5000);
    expect(stopped.code).toBe(143);
    expect(readRun(dir!).exit).toBe(143);
  } finally {
    if (dir) await stopRun(dir, { graceMs: 1000 }).catch(() => {});
    await registry.shutdown(); rmSync(home, { recursive: true, force: true });
  }
});

test("pending stop refuses a changed persisted run owner without signaling it", async () => {
  const { home, ctx, task, registry } = fixture();
  let dir: string | undefined;
  try {
    await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", "await Bun.sleep(30000)"], cwd: home,
        timeoutMs: 60000, detached: true });
    dir = readTask(ctx, task.id)?.run?.dir;
    updateTask(ctx, task.id, current => { current.executorProvider = "pacer-exec-direct"; });
    taskStop(ctx, task.id);
    await expect(stopOwnedExecutorAttempt(ctx, {
      call: (callCtx, pluginId, method, params, options) => {
        updateTask(ctx, task.id, current => { current.run!.startedAt += 1; });
        return registry.call(callCtx, pluginId, method, params, options);
      },
    }, "pacer-exec-direct", task.id, 1, 5000)).rejects.toMatchObject({ code: "capability_denied" });
    expect(readRun(dir!).alive).toBe(true);
  } finally {
    if (dir) await stopRun(dir, { graceMs: 1000 }).catch(() => {});
    await registry.shutdown(); rmSync(home, { recursive: true, force: true });
  }
});

test("stale stop owner is refused without signaling its detached wrapper", async () => {
  const { home, ctx, task, registry } = fixture();
  const marker = join(home, "stale-stop-started.txt");
  let dir: string | undefined;
  try {
    await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "started"); await Bun.sleep(30000)`],
        cwd: home, timeoutMs: 60000, detached: true });
    dir = readTask(ctx, task.id)?.run?.dir;
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw Error("detached wrapper did not start");
      await Bun.sleep(25);
    }
    expect(taskStop(ctx, task.id)?.stopPending).toBeDefined();
    await expect(stopOwnedExecutorAttempt(ctx, {
      call: (callCtx, pluginId, method, params, options) => {
        updateTask(ctx, task.id, value => { value.state = "stopped"; });
        return registry.call(callCtx, pluginId, method, params, options);
      },
    }, "pacer-exec-direct", task.id, 1, 5000)).rejects.toMatchObject({ code: "capability_denied" });
    expect(readRun(dir!).alive).toBe(true);
  } finally {
    if (dir) await stopRun(dir, { graceMs: 1000 }).catch(() => {});
    await registry.shutdown(); rmSync(home, { recursive: true, force: true });
  }
});

test("unverified stop receipt cannot settle a running wrapper", async () => {
  const { home, ctx, task, registry } = fixture();
  const marker = join(home, "uncertain-stop-started.txt");
  let dir: string | undefined;
  try {
    await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "started"); await Bun.sleep(30000)`],
        cwd: home, timeoutMs: 60000, detached: true });
    dir = readTask(ctx, task.id)?.run?.dir;
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw Error("detached wrapper did not start");
      await Bun.sleep(25);
    }
    expect(taskStop(ctx, task.id)?.stopPending).toBeDefined();
    await expect(stopOwnedExecutorAttempt(ctx, {
      call: async () => ({ code: 143, killed: false }),
    }, "pacer-exec-direct", task.id, 1, 5000)).rejects.toMatchObject({ code: "conflict" });
    expect(readRun(dir!).alive).toBe(true);
    await expect(stopOwnedExecutorAttempt(ctx, {
      call: async () => { throw new CoreError("plugin_unavailable", "provider lost"); },
    }, "pacer-exec-direct", task.id, 1, 5000)).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(readRun(dir!).alive).toBe(true);
  } finally {
    if (dir) await stopRun(dir, { graceMs: 1000 }).catch(() => {});
    await registry.shutdown(); rmSync(home, { recursive: true, force: true });
  }
});

test("detached stop broker rejects foreign identity and replay", async () => {
  const { home, ctx, task, registry } = fixture();
  const marker = join(home, "broker-stop-started.txt");
  let dir: string | undefined;
  try {
    await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "started"); await Bun.sleep(30000)`],
        cwd: home, timeoutMs: 60000, detached: true });
    dir = readTask(ctx, task.id)?.run?.dir;
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw Error("detached wrapper did not start");
      await Bun.sleep(25);
    }
    const persisted = readTask(ctx, task.id)!, run = readRun(dir!);
    const linked = statSync(dir!);
    const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], detachedStop: {
      taskId: task.id, rev: persisted.rev, attempt: 1, dir: dir!,
      dirIdentity: { dev: linked.dev, ino: linked.ino }, pid: run.pid!,
      startedAt: persisted.run!.startedAt, executor: "codex", graceMs: 3000,
    } }, { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
    await expect(answerDetachedStop(authority, { taskId: "t-foreign", attempt: 1, graceMs: 3000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(readRun(dir!).alive).toBe(true);
    expect((await answerDetachedStop(authority, { taskId: task.id, attempt: 1, graceMs: 3000 })).code).toBe(143);
    await expect(answerDetachedStop(authority, { taskId: task.id, attempt: 1, graceMs: 3000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    await authority.revoke();
  } finally {
    if (dir) await stopRun(dir, { graceMs: 1000 }).catch(() => {});
    await registry.shutdown(); rmSync(home, { recursive: true, force: true });
  }
});

test("unissued public executor stop cannot reach a local process", async () => {
  const { home, ctx, task, registry } = fixture();
  try {
    await expect(registry.call(ctx, "pacer-exec-direct", "executor.stop",
      { taskId: task.id, attempt: 1, graceMs: 1000 }, { deadlineMs: 5000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});

test("one-use launch grant refuses a stale task owner and replay", async () => {
  const { home, ctx, task, registry } = fixture();
  const marker = join(home, "must-not-start.txt");
  try {
    await expect(runOwnedExecutorAttempt(ctx, {
      call: async (_ctx, _plugin, _method, params, options) => {
        const input = params as { task: { id: string; rev: number }; attempt: number; runDir: 1 };
        const authority = createCallAuthority(ctx, options.resources!, {
          deadlineMs: Date.now() + 5000, grants: ["process.spawn"],
        });
        updateTask(ctx, task.id, value => { value.state = "stopped"; });
        expect(() => answerDetachedRun(authority, ["bun"], input))
          .toThrow();
        expect(() => authority.consumeDetachedRun(input.task.id, input.task.rev, input.attempt))
          .toThrow();
        await authority.revoke();
        return { status: "launched", pid: 999, report: "stale" };
      },
    }, "pacer-exec-direct", task.id, "codex", home,
    { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "wrong")`],
      cwd: home, timeoutMs: 5000, detached: true })).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(marker)).toBe(false);
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
