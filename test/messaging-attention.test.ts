import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, updateTask, readTask } from "../src/tasks/store";
import { apiTask, apiTasks } from "../src/api/read-model/tasks";
import * as store from "../src/messaging/store";
import { deriveItems, type RuleInput } from "../src/attention/rules";

const input = (ctx: { now: number }, tasks: RuleInput["tasks"]): RuleInput =>
  ({ now: ctx.now, tasks, executors: [], accounts: [], planner: null, setup: { complete: true, open: 0, items: [] }, update: null, retryTarget: () => null });

test("a question to the human surfaces as attention", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "Fix login", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.origin = "human"; x.state = "needs_input"; });
  store.insertMessage(ctx, { taskId: t.id, rootId: `task:${t.id}`, from: `task:${t.id}`, to: "human", kind: "question", body: "Which provider?", replyTo: null, requestId: null });
  const [api] = apiTasks(ctx, [readTask(ctx, t.id)!]);
  expect(api!.messages).toEqual({ unreadForHuman: 1, question: expect.objectContaining({ text: "Which provider?" }) });
  expect(apiTask(ctx, readTask(ctx, t.id)!).messages?.unreadForHuman).toBe(1);
  const item = deriveItems(input(ctx, [api!])).find(i => i.kind === "message");
  expect(item).toMatchObject({ id: `message:${t.id}`, detail: "Which provider?", severity: "blocked",
    actions: [{ label: "Reply", op: "ui.open", params: { view: "task", id: t.id }, style: "primary" }] });
});

test("a task without unread messages has no messages field or item", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "Fix login", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const [api] = apiTasks(ctx, [readTask(ctx, t.id)!]);
  expect(api!.messages).toBeUndefined();
  expect(deriveItems(input(ctx, [api!])).find(i => i.kind === "message")).toBeUndefined();
});

test("an unanswered task question raises only the question item", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "Fix login", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.origin = "human"; x.state = "needs_input"; x.question = { text: "Which provider?", at: ctx.now }; });
  store.insertMessage(ctx, { taskId: t.id, rootId: `task:${t.id}`, from: `task:${t.id}`, to: "human", kind: "question", body: "Which provider?", replyTo: null, requestId: null });
  const [api] = apiTasks(ctx, [readTask(ctx, t.id)!]);
  const items = deriveItems(input(ctx, [api!]));
  expect(items.filter(i => i.taskId === t.id).map(i => i.kind)).toEqual(["question"]);
});
