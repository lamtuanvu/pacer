import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installFixture } from "../conformance/install";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import { PluginProcess } from "../src/plugins/process";
import { CoreError } from "../src/core/errors";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { applyExecutorProgress } from "../src/plugins/executor-progress";
import { EXTENSION_METHODS } from "../src/plugins/protocol";
import { executorRunEvent } from "../src/plugins/executor-protocol";

test("staged executor run and stop have bounded, credential-free contracts", () => {
  const run = EXTENSION_METHODS["executor.run"]!;
  const stop = EXTENSION_METHODS["executor.stop"]!;
  expect(run.deadlineMs).toBe(0);
  expect(run.params.safeParse({ task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 1 }).success).toBe(true);
  const effect = { argv: ["codex", "exec"], cwd: "/owned/repo", timeoutMs: 1_800_000 };
  expect(run.params.safeParse({ task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 1, effect }).success).toBe(true);
  expect(run.params.safeParse({ task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 1,
    effect: { ...effect, detached: true } }).success).toBe(true);
  expect(run.result.safeParse({ status: "launched", pid: 123, report: "started" }).success).toBe(true);
  expect(run.result.safeParse({ status: "launched", exitCode: 0, report: "started" }).success).toBe(false);
  expect(run.params.safeParse({ task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 1,
    effect: { ...effect, timeoutMs: 1_800_001 } }).success).toBe(false);
  for (const params of [
    { task: { id: "t-fixture", rev: 0 }, attempt: 1, runDir: 1 },
    { task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 1, env: { TOKEN: "secret" } },
    { task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 2 },
  ]) expect(run.params.safeParse(params).success).toBe(false);
  expect(stop.params.safeParse({ taskId: "t-fixture", attempt: 1, graceMs: 2000 }).success).toBe(true);
  expect(stop.params.safeParse({ taskId: "t-fixture", attempt: 1, graceMs: 30001 }).success).toBe(false);
  expect(executorRunEvent.safeParse({ kind: "spawned", pid: 123 }).success).toBe(true);
  expect(executorRunEvent.safeParse({ kind: "progress", expectRev: 1, progress: { phase: "working", lastOutputAt: null,
    lastChangeAt: null, files: 0, commits: 0, logBytes: 0, host: "local", updatedAt: 1 } }).success).toBe(true);
  expect(executorRunEvent.safeParse({ kind: "log", stream: "stdout", text: "x".repeat(4097) }).success).toBe(false);
  expect(executorRunEvent.safeParse({ kind: "patch", patch: { state: "done" } }).success).toBe(false);
});

test("fake executor streams validated progress and a stop acknowledgement", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-executor-run-"));
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, now: Date.now() / 1000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\n");
  const folder = installFixture("executor", join(ctx.pacerHome, "plugins"));
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle"); }, eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "fx-executor", true);
    const events: unknown[] = [];
    const input = { task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 1 };
    expect(await registry.call(ctx, "fx-executor", "executor.run", input, { onProgress: e => events.push(e) }))
      .toEqual({ status: "done", exitCode: 0, report: "fixture complete" });
    expect(events).toEqual([{ kind: "progress", expectRev: 1,
      progress: { phase: "working", lastOutputAt: null, lastChangeAt: null,
        files: 0, commits: 0, logBytes: 0, host: "local", updatedAt: 1 } }]);
    expect(await registry.call(ctx, "fx-executor", "executor.stop", { taskId: "t-fixture", attempt: 1, graceMs: 1000 }))
      .toEqual({ code: 0, killed: true });
    await expect(registry.call(ctx, "fx-executor", "executor.run", input)).rejects.toMatchObject({ code: "invalid_input" });
    writeFileSync(join(folder, "fixture.json"), JSON.stringify({ available: true, malformed: false, malformedProgress: true }));
  } finally { await registry.shutdown(); }
  const malformed = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle"); }, eventPumpMs: 0 });
  try {
    await expect(malformed.call(ctx, "fx-executor", "executor.run",
      { task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 1 }, { onProgress: () => {} }))
      .rejects.toMatchObject({ code: "plugin_refused" });
  } finally { await malformed.shutdown(); rmSync(home, { recursive: true, force: true }); }
});

test("host refusal of a progress event fails the owning run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-executor-refuse-"));
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, now: Date.now() / 1000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\n");
  installFixture("executor", join(ctx.pacerHome, "plugins"));
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle"); }, eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "fx-executor", true);
    await expect(registry.call(ctx, "fx-executor", "executor.run",
      { task: { id: "t-fixture", rev: 1 }, attempt: 1, runDir: 1 },
      { onProgress: () => { throw new CoreError("conflict", "task changed"); } }))
      .rejects.toMatchObject({ code: "conflict" });
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});

test("staged stop rejects an unbounded override and caps an oversized override", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-executor-stop-bound-"));
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, now: Date.now() / 1000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\n");
  installFixture("executor", join(ctx.pacerHome, "plugins"), { fixture: { stallStop: true } });
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle"); }, eventPumpMs: 0 });
  const stop = { taskId: "t-fixture", attempt: 1, graceMs: 1000 };
  const original = PluginProcess.prototype.request;
  const observed: number[] = [];
  try {
    await registry.enable(ctx, "fx-executor", true);
    const zeroAbort = new AbortController();
    const zeroTimer = setTimeout(() => zeroAbort.abort(), 100);
    try {
      await expect(registry.call(ctx, "fx-executor", "executor.stop", stop,
        { deadlineMs: 0, signal: zeroAbort.signal })).rejects.toMatchObject({ code: "invalid_input" });
    } finally { clearTimeout(zeroTimer); }
    let entered!: () => void;
    const requestEntered = new Promise<void>(resolve => { entered = resolve; });
    PluginProcess.prototype.request = function<T>(method: string, params: unknown, deadlineMs: number,
      options = {}): Promise<T> {
      if (method === "executor.stop") { observed.push(deadlineMs); entered(); }
      return original.call(this, method, params, deadlineMs, options) as Promise<T>;
    };
    const controller = new AbortController();
    const pending = registry.call(ctx, "fx-executor", "executor.stop", stop,
      { deadlineMs: 30_001, signal: controller.signal });
    await requestEntered;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeGreaterThan(0);
    expect(observed[0]).toBeLessThanOrEqual(30_000);
  } finally {
    PluginProcess.prototype.request = original;
    await registry.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});

test("fake run progress reaches only the host-selected running task", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-executor-owned-"));
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, now: Date.now() / 1000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\n");
  installFixture("executor", join(ctx.pacerHome, "plugins"));
  const selected = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const foreign = createTask(ctx, { brief: { goal: "foreign", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const run = { dir: join(ctx.pacerHome, "runs", selected.id, "1"), attempt: 1, executor: "codex",
    startedAt: ctx.now, mode: "current" as const, workdir: home, logFile: join(home, "run.log") };
  const running = updateTask(ctx, selected.id, t => { t.state = "running"; t.run = run; });
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle"); }, eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "fx-executor", true);
    const input = { task: { id: selected.id, rev: running.rev }, attempt: 1, runDir: 1 };
    await registry.call(ctx, "fx-executor", "executor.run", input,
      { onProgress: event => applyExecutorProgress(ctx, selected.id, 1, event, run) });
    expect(readTask(ctx, selected.id)?.progress?.phase).toBe("working");
    expect(readTask(ctx, foreign.id)?.progress).toBeUndefined();
    await expect(registry.call(ctx, "fx-executor", "executor.run", input,
      { onProgress: event => applyExecutorProgress(ctx, selected.id, 1, event, run) }))
      .rejects.toMatchObject({ code: "conflict" });
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
