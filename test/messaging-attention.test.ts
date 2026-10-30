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
    actions: [{ label: "Answer", op: "ui.open", params: { view: "task", id: t.id, tab: "answer" }, style: "primary" }] });
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

test("unread messages without a question only open the task", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "Fix login", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.origin = "human"; });
  store.insertMessage(ctx, { taskId: t.id, rootId: `task:${t.id}`, from: `task:${t.id}`, to: "human", kind: "message", body: "Done with step one", replyTo: null, requestId: null });
  const [api] = apiTasks(ctx, [readTask(ctx, t.id)!]);
  const item = deriveItems(input(ctx, [api!])).find(i => i.kind === "message");
  expect(item?.actions).toEqual([{ label: "Open task", op: "ui.open", params: { view: "task", id: t.id }, style: "primary" }]);
});

test("a reviewed task's question can only be opened, not answered", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "Fix login", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.origin = "human"; x.state = "done"; x.review = { accepted: true, at: ctx.now } as never; });
  store.insertMessage(ctx, { taskId: t.id, rootId: `task:${t.id}`, from: `task:${t.id}`, to: "human", kind: "question", body: "Which provider?", replyTo: null, requestId: null });
  const [api] = apiTasks(ctx, [readTask(ctx, t.id)!]);
  const item = deriveItems(input(ctx, [api!])).find(i => i.kind === "message");
  expect(item?.actions.map(a => a.label)).toEqual(["Open task"]);
});

test("msg.read publishes the task and clears its message attention, without bumping the task's rev", async () => {
  const { callOp } = await import("../src/api/ops");
  const { readOutboxSince } = await import("../src/link/store");
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "Fix login", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.origin = "human"; x.state = "done"; });
  const rev = readTask(ctx, t.id)!.rev;
  const m = store.insertMessage(ctx, { taskId: t.id, rootId: `task:${t.id}`, from: `task:${t.id}`, to: "human", kind: "question", body: "Which provider?", replyTo: null, requestId: null }).message;
  expect(await callOp(ctx, "msg.read", { ids: [m.id] }, { appAuthenticated: true })).toEqual({ read: 1 });
  let events: ReturnType<typeof readOutboxSince> = [];
  for (let i = 0; i < 40 && !events.length; i++) { await Bun.sleep(25); events = readOutboxSince(ctx, 0); }
  expect(events.map(e => e.envelope)).toEqual([
    { type: "task", data: expect.objectContaining({ id: t.id }) },
    { type: "entity", data: { kind: "attention", id: `message:${t.id}`, removed: true } },
  ]);
  expect(readTask(ctx, t.id)!.rev).toBe(rev);
  // Reading what was already read publishes nothing more.
  await callOp(ctx, "msg.read", { ids: [m.id] }, { appAuthenticated: true });
  await Bun.sleep(100);
  expect(readOutboxSince(ctx, 0)).toHaveLength(2);
});
