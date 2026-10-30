import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { eventsSince } from "../src/api/events";
import { apiTasks } from "../src/api/read-model/tasks";
import { readOutboxSince } from "../src/link/store";
import { taskMessageEvents } from "../src/messaging/publish";
import * as store from "../src/messaging/store";
import { notifyMessage } from "../src/messaging/turns";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { emptySnapshot } from "../src/link/envelope";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { initialState, reduceStore, type StoreState } from "../app/src/data/store";
import { homeModel } from "../app/src/model/home";

/** A task that asked the human a question, and the app session that loaded it. */
async function asked() {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "Fix login", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.origin = "human"; x.state = "done"; });
  const q = store.insertMessage(ctx, { taskId: t.id, rootId: `task:${t.id}`, from: `task:${t.id}`, to: "human", kind: "question", body: "Which provider?", replyTo: null, requestId: null }).message;
  await notifyMessage(ctx, q);
  const item = taskMessageEvents(ctx, t.id).flatMap(e => e.type === "entity" && e.data.value ? [e.data.value] : [])[0];
  const seq = eventsSince(ctx, 0, 3).last;
  const snapshot = { ...emptySnapshot(), seq, tasks: apiTasks(ctx, [readTask(ctx, t.id)!]), attention: [item] } as unknown as ClientSnapshot;
  let state: StoreState = reduceStore(initialState(), { type: "hello", hello: { protocol: "3.0.0", pacer: "0", ops: [], events: ["task", "attention"] } as never });
  state = reduceStore(state, { type: "snapshot", snapshot });
  return { ctx, t, q, state, seq };
}
const apply = (state: StoreState, ctx: ReturnType<typeof fakeCtx>, since: number) =>
  eventsSince(ctx, since, 3).events.reduce((s, event) => reduceStore(s, { type: "event", event: event as never }), state);
/** Publication runs after the op returns; wait for the outbox to settle. */
async function settled(ctx: ReturnType<typeof fakeCtx>) {
  for (let i = 0, n = -1; i < 40; i++) { const now = readOutboxSince(ctx, 0).length; if (now === n) return; n = now; await Bun.sleep(50); }
}

test("the asked task's session shows the question waiting on the human", async () => {
  const { state } = await asked();
  const home = homeModel(state.snapshot!, []);
  expect(home.attention.map(a => [a.label, a.href])).toEqual([["Waiting on you", expect.stringContaining("?tab=answer")]]);
});

test("an answer clears the attention item and the task's question in the same session, without a reload", async () => {
  const { ctx, t, q, state, seq } = await asked();
  const rev = readTask(ctx, t.id)!.rev;
  await callOp(ctx, "msg.send", { to: `task:${t.id}`, kind: "answer", reply_to: q.id, body: "Stripe", request_id: "r-1" }, { appAuthenticated: true, spawnRunner: () => 1 });
  await settled(ctx);
  const next = apply(state, ctx, seq);
  expect(next.needsSnapshot).toBe(false);
  expect(next.snapshot!.attention).toEqual([]);
  expect(next.snapshot!.tasks.find(x => x.id === t.id)?.messages).toBeUndefined();
  expect(homeModel(next.snapshot!, []).attention).toEqual([]);
  // Only the task question's answer is written; the cleared item is published, not written.
  expect(readTask(ctx, t.id)!.rev - rev).toBeLessThanOrEqual(1);
});

test("a new question reaches an open session as a task update and an attention item", async () => {
  const { ctx, t, state, seq } = await asked();
  store.markRead(ctx, "human", store.inbox(ctx, "human").map(m => m.id));
  const cleared = apply(state, ctx, seq);
  const m = store.insertMessage(ctx, { taskId: t.id, rootId: `task:${t.id}`, from: `task:${t.id}`, to: "human", kind: "question", body: "Which region?", replyTo: null, requestId: null }).message;
  await notifyMessage(ctx, m);
  const next = apply(cleared, ctx, cleared.snapshot!.seq);
  expect(next.snapshot!.tasks.find(x => x.id === t.id)?.messages?.question?.text).toBe("Which region?");
  expect(next.snapshot!.attention?.map(a => [a.id, a.detail])).toEqual([[`message:${t.id}`, "Which region?"]]);
});
