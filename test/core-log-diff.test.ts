import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as tasks from "../src/core/tasks";
import { startRun, readRun } from "../src/supervisor/run";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";

const until = async (f: () => boolean) => { const end = Date.now() + 5000; while (!f()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(25); } };

test("log returns new output from offsets and reports done", async () => {
  const ctx = fakeCtx(), repo = tmpDir(), dir = join(ctx.pacerHome, "runs", "x", "1");
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  startRun({ dir, argv: ["sh", "-c", "echo one; sleep 0.4; echo two"], cwd: repo, env: { PATH: process.env.PATH } });
  updateTask(ctx, t.id, (x) => { x.state = "running"; x.run = { dir, attempt: 1, executor: "codex", startedAt: Date.now() / 1000, mode: "current", workdir: repo, logFile: "" }; });
  await until(() => readRun(dir).stdoutBytes > 0);
  const a = tasks.log(ctx, t.id);
  expect(a).toMatchObject({ stdout: "one\n", done: false });
  await until(() => readRun(dir).exit !== null);
  const b = tasks.log(ctx, t.id, a.next);
  expect(b).toMatchObject({ stdout: "two\n", stderr: "", done: true });
});

test("diff shows tracked changes against the base and lists untracked files", async () => {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo();
  writeFileSync(join(repo, "a.txt"), "1\n");
  Bun.spawnSync(["sh", "-c", "git add a.txt && git -c user.email=t@t -c user.name=t commit -q -m a"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "2\n"); writeFileSync(join(repo, "new.txt"), "n\n");
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const d = await tasks.diff(ctx, t.id);
  expect(d.diff).toContain("-1\n+2");
  expect(d.untracked).toEqual(["new.txt"]);
  expect(d.truncated).toBe(false);
});

test("log caps each stream by bytes and advances independent offsets", () => {
  const ctx = fakeCtx(), dir = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo: dir }, kind: null, requestedExecutor: null, timeoutS: 60 });
  writeFileSync(join(dir, "stdout"), "é" + "x".repeat(256 * 1024));
  writeFileSync(join(dir, "stderr"), "error\n");
  updateTask(ctx, t.id, (x) => { x.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: dir, logFile: "" }; });
  const a = tasks.log(ctx, t.id, { stderr: 2 });
  expect(Buffer.byteLength(a.stdout)).toBe(256 * 1024);
  expect(a).toMatchObject({ stderr: "ror\n", next: { stdout: 256 * 1024, stderr: 6 }, done: false });
  expect(tasks.log(ctx, t.id, a.next)).toMatchObject({ stdout: "xx", stderr: "", next: { stdout: 256 * 1024 + 2, stderr: 6 } });
  updateTask(ctx, t.id, (x) => { x.state = "stopped"; });
  expect(tasks.log(ctx, t.id).done).toBe(true);
});

test("log falls back to the last attempt and handles absent files", () => {
  const ctx = fakeCtx(), dir = tmpDir(), log = join(dir, "log");
  writeFileSync(log, "éabc");
  const t = createTask(ctx, { brief: { goal: "g", repo: dir }, kind: null, requestedExecutor: null, timeoutS: 60 });
  expect(tasks.log(ctx, t.id)).toEqual({ stdout: "", stderr: "", next: { stdout: 0, stderr: 0 }, done: false });
  updateTask(ctx, t.id, (x) => {
    x.state = "done";
    x.attempts.push({ executor: "codex", model: null, startedAt: ctx.now, endedAt: ctx.now, exitCode: 0, timedOut: false, limitHit: false, log });
  });
  expect(tasks.log(ctx, t.id, { stdout: 2 })).toEqual({ stdout: "abc", stderr: "", next: { stdout: 5, stderr: 0 }, done: true });
  expect(tasks.log(ctx, t.id, { stdout: 99 }).next.stdout).toBe(99);
});

test("log and diff report unknown tasks and diff reports git failure", async () => {
  const ctx = fakeCtx({ run: realRun });
  expect(() => tasks.log(ctx, "missing")).toThrow("unknown task missing");
  await expect(tasks.diff(ctx, "missing")).rejects.toMatchObject({ code: "unknown_task" });
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  await expect(tasks.diff(ctx, t.id)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("cannot diff:") });
});

test("diff includes commits against a pacer base and caps output at one MiB", async () => {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo();
  const base = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
  writeFileSync(join(repo, "large.txt"), "a".repeat(1024 * 1024 + 100));
  Bun.spawnSync(["sh", "-c", "git add large.txt && git -c user.email=t@t -c user.name=t commit -q -m large"], { cwd: repo });
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, (x) => { x.baseBranch = base; x.run = { dir: tmpDir(), attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new", workdir: repo, logFile: "" }; });
  const d = await tasks.diff(ctx, t.id);
  expect(d).toMatchObject({ base, worktree: repo, untracked: [], truncated: true });
  expect(Buffer.byteLength(d.diff)).toBe(1024 * 1024);
  expect(d.diff).toContain("new file mode");
});
