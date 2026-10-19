import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fakeCtx } from "./helpers";
import { createTask, listTasks, listTasksWhere, readTask, tasksDir, updateTask } from "../src/tasks/store";
import { eligibleForRetention, pruneTasks, restoreTask, retentionScheduler } from "../src/tasks/retention";
import { TERMINAL_STATES, type TaskRecord } from "../src/tasks/types";

function fixture() {
  const ctx = fakeCtx();
  const old = { ...ctx, now: ctx.now - 30 * 86400 };
  const task = createTask(old, { brief: { goal: "retention", repo: join(ctx.home, "repo") }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(old, task.id, t => { t.state = "done"; t.dismissed = true; });
  return { ctx, task: readTask(ctx, task.id)! };
}

test("retention eligibility requires old terminal reviewed/dismissed tasks with no live worktree", () => {
  const { ctx, task } = fixture();
  for (const state of ["queued", "running", ...TERMINAL_STATES] as TaskRecord["state"][]) {
    expect(eligibleForRetention(ctx, { ...task, state }, 14)).toBe(TERMINAL_STATES.includes(state));
    expect(eligibleForRetention(ctx, { ...task, state, dismissed: false }, 14)).toBe(false);
  }
  expect(eligibleForRetention(ctx, task, 0)).toBe(false);
  expect(eligibleForRetention(ctx, { ...task, createdAt: ctx.now }, 14)).toBe(false);
  expect(eligibleForRetention(ctx, { ...task, review: { accepted: true, kind: null, note: null, at: ctx.now } }, 14)).toBe(false);
  const wt = join(ctx.home, "worktree"); mkdirSync(wt);
  expect(eligibleForRetention(ctx, { ...task, worktree: wt }, 14)).toBe(false);
});

test("dry run is unchanged; archive/list/restore preserve log bytes and private modes", async () => {
  const { ctx, task } = fixture();
  const log = join(tasksDir(ctx), `${task.id}.log`), md = join(tasksDir(ctx), `${task.id}.brief.md`);
  const bytes = Buffer.from("hello\0world\n".repeat(10000));
  writeFileSync(log, bytes); writeFileSync(md, "brief");
  const bundle = join(tasksDir(ctx), `${task.id}.bundle`);
  writeFileSync(bundle, Buffer.from([0, 1, 2, 255]));
  const before = readdirSync(tasksDir(ctx));
  const dry = await pruneTasks(ctx, { days: 14, dryRun: true });
  expect(dry.tasks[0]?.id).toBe(task.id); expect(dry.bytesSaved).toBeGreaterThan(0);
  expect(readdirSync(tasksDir(ctx))).toEqual(before); expect(readTask(ctx, task.id)?.archived).toBeUndefined();
  expect(existsSync(join(ctx.pacerHome, "archive"))).toBe(false);
  await pruneTasks(ctx, { days: 14 });
  const archived = readTask(ctx, task.id)!;
  expect(archived.archived).toBe(true); expect(listTasks(ctx)).toEqual([]);
  expect(listTasksWhere(ctx, { all: true }).map(t => t.id)).toEqual([task.id]);
  expect(gunzipSync(readFileSync(join(archived.archivePath!, `${task.id}.log.gz`)))).toEqual(bytes);
  expect(statSync(archived.archivePath!).mode & 0o777).toBe(0o700);
  expect(statSync(join(archived.archivePath!, `${task.id}.log.gz`)).mode & 0o777).toBe(0o600);
  expect(existsSync(log)).toBe(false); expect(existsSync(join(tasksDir(ctx), `${task.id}.json`))).toBe(false);
  writeFileSync(join(archived.archivePath!, "keep.txt"), "keep me");
  await restoreTask(ctx, task.id);
  expect(readFileSync(join(archived.archivePath!, "keep.txt"), "utf8")).toBe("keep me");
  expect(readFileSync(log)).toEqual(bytes); expect(readFileSync(md, "utf8")).toBe("brief");
  expect(listTasks(ctx).map(t => t.id)).toEqual([task.id]);
  expect(readFileSync(bundle)).toEqual(Buffer.from([0, 1, 2, 255]));
  expect(JSON.parse(readFileSync(join(tasksDir(ctx), `${task.id}.json`), "utf8")).archived).toBeUndefined();
});

test("scheduler is single-flight and runs at most daily", async () => {
  const { ctx } = fixture(); let calls = 0, finish!: () => void;
  const scheduler = retentionScheduler(async () => { calls++; await new Promise<void>(r => { finish = r; }); });
  const first = scheduler.tick(ctx); await Promise.resolve();
  const duplicate = scheduler.tick(ctx); expect(calls).toBe(1); finish(); await first; await duplicate;
  await scheduler.tick(ctx); expect(calls).toBe(1);
  const next = scheduler.tick({ ...ctx, now: ctx.now + 86400 }); await Promise.resolve();
  expect(calls).toBe(2); finish(); await next;
});

test("archive keeps unrelated files, rechecks revisions, and refuses restore collisions", async () => {
  const { ctx, task } = fixture();
  const log = join(tasksDir(ctx), `${task.id}.log`);
  writeFileSync(log, "original");
  const unrelated = join(tasksDir(ctx), `${task.id}-other.log`);
  writeFileSync(unrelated, "unrelated");
  await pruneTasks(ctx, { days: 14 });
  expect(readFileSync(unrelated, "utf8")).toBe("unrelated");
  // Updates to archived records keep their compatibility copy in the archive.
  updateTask(ctx, task.id, t => { t.title = "updated"; });
  expect(existsSync(join(tasksDir(ctx), `${task.id}.json`))).toBe(false);
  writeFileSync(log, "new content");
  await expect(restoreTask(ctx, task.id)).rejects.toMatchObject({ code: "conflict" });
  expect(readFileSync(log, "utf8")).toBe("new content");
  expect(readTask(ctx, task.id)?.archived).toBe(true);
  unlinkSync(log); symlinkSync(join(ctx.home, "missing-target"), log);
  await expect(restoreTask(ctx, task.id)).rejects.toMatchObject({ code: "conflict" });
});

test("eligibility keeps unknown settlement, boundary, remote and result worktrees", () => {
  const { ctx, task } = fixture();
  expect(eligibleForRetention(ctx, { ...task, settledAt: undefined }, 14)).toBe(false);
  expect(eligibleForRetention(ctx, { ...task, settledAt: ctx.now - 14 * 86400 }, 14)).toBe(false);
  expect(eligibleForRetention(ctx, { ...task, review: { at: task.createdAt, accepted: false, note: null, kind: null }, dismissed: false }, 14)).toBe(true);
  const run = { dir: "absent", workdir: "absent", logFile: "absent", executor: "codex", attempt: 1, startedAt: task.createdAt, mode: "new" as const, remoteWorktree: "/remote/checkout" };
  expect(eligibleForRetention(ctx, { ...task, run }, 14)).toBe(false);
  expect(eligibleForRetention(ctx, { ...task, run: { ...run, remoteWorktree: undefined, workdir: ctx.home } }, 14)).toBe(false);
  expect(eligibleForRetention(ctx, { ...task, result: { status: "done", executor: null, model: null, report: "", files: "", backend: "direct", worktree: ctx.home } }, 14)).toBe(false);
});

test("API lists and snapshots exclude archived records, explicit all and ID get retain metadata", async () => {
  const { ctx, task } = fixture();
  const { callOp } = await import("../src/api/ops");
  const { snapshotTasks } = await import("../src/api/read-model/tasks");
  await callOp(ctx, "task.prune", {});
  const normal = await callOp(ctx, "task.list", {}) as { tasks: unknown[] };
  expect(normal.tasks).toEqual([]);
  const all = await callOp(ctx, "task.list", { all: true }) as { tasks: { archived: boolean; archivePath: string }[] };
  expect(all.tasks[0]?.archived).toBe(true);
  expect(snapshotTasks(ctx, [readTask(ctx, task.id)!])).toEqual([]);
  const detail = await callOp(ctx, "task.get", { id: task.id }) as { archived: boolean; archivePath: string };
  expect(detail.archived).toBe(true); expect(detail.archivePath).toBe(all.tasks[0]!.archivePath);
  await callOp(ctx, "task.restore", { id: task.id });
  expect(listTasks(ctx).length).toBe(1);
});

test("setting defaults to fourteen, validates whole days, and zero disables prune", async () => {
  const { ctx, task } = fixture();
  const { retentionDays } = await import("../src/tasks/retention");
  const { validateStrategy } = await import("../src/config/strategy");
  const base = { planner: "claude-code", providers: { codex: {} } };
  expect(validateStrategy(base, "test").taskRetentionDays).toBe(14);
  expect(validateStrategy({ ...base, task_retention_days: 0 }, "test").taskRetentionDays).toBe(0);
  for (const value of [-1, 1.5, "14"]) expect(() => validateStrategy({ ...base, task_retention_days: value }, "test")).toThrow("task_retention_days");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), Bun.YAML.stringify({ ...base, task_retention_days: 0 }));
  expect(retentionDays(ctx)).toBe(0);
  expect((await pruneTasks(ctx)).tasks).toEqual([]);
  expect(readTask(ctx, task.id)?.archived).toBeUndefined();
});

