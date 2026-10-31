import { expect, spyOn, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { CoreError } from "../src/core/errors";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runOwnedExecutorAttempt } from "../src/plugins/executor-attempt";
import { writeNative } from "../src/plugins/write-native";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pacer-owned-exec-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  const ctx = fakeCtx({ home, pacerHome, now: Date.now() / 1000 });
  const task = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const running = updateTask(ctx, task.id, t => { t.state = "running"; t.executor = "codex"; t.executorProvider = "fx-executor"; });
  return { home, ctx, task: running, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("host claims a private attempt directory and binds fake plugin progress to the selected task", async () => {
  const { home, ctx, task, cleanup } = fixture();
  let calls = 0;
  try {
    const result = await runOwnedExecutorAttempt(ctx, {
      call: async (_ctx, id, method, params, options) => {
        calls++;
        expect(id).toBe("fx-executor");
        expect(method).toBe("executor.run");
        const input = params as { task: { id: string; rev: number }; attempt: number; runDir: number };
        expect(input).toEqual({ task: { id: task.id, rev: readTask(ctx, task.id)!.rev }, attempt: 1, runDir: 1 });
        options.onProgress?.({ kind: "progress", expectRev: input.task.rev,
          progress: { phase: "working", lastOutputAt: null, lastChangeAt: null,
            files: 0, commits: 0, logBytes: 0, host: "local", updatedAt: 1 } });
        return { status: "done", exitCode: 0, report: "fixture complete" };
      },
    }, "fx-executor", task.id, "codex", home);
    expect(result).toEqual({ status: "done", exitCode: 0, report: "fixture complete" });
    expect(calls).toBe(1);
    const current = readTask(ctx, task.id)!;
    expect(current.progress?.phase).toBe("working");
    expect(current.run?.dir).toBe(join(ctx.pacerHome, "runs", task.id, "1"));
    expect(lstatSync(current.run!.dir).mode & 0o777).toBe(0o700);
    await expect(runOwnedExecutorAttempt(ctx, { call: async () => { throw Error("must not call"); } },
      "fx-executor", task.id, "codex", home)).rejects.toMatchObject({ code: "conflict" });
  } finally { cleanup(); }
});

test("host refuses symlinked, permissive, and stale attempt directories before plugin invocation", async () => {
  for (const bad of ["symlink", "permissive", "stale"] as const) {
    const { home, ctx, task, cleanup } = fixture();
    let called = false;
    try {
      const runs = join(ctx.pacerHome, "runs");
      if (bad === "symlink") symlinkSync(home, runs);
      else {
        mkdirSync(runs, { mode: bad === "permissive" ? 0o777 : 0o700 });
        if (bad === "permissive") chmodSync(runs, 0o777);
        if (bad === "stale") {
          mkdirSync(join(runs, task.id), { mode: 0o700 });
          mkdirSync(join(runs, task.id, "1"), { mode: 0o700 });
        }
      }
      await expect(runOwnedExecutorAttempt(ctx, { call: async () => { called = true; return {}; } },
        "fx-executor", task.id, "codex", home)).rejects.toBeInstanceOf(CoreError);
      expect(called).toBe(false);
      expect(readTask(ctx, task.id)?.run).toBeUndefined();
      if (bad === "stale") {
        expect(readTask(ctx, task.id)?.runClaim).toBeUndefined();
        await expect(runOwnedExecutorAttempt(ctx, { call: async () => { called = true; return {}; } },
          "fx-executor", task.id, "codex", home)).rejects.toMatchObject({ code: "conflict" });
        expect(called).toBe(false);
      }
    } finally { cleanup(); }
  }
});

test("host recovers only its journaled empty attempt directory after a pre-publication crash", async () => {
  const { home, ctx, task, cleanup } = fixture();
  const dir = join(ctx.pacerHome, "runs", task.id, "1");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    updateTask(ctx, task.id, current => {
      current.runClaim = { attempt: 1, providerId: "fx-executor", executor: "codex", workdir: home, dir };
    });
    let called = false;
    await runOwnedExecutorAttempt(ctx, { call: async () => {
      called = true;
      return { status: "done", exitCode: 0, report: "recovered" };
    } }, "fx-executor", task.id, "codex", home);
    expect(called).toBe(true);
    expect(readTask(ctx, task.id)?.run?.dir).toBe(dir);
    expect(readTask(ctx, task.id)?.runClaim).toBeUndefined();
  } finally { cleanup(); }
});

test("host refuses a journaled attempt directory containing an unbound process marker", async () => {
  const { home, ctx, task, cleanup } = fixture();
  const dir = join(ctx.pacerHome, "runs", task.id, "1");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "pid"), "42\n", { mode: 0o600 });
    updateTask(ctx, task.id, current => {
      current.runClaim = { attempt: 1, providerId: "fx-executor", executor: "codex", workdir: home, dir };
    });
    let called = false;
    await expect(runOwnedExecutorAttempt(ctx, { call: async () => {
      called = true;
      return { status: "done", exitCode: 0, report: "unsafe" };
    } }, "fx-executor", task.id, "codex", home)).rejects.toMatchObject({ code: "conflict" });
    expect(called).toBe(false);
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
  } finally { cleanup(); }
});

test("host rejects a stale result after another owner changes the active attempt", async () => {
  const { home, ctx, task, cleanup } = fixture();
  try {
    await expect(runOwnedExecutorAttempt(ctx, {
      call: async () => {
        updateTask(ctx, task.id, t => { t.state = "stopped"; });
        return { status: "done", exitCode: 0, report: "stale" };
      },
    }, "fx-executor", task.id, "codex", home)).rejects.toMatchObject({ code: "conflict" });
  } finally { cleanup(); }
});

test("host rejects a task-directory ancestor swap before persisting the attempt", async () => {
  const { home, ctx, task, cleanup } = fixture();
  const native = writeNative();
  const original = native.mkdirAt.bind(native);
  let called = false;
  const swapped = spyOn(native, "mkdirAt").mockImplementation((fd, name, mode) => {
    if (name === "1") {
      const taskDir = join(ctx.pacerHome, "runs", task.id);
      const moved = join(home, "moved-task");
      renameSync(taskDir, moved);
      symlinkSync(moved, taskDir);
    }
    return original(fd, name, mode);
  });
  try {
    await expect(runOwnedExecutorAttempt(ctx, { call: async () => { called = true; return {}; } },
      "fx-executor", task.id, "codex", home)).rejects.toMatchObject({ code: "conflict" });
    expect(called).toBe(false);
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
  } finally { swapped.mockRestore(); cleanup(); }
});

test("host rejects a completion after the run attempt or host owner changes", async () => {
  for (const change of ["attempt", "host"] as const) {
    const { home, ctx, task, cleanup } = fixture();
    try {
      await expect(runOwnedExecutorAttempt(ctx, {
        call: async () => {
          updateTask(ctx, task.id, t => { if (t.run) { if (change === "attempt") t.run.attempt = 99; else t.run.host = "remote"; } });
          return { status: "done", exitCode: 0, report: "stale" };
        },
      }, "fx-executor", task.id, "codex", home)).rejects.toMatchObject({ code: "conflict" });
    } finally { cleanup(); }
  }
});
