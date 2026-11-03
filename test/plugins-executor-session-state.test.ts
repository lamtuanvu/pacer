import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { manifest } from "../plugins/pacer-exec-direct/manifest";
import { answerDetachedInspect } from "../src/plugins/capability-detached-inspect";
import { createCallAuthority } from "../src/plugins/authority";
import { inspectOwnedExecutorSession } from "../src/plugins/executor-session-state";
import { PluginRegistry } from "../src/plugins/registry";
import { manifestSchema } from "../src/plugins/protocol";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readRun, startRun, stopRun } from "../src/supervisor/run";
import { fakeCtx } from "./helpers";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pacer-exec-session-state-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } });
  const task = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const dir = join(pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  updateTask(ctx, task.id, value => {
    value.state = "running"; value.executor = "codex";
    value.run = { dir, attempt: 1, executor: "codex", startedAt: Date.now() / 1000,
      mode: "current", workdir: home, logFile: join(dir, "stdout") };
  });
  const registry = new PluginRegistry({ bundled: [{ manifest: manifestSchema.parse(manifest),
    main: () => import("../plugins/pacer-exec-direct/index") }],
  spawnBundled: () => ({ argv: [process.execPath, join(import.meta.dir, "../plugins/pacer-exec-direct/index.ts")], cwd: home, env: ctx.env }) });
  return { home, ctx, task, dir, registry };
}

test("bundled executor inspects an exact persisted wrapper after service restart", async () => {
  const f = fixture();
  try {
    expect(startRun({ dir: f.dir, argv: ["sleep", "30"], cwd: f.home, env: f.ctx.env })).toHaveProperty("pid");
    const deadline = Date.now() + 5000;
    while (!readRun(f.dir).alive) {
      if (Date.now() > deadline) throw Error("wrapper did not start");
      await Bun.sleep(25);
    }
    expect(await inspectOwnedExecutorSession({ ...f.ctx }, f.registry, "pacer-exec-direct", f.task.id, 1))
      .toEqual({ state: "running", host: "builtin", handle: null });
    expect((await stopRun(f.dir, { graceMs: 3000 })).code).toBe(143);
    expect(await inspectOwnedExecutorSession({ ...f.ctx }, f.registry, "pacer-exec-direct", f.task.id, 1))
      .toEqual({ state: "exited", host: "builtin", handle: null });
  } finally {
    await stopRun(f.dir, { graceMs: 1000 }).catch(() => {});
    await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true });
  }
});

test("uncertain wrapper state is distinct from a confirmed exit", async () => {
  const f = fixture();
  try {
    expect(readRun(f.dir).pid).toBeNull();
    expect(await inspectOwnedExecutorSession(f.ctx, f.registry, "pacer-exec-direct", f.task.id, 1))
      .toEqual({ state: "uncertain", host: "builtin", handle: null });
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("stale owner is refused, and public unissued session inspection has no grant", async () => {
  const f = fixture();
  try {
    await expect(inspectOwnedExecutorSession(f.ctx, {
      call: (ctx, id, method, params, options) => {
        updateTask(f.ctx, f.task.id, value => { value.state = "stopped"; });
        return f.registry.call(ctx, id, method, params, options);
      },
    }, "pacer-exec-direct", f.task.id, 1)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(f.registry.call(f.ctx, "pacer-exec-direct", "executor.sessionState",
      { taskId: f.task.id, attempt: 1 }, { deadlineMs: 5000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("inspection grant rejects foreign identity and replay", async () => {
  const f = fixture();
  try {
    const task = readTask(f.ctx, f.task.id)!;
    const linked = statSync(f.dir);
    const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [], detachedInspect: {
      taskId: f.task.id, rev: task.rev, attempt: 1, dir: f.dir,
      dirIdentity: { dev: linked.dev, ino: linked.ino },
      startedAt: task.run!.startedAt, executor: "codex",
    } }, { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
    expect(() => answerDetachedInspect(authority, { taskId: "t-foreign", attempt: 1 }))
      .toThrow();
    expect(answerDetachedInspect(authority, { taskId: f.task.id, attempt: 1 }).state).toBe("uncertain");
    expect(() => answerDetachedInspect(authority, { taskId: f.task.id, attempt: 1 }))
      .toThrow();
    await authority.revoke();
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});

test("replaced run directory refuses a previously issued inspection grant", async () => {
  const f = fixture();
  const moved = join(f.home, "old-run");
  try {
    await expect(inspectOwnedExecutorSession(f.ctx, {
      call: (ctx, id, method, params, options) => {
        renameSync(f.dir, moved);
        mkdirSync(f.dir, { mode: 0o700 });
        return f.registry.call(ctx, id, method, params, options);
      },
    }, "pacer-exec-direct", f.task.id, 1)).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await f.registry.shutdown(); rmSync(f.home, { recursive: true, force: true }); }
});