test("concurrent administrative operations return conflict; changed revisions stay untouched", async () => {
  const { ctx, task } = fixture();
  const { withLock } = await import("../src/core/lock");
  let release!: () => void;
  const locked = withLock(ctx, "task-retention", async () => { await new Promise<void>(r => { release = r; }); });
  await expect(pruneTasks(ctx, { days: 14 })).rejects.toMatchObject({ code: "conflict" });
  release(); await locked;
  const log = join(tasksDir(ctx), `${task.id}.log`);
  writeFileSync(log, "x".repeat(100000));
  const prune = pruneTasks(ctx, { days: 14 });
  // Compression starts asynchronously; a user change after selection must veto it.
  updateTask(ctx, task.id, t => { t.dismissed = false; });
  await prune;
  expect(readTask(ctx, task.id)?.archived).toBeUndefined();
  expect(readFileSync(log, "utf8").length).toBe(100000);
});

test("config operations expose retention and validate updates", async () => {
  const { ctx } = fixture();
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {}\n");
  const config = await import("../src/core/config");
  const initial = config.get(ctx) as { keys: Record<string, { value: unknown }> };
  expect(initial.keys.task_retention_days?.value).toBe(14);
  await config.set(ctx, "task_retention_days", 0);
  expect((config.get(ctx) as typeof initial).keys.task_retention_days?.value).toBe(0);
  await expect(config.set(ctx, "task_retention_days", -1)).rejects.toMatchObject({ code: "invalid_input" });
});

test("retention waits for a task lock without blocking the event loop", async () => {
  const { ctx, task } = fixture();
  const { withLock } = await import("../src/core/lock");
  let release!: () => void;
  const locked = withLock(ctx, `task-${task.id}`, async () => { await new Promise<void>(r => { release = r; }); });
  const pruning = pruneTasks(ctx, { days: 14 });
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  expect(readTask(ctx, task.id)?.archived).toBeUndefined();
  release(); await locked; await pruning;
  expect(readTask(ctx, task.id)?.archived).toBe(true);
});

test("service starts an asynchronous retention sweep and keeps health available", async () => {
  const { ctx, task } = fixture();
  const { startServer } = await import("../src/serve/http");
  const server = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  try {
    const deadline = Date.now() + 3000;
    while (!readTask(ctx, task.id)?.archived) {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(response.status).toBe(200);
      expect((await response.json() as { ok: boolean }).ok).toBe(true);
      if (Date.now() > deadline) throw new Error("startup sweep did not archive task");
      await Bun.sleep(10);
    }
    // Let the bounded-page sweep finish before disposing its home.
    await Bun.sleep(20);
  } finally { server.stop(); }
});
