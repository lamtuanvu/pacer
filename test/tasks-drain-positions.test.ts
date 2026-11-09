import { expect, test } from "bun:test";
import { drainQueue } from "../src/tasks/drain";
import { readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { queueDeps, queueTask } from "./queue-helpers";

test("drainQueue leaves unchanged queue positions unwritten", async () => {
  const ctx = fakeCtx();
  const ids = [1, 2, 3].map(position => {
    const since = ctx.now - 10 + position;
    const task = queueTask({ ...ctx, now: since }, `waiting ${position}`, null);
    // A far-future retry keeps every task queued, so the drain only renumbers positions. The drain
    // compares retry times with the wall clock, not ctx.now.
    return updateTask(ctx, task.id, t => { t.queue = { reason: "waiting_retry", nextAt: Date.now() / 1000 + 30 * 86_400, since, position }; }).id;
  });
  const spawn = () => { throw new Error("nothing should launch"); };
  await drainQueue(ctx, spawn, queueDeps());
  const revs = ids.map(id => readTask(ctx, id)!.rev);
  await drainQueue(ctx, spawn, queueDeps());
  expect(ids.map(id => readTask(ctx, id)!.rev)).toEqual(revs);
  expect(ids.map(id => readTask(ctx, id)!.queue?.position)).toEqual([1, 2, 3]);
});
