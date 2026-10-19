import { expect, spyOn, test } from "bun:test";
import { taskStatus, taskWait, superviseTasks } from "../src/tasks/api";
import * as store from "../src/tasks/store";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

function setup() {
  const ctx = fakeCtx();
  const task = store.createTask(ctx, {brief: {goal: "g", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 60});
  const running = store.updateTask(ctx, task.id, t => {t.state = "running"; t.runnerPid = 999_999; t.attemptStartedAt = ctx.now;});
  return {ctx, task: running};
}

test("reading a dead runner leaves the task and revision unchanged", () => {
  const {ctx, task} = setup();
  expect(taskStatus(ctx, task.id)).toEqual(task);
  expect(store.readTask(ctx, task.id)).toEqual(task);
});

test("supervision queries active states and skips terminal tasks", async () => {
  const {ctx, task} = setup();
  const terminal = store.updateTask(ctx, task.id, t => {t.state = "failed";});
  const query = spyOn(store, "listTasksWhere");
  const kill = spyOn(process, "kill");
  try {
    await superviseTasks(ctx);
    expect(query).toHaveBeenCalledWith(ctx, {states: ["queued", "running"]});
    expect(kill).not.toHaveBeenCalled();
    expect(store.readTask(ctx, task.id)).toEqual(terminal);
  } finally {query.mockRestore(); kill.mockRestore();}
});

test("the supervisor settles a dead runner", async () => {
  const {ctx, task} = setup();
  await superviseTasks(ctx);
  expect(store.readTask(ctx, task.id)).toMatchObject({state: "failed", result: {report: "the pacer runner exited unexpectedly"}});
});

test("wait and CLI tasks settle without a service", async () => {
  const first = setup();
  expect((await taskWait(first.ctx, first.task.id, 0))?.state).toBe("failed");
  const waiting = setup();
  const waited = await main(["wait", waiting.task.id, "--timeout", "1", "--json"], waiting.ctx);
  expect(waited.code).toBe(0);
  expect(JSON.parse(waited.out)).toMatchObject({state: "failed"});
  for (const args of [[], ["id"]]) {
    const {ctx, task} = setup();
    const result = await main(["tasks", ...args.map(() => task.id), "--json"], ctx);
    expect(result.code).toBe(0);
    expect(store.readTask(ctx, task.id)?.state).toBe("failed");
  }
});
