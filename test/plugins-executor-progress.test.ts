import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { applyExecutorProgress } from "../src/plugins/executor-progress";
import type { RunRef } from "../src/tasks/types";

const progress = { phase: "working", lastOutputAt: null, lastChangeAt: null,
  files: 1, commits: 0, logBytes: 12, host: "local", updatedAt: 42 } as const;
const run = (dir: string): RunRef => ({ dir, attempt: 1, executor: "codex", startedAt: 1,
  mode: "current", workdir: dir, logFile: `${dir}/log` });

test("host applies only bound attempt progress at the expected revision", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: ctx.home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const owner = run(`${ctx.pacerHome}/runs/${task.id}/1`);
  const running = updateTask(ctx, task.id, t => { t.state = "running"; t.run = owner; });
  const event = { kind: "progress", expectRev: running.rev, progress } as const;
  const changed = applyExecutorProgress(ctx, task.id, 1, event, owner);
  expect(changed.progress).toEqual(progress);
  expect(changed.rev).toBe(running.rev + 1);
  expect(() => applyExecutorProgress(ctx, task.id, 1, event, owner)).toThrow(/changed/);
  expect(() => applyExecutorProgress(ctx, task.id, 2, { ...event, expectRev: changed.rev }, owner)).toThrow(/attempt/);
  expect(readTask(ctx, task.id)?.progress).toEqual(progress);
});

test("progress cannot mutate a settled task or smuggle task fields", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: ctx.home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const owner = run(`${ctx.pacerHome}/runs/${task.id}/1`);
  expect(() => applyExecutorProgress(ctx, task.id, 1, { kind: "progress", expectRev: task.rev, progress }, owner)).toThrow(/running/);
  const running = updateTask(ctx, task.id, t => { t.state = "running"; });
  expect(() => applyExecutorProgress(ctx, task.id, 1,
    { kind: "progress", expectRev: running.rev, progress, state: "done" }, owner)).toThrow(/invalid/);
  expect(readTask(ctx, task.id)?.state).toBe("running");
});

test("progress requires the matching persisted run and rejects a replaced or foreign owner", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "fixture", repo: ctx.home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const owner = run(`${ctx.pacerHome}/runs/${task.id}/1`);
  const running = updateTask(ctx, task.id, t => { t.state = "running"; });
  const event = { kind: "progress", expectRev: running.rev, progress } as const;
  expect(() => applyExecutorProgress(ctx, task.id, 1, event, owner)).toThrow(/run/);
  const active = updateTask(ctx, task.id, t => { t.run = owner; });
  expect(() => applyExecutorProgress(ctx, task.id, 1, { ...event, expectRev: active.rev },
    { ...owner, executor: "foreign" })).toThrow(/run/);
  const replaced = updateTask(ctx, task.id, t => { t.run = { ...owner, dir: `${owner.dir}-replacement` }; });
  expect(() => applyExecutorProgress(ctx, task.id, 1, { ...event, expectRev: replaced.rev }, owner)).toThrow(/run/);
  expect(readTask(ctx, task.id)?.progress).toBeUndefined();
});
