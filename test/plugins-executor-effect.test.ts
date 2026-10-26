import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeCtx } from "./helpers";
import { manifest } from "../plugins/pacer-exec-direct/manifest";
import { PluginRegistry } from "../src/plugins/registry";
import { manifestSchema } from "../src/plugins/protocol";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { taskStop } from "../src/tasks/api";
import { runOwnedExecutorAttempt } from "../src/plugins/executor-attempt";

test("owned direct plugin call executes only the exact host-issued local process", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-direct-effect-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  const ctx = fakeCtx({ home, pacerHome, now: Date.now() / 1000,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    which: binary => binary === "bun" ? process.execPath : null });
  const task = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.executor = "codex"; });
  const registry = new PluginRegistry({ bundled: [{ manifest: manifestSchema.parse(manifest), main: () => import("../plugins/pacer-exec-direct/index") }],
    spawnBundled: () => ({ argv: [process.execPath, join(import.meta.dir, "../plugins/pacer-exec-direct/index.ts")], cwd: home, env: ctx.env }) });
  try {
    const marker = join(home, "effect.txt");
    const argv = ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`];
    const result = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv, cwd: home, timeoutMs: 5000 });
    expect(result).toEqual({ status: "done", exitCode: 0, report: "local process exited successfully" });
    expect(readFileSync(marker, "utf8")).toBe("ran");
    expect(readTask(ctx, task.id)?.run?.attempt).toBe(1);
    expect(existsSync(join(pacerHome, "runs", task.id, "1"))).toBe(true);
    const unauthorized = join(home, "unauthorized.txt");
    await expect(registry.call(ctx, "pacer-exec-direct", "executor.run", {
      task: { id: task.id, rev: readTask(ctx, task.id)!.rev }, attempt: 2, runDir: 1,
      effect: { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(unauthorized)}, "bad")`],
        cwd: home, timeoutMs: 5000 },
    }, { onProgress: () => {} })).rejects.toMatchObject({ code: "capability_denied" });
    expect(existsSync(unauthorized)).toBe(false);

    const stoppedTask = createTask(ctx, { brief: { goal: "stop race", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, stoppedTask.id, t => { t.state = "running"; t.executor = "codex"; });
    const racedMarker = join(home, "raced.txt");
    const stoppingCaller = { call: (callCtx: typeof ctx, pluginId: string, method: "executor.run",
      params: unknown, options: Parameters<typeof registry.call>[4]) => {
      taskStop(ctx, stoppedTask.id); // Deterministically after helper precheck, before plugin capability RPC.
      return registry.call(callCtx, pluginId, method, params, options);
    } };
    await expect(runOwnedExecutorAttempt(ctx, stoppingCaller, "pacer-exec-direct", stoppedTask.id,
      "codex", home, { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(racedMarker)}, "bad")`],
        cwd: home, timeoutMs: 5000 })).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(racedMarker)).toBe(false);

    const replacedTask = createTask(ctx, { brief: { goal: "owner race", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, replacedTask.id, t => { t.state = "running"; t.executor = "codex"; });
    const replacedMarker = join(home, "replaced.txt");
    const replacingCaller = { call: (callCtx: typeof ctx, pluginId: string, method: "executor.run",
      params: unknown, options: Parameters<typeof registry.call>[4]) => {
      updateTask(ctx, replacedTask.id, t => { if (t.run) t.run.attempt = 99; });
      return registry.call(callCtx, pluginId, method, params, options);
    } };
    await expect(runOwnedExecutorAttempt(ctx, replacingCaller, "pacer-exec-direct", replacedTask.id,
      "codex", home, { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(replacedMarker)}, "bad")`],
        cwd: home, timeoutMs: 5000 })).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(replacedMarker)).toBe(false);

    const largeTask = createTask(ctx, { brief: { goal: "large output", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, largeTask.id, t => { t.state = "running"; t.executor = "codex"; });
    const large = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", largeTask.id,
      "codex", home, { argv: ["bun", "-e",
        'process.stdout.write("x".repeat(800000)); process.stderr.write("bounded stderr"); process.exit(3)'],
      cwd: home, timeoutMs: 5000 });
    expect(large).toEqual({ status: "failed", exitCode: 3, report: "local process exited 3: bounded stderr" });
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
