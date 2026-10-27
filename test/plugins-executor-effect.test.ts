import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  updateTask(ctx, task.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
  const registry = new PluginRegistry({ bundled: [{ manifest: manifestSchema.parse(manifest), main: () => import("../plugins/pacer-exec-direct/index") }],
    spawnBundled: () => ({ argv: [process.execPath, join(import.meta.dir, "../plugins/pacer-exec-direct/index.ts")], cwd: home, env: ctx.env }) });
  try {
    const marker = join(home, "effect.txt");
    const argv = ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "ran"); process.stdout.write("owned stdout\\n"); process.stderr.write("owned stderr\\n")`];
    const result = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", task.id, "codex", home,
      { argv, cwd: home, timeoutMs: 5000 });
    expect(result).toEqual({ status: "done", exitCode: 0, report: "local process exited successfully" });
    expect(readFileSync(marker, "utf8")).toBe("ran");
    expect(readTask(ctx, task.id)?.run?.attempt).toBe(1);
    expect(existsSync(join(pacerHome, "runs", task.id, "1"))).toBe(true);
    expect(readFileSync(join(pacerHome, "runs", task.id, "1", "stdout"), "utf8")).toBe("owned stdout\n");
    expect(readFileSync(join(pacerHome, "runs", task.id, "1", "stderr"), "utf8")).toBe("owned stderr\n");
    expect(statSync(join(pacerHome, "runs", task.id, "1", "stdout")).mode & 0o777).toBe(0o600);
    const binaryTask = createTask(ctx, { brief: { goal: "binary output", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, binaryTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    const binary = Buffer.from([0xff, 0x00, 0xfe, 0x0a]);
    const binaryResult = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", binaryTask.id,
      "codex", home, { argv: ["bun", "-e", `process.stdout.write(Buffer.from([255, 0, 254, 10]))`],
        cwd: home, timeoutMs: 5000 });
    expect(binaryResult.status).toBe("done");
    expect(readFileSync(join(pacerHome, "runs", binaryTask.id, "1", "stdout"))).toEqual(binary);
    const longTask = createTask(ctx, { brief: { goal: "long task allowance", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 1800 });
    updateTask(ctx, longTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    const longMarker = join(home, "long-allowance.txt");
    const longArgv = ["bun", "-e", `await Bun.write(${JSON.stringify(longMarker)}, "allowed")`];
    const longResult = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", longTask.id,
      "codex", home, { argv: longArgv, cwd: home, timeoutMs: 1_800_000 });
    expect(longResult.status).toBe("done");
    expect(readFileSync(longMarker, "utf8")).toBe("allowed");
    const overLimit = createTask(ctx, { brief: { goal: "over ceiling", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 1800 });
    updateTask(ctx, overLimit.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    await expect(runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", overLimit.id,
      "codex", home, { argv: longArgv, cwd: home, timeoutMs: 1_800_001 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(readTask(ctx, overLimit.id)?.run).toBeUndefined();
    const stdinTask = createTask(ctx, { brief: { goal: "stdin", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, stdinTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    const stdinMarker = join(home, "stdin.txt");
    const stdinResult = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", stdinTask.id,
      "codex", home, { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(stdinMarker)}, await Bun.stdin.text())`],
        cwd: home, timeoutMs: 31_000, stdin: "host-issued prompt\n" });
    expect(stdinResult.status).toBe("done");
    expect(readFileSync(stdinMarker, "utf8")).toBe("host-issued prompt\n");
    expect(readTask(ctx, stdinTask.id)?.childPid).toBeUndefined();
    const secretTask = createTask(ctx, { brief: { goal: "bound endpoint launch", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, secretTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    const secretMarker = join(home, "secret-launch.txt"), secret = "owned-endpoint-key-fixture";
    let reads = 0;
    const secretResult = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", secretTask.id,
      "codex", home, { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(secretMarker)},
        [process.env.PLAIN, process.env.PACER_KEY_FIXTURE].join(":"));
        process.stdout.write(process.env.PACER_KEY_FIXTURE.slice(0, 8));
        process.stderr.write(process.env.PACER_KEY_FIXTURE.slice(4, 12));`], cwd: home, timeoutMs: 5000,
        env: { PLAIN: "host-issued" }, secretEnv: { PACER_KEY_FIXTURE: "endpoint:fixture" } },
      [{ ref: "endpoint:fixture", resolve: async () => { reads++; return secret; } }]);
    expect(secretResult.status).toBe("done");
    expect(readFileSync(secretMarker, "utf8")).toBe(`host-issued:${secret}`);
    expect(reads).toBe(1);
    expect(JSON.stringify(secretResult)).not.toContain(secret);
    expect(existsSync(join(pacerHome, "runs", secretTask.id, "1", "stdout"))).toBe(false);
    expect(existsSync(join(pacerHome, "runs", secretTask.id, "1", "stderr"))).toBe(false);
    expect(JSON.stringify(secretResult)).not.toContain(secret.slice(0, 8));
    expect(JSON.stringify(secretResult)).not.toContain(secret.slice(4, 12));
    const unboundTask = createTask(ctx, { brief: { goal: "unbound endpoint", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, unboundTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    await expect(runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", unboundTask.id,
      "codex", home, { argv: ["bun", "-e", "process.stdout.write('bad')"], cwd: home,
        timeoutMs: 5000, secretEnv: { PACER_KEY_FIXTURE: "endpoint:fixture" } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(readTask(ctx, unboundTask.id)?.run).toBeUndefined();
    const tamperedTask = createTask(ctx, { brief: { goal: "tampered launch", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, tamperedTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    const tamperedMarker = join(home, "tampered.txt");
    const tamperedCaller = { call: (callCtx: typeof ctx, pluginId: string, method: "executor.run",
      params: unknown, options: Parameters<typeof registry.call>[4]) => {
      const original = params as { effect: { env?: Record<string, string> } };
      return registry.call(callCtx, pluginId, method,
        { ...original, effect: { ...original.effect, env: { PLAIN: "altered" } } }, options);
    } };
    await expect(runOwnedExecutorAttempt(ctx, tamperedCaller, "pacer-exec-direct", tamperedTask.id,
      "codex", home, { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(tamperedMarker)}, "bad")`],
        cwd: home, timeoutMs: 5000, env: { PLAIN: "issued" } }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(existsSync(tamperedMarker)).toBe(false);
    await expect(runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", unboundTask.id,
      "codex", home, { argv: ["bun", "-e", "process.stdout.write('bad')"], cwd: home,
        timeoutMs: 5000, env: { PACER_KEY_FIXTURE: secret } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(readTask(ctx, unboundTask.id)?.run).toBeUndefined();
    const unauthorized = join(home, "unauthorized.txt");
    await expect(registry.call(ctx, "pacer-exec-direct", "executor.run", {
      task: { id: task.id, rev: readTask(ctx, task.id)!.rev }, attempt: 2, runDir: 1,
      effect: { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(unauthorized)}, "bad")`],
        cwd: home, timeoutMs: 5000 },
    }, { onProgress: () => {} })).rejects.toMatchObject({ code: "capability_denied" });
    expect(existsSync(unauthorized)).toBe(false);

    const stoppedTask = createTask(ctx, { brief: { goal: "stop race", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, stoppedTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
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
    updateTask(ctx, replacedTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
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

    const swappedTask = createTask(ctx, { brief: { goal: "run directory swap", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, swappedTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    const swappedMarker = join(home, "swapped.txt");
    const swappingCaller = { call: (callCtx: typeof ctx, pluginId: string, method: "executor.run",
      params: unknown, options: Parameters<typeof registry.call>[4]) => {
      const dir = readTask(ctx, swappedTask.id)!.run!.dir;
      renameSync(dir, `${dir}-original`);
      mkdirSync(dir, { mode: 0o700 });
      return registry.call(callCtx, pluginId, method, params, options);
    } };
    await expect(runOwnedExecutorAttempt(ctx, swappingCaller, "pacer-exec-direct", swappedTask.id,
      "codex", home, { argv: ["bun", "-e", `await Bun.write(${JSON.stringify(swappedMarker)}, "bad")`],
        cwd: home, timeoutMs: 5000 })).rejects.toMatchObject({ code: "capability_denied" });
    expect(existsSync(swappedMarker)).toBe(false);
    expect(existsSync(join(pacerHome, "runs", swappedTask.id, "1", "stdout"))).toBe(false);

    const largeTask = createTask(ctx, { brief: { goal: "large output", repo: home }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, largeTask.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "pacer-exec-direct"; });
    const large = await runOwnedExecutorAttempt(ctx, registry, "pacer-exec-direct", largeTask.id,
      "codex", home, { argv: ["bun", "-e",
        'await new Promise(resolve => process.stdout.write("x".repeat(800000), resolve)); process.stderr.write("bounded stderr"); process.exit(3)'],
      cwd: home, timeoutMs: 5000 });
    expect(large).toEqual({ status: "failed", exitCode: 3, report: "local process exited 3: bounded stderr" });
    expect(readFileSync(join(pacerHome, "runs", largeTask.id, "1", "stdout"), "utf8")).toBe("x".repeat(800000));
    expect(readFileSync(join(pacerHome, "runs", largeTask.id, "1", "stderr"), "utf8")).toBe("bounded stderr");
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
