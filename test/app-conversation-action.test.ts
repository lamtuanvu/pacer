import { expect, test } from "bun:test";
import { changeConversation } from "../app/src/model/conversation";
import { callOp } from "../src/api/ops";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

test("ending a conversation reads its current revision after background progress changes", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Explain", repo: ctx.home}, kind: null, requestedExecutor: "codex", timeoutS: 0, interactionMode: "conversation"});
  updateTask(ctx, task.id, t => {t.state = "running"; t.conversation = {activity: "idle"};});
  const api = {call: <T>(op: string, params: unknown) => callOp(ctx, op, params) as Promise<T>};
  await changeConversation(api, task.id, "end");
  expect(readTask(ctx, task.id)).toMatchObject({state: "stopped", conversation: {activity: "ended", endReason: "user"}});
});
