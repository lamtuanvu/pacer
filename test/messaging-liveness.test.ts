// test/messaging-liveness.test.ts
import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import * as store from "../src/messaging/store";
import * as live from "../src/messaging/liveness-store";
import { analyzeLiveness, buildSnapshot, type LivenessSnapshot, type SnapshotTask } from "../src/messaging/liveness";
import type { Message } from "../src/messaging/types";
import type { TaskRecord } from "../src/tasks/types";

test("liveness rows upsert, read and clear", () => {
  const ctx = fakeCtx();
  expect(live.getLiveness(ctx, "task:t-1")).toBeNull();
  live.upsertLiveness(ctx, { node: "task:t-1", reason: "undelivered", since: 10, attempts: 1, nextAt: 70, progressMark: "p1", stalledAt: null, escalatedAt: null });
  expect(live.getLiveness(ctx, "task:t-1")).toMatchObject({ reason: "undelivered", since: 10, attempts: 1, nextAt: 70, progressMark: "p1", hookBlocks: 0, hookSet: null });
  live.upsertLiveness(ctx, { node: "task:t-1", reason: "cycle", since: 10, attempts: 2, nextAt: 130, progressMark: "p1", stalledAt: 120, escalatedAt: null });
  expect(live.getLiveness(ctx, "task:t-1")).toMatchObject({ reason: "cycle", attempts: 2, stalledAt: 120 });
  live.upsertLiveness(ctx, { node: "human", reason: "unread_human", since: 5, attempts: 0, nextAt: 5, progressMark: null, stalledAt: null, escalatedAt: null });
  expect(live.listLiveness(ctx).map(r => r.node).sort()).toEqual(["human", "task:t-1"]);
  live.clearLiveness(ctx, "task:t-1");
  expect(live.getLiveness(ctx, "task:t-1")).toBeNull();
});

test("hook block count resets when the message set changes", () => {
  const ctx = fakeCtx();
  expect(live.recordHookBlock(ctx, "external:s1", "a,b")).toBe(1);
  expect(live.recordHookBlock(ctx, "external:s1", "a,b")).toBe(2);
  expect(live.recordHookBlock(ctx, "external:s1", "a,b,c")).toBe(1);
  // A stall upsert keeps the hook counters.
  const row = live.getLiveness(ctx, "external:s1")!;
  live.upsertLiveness(ctx, { ...row, reason: "unread_external", attempts: 1 });
  expect(live.recordHookBlock(ctx, "external:s1", "a,b,c")).toBe(2);
});

const NOW = 1_000_000;
let seq = 0;
function task(id: string, o: Partial<TaskRecord> = {}): TaskRecord {
  return { id, createdAt: NOW - 100, kind: null, requestedExecutor: null, timeoutS: 600, brief: { goal: "g" } as TaskRecord["brief"], state: "done", attempts: [], rev: 1, ...o } as TaskRecord;
}
function msg(from: string, to: string, o: Partial<Message> = {}): Message {
  seq++;
  return { id: `m-${String(seq).padStart(14, "0")}`, taskId: null, rootId: to, from, to, kind: "message", body: "x", replyTo: null, requestId: null,
    status: "pending", createdAt: NOW - 50, deliveredAt: null, readAt: null, turnId: null, ...o };
}
const node = (t: TaskRecord, o: Partial<SnapshotTask> = {}): SnapshotTask => ({ task: t, work: false, parent: "external:planner", depth: 1, ...o });
const snap = (o: Partial<LivenessSnapshot>): LivenessSnapshot => ({ tasks: [], unread: [], questions: [], retryDelivery: true, ...o });

test("a settled task with a pending message is undelivered", () => {
  const t = task("t-a");
  const stalls = analyzeLiveness(snap({ tasks: [node(t)], unread: [msg("external:planner", "task:t-a")] }), NOW);
  expect(stalls).toEqual([expect.objectContaining({ node: "task:t-a", reason: "undelivered" })]);
  // A queued turn or a running task is not stalled.
  expect(analyzeLiveness(snap({ tasks: [node(task("t-a", { pendingTurn: { id: "x", executor: "e", at: 1 } }))], unread: [msg("external:planner", "task:t-a")] }), NOW)).toEqual([]);
  expect(analyzeLiveness(snap({ tasks: [node(task("t-a", { state: "running" }))], unread: [msg("external:planner", "task:t-a")] }), NOW)).toEqual([]);
});

test("a running task whose progress is idle is idle_run", () => {
  const t = task("t-a", { state: "running", progress: { phase: "idle" } as TaskRecord["progress"] });
  expect(analyzeLiveness(snap({ tasks: [node(t)] }), NOW)).toEqual([expect.objectContaining({ node: "task:t-a", reason: "idle_run" })]);
});

test("a planner with an unread report is unread_external", () => {
  const t = task("t-a");
  const stalls = analyzeLiveness(snap({ tasks: [node(t)], unread: [msg("task:t-a", "external:planner", { kind: "report", status: "pending" })] }), NOW);
  expect(stalls).toEqual([{ node: "external:planner", reason: "unread_external", blocking: ["task:t-a"] }]);
});

test("a question to the human is unread_human", () => {
  const t = task("t-a", { state: "needs_input", question: { text: "?", at: NOW - 10 } });
  const q = msg("task:t-a", "human", { kind: "question", status: "delivered" });
  const stalls = analyzeLiveness(snap({ tasks: [node(t, { parent: "human" })], unread: [q], questions: [q] }), NOW);
  expect(stalls).toEqual([{ node: "human", reason: "unread_human", blocking: ["task:t-a"] }]);
  // A needs_input task blocks on its parent even without a message.
  expect(analyzeLiveness(snap({ tasks: [node(t, { parent: "human" })] }), NOW)).toEqual([{ node: "human", reason: "unread_human", blocking: ["task:t-a"] }]);
});

test("two launched tasks waiting on each other form a cycle with the deepest node", () => {
  const a = task("t-a"), b = task("t-b");
  const qa = msg("task:t-a", "task:t-b", { kind: "question", status: "delivered" });
  const qb = msg("task:t-b", "task:t-a", { kind: "question", status: "delivered" });
  const stalls = analyzeLiveness(snap({ tasks: [node(a, { depth: 1 }), node(b, { depth: 2 })], unread: [qa, qb], questions: [qa, qb] }), NOW);
  expect(stalls.map(s => s.node).sort()).toEqual(["task:t-a", "task:t-b"]);
  for (const s of stalls) expect(s).toMatchObject({ reason: "cycle", deepest: "task:t-b" });
  expect(stalls.find(s => s.node === "task:t-a")).toMatchObject({ waitingOn: "task:t-b", blocking: ["task:t-b"] });
});

test("a cycle of external and human participants has no deepest node", () => {
  const q1 = msg("external:a", "human", { kind: "question", status: "delivered" });
  const q2 = msg("human", "external:a", { kind: "question", status: "delivered" });
  const stalls = analyzeLiveness(snap({ unread: [q1, q2], questions: [q1, q2] }), NOW);
  expect(stalls.map(s => s.node).sort()).toEqual(["external:a", "human"]);
  for (const s of stalls) { expect(s.reason).toBe("cycle"); expect(s.deepest).toBeUndefined(); }
});

test("a closed task is ignored", () => {
  for (const closed of [{ review: { accepted: true, kind: null, note: null, at: 1 } }, { dismissed: true }, { msgClosed: true }, { state: "stopped" as const }]) {
    const t = task("t-a", closed);
    const stalls = analyzeLiveness(snap({ tasks: [node(t)], unread: [msg("external:planner", "task:t-a"), msg("task:t-a", "external:planner", { kind: "report" })] }), NOW);
    expect(stalls).toEqual([]);
  }
  // A task missing from the snapshot (closed or archived) is ignored too.
  expect(analyzeLiveness(snap({ unread: [msg("task:t-z", "external:planner", { kind: "report" })] }), NOW)).toEqual([]);
});

test("a work node is undelivered only when retry_delivery applies", () => {
  const t = task("t-w");
  const unread = [msg("task:t-p", "task:t-w")];
  const tasks = [node(t, { work: true, parent: "task:t-p", depth: 2 }), node(task("t-p", { state: "running" }))];
  expect(analyzeLiveness(snap({ tasks, unread, retryDelivery: true }), NOW)).toEqual([expect.objectContaining({ node: "task:t-w", reason: "undelivered" })]);
  expect(analyzeLiveness(snap({ tasks, unread, retryDelivery: false }), NOW)).toEqual([]);
});

test("buildSnapshot reads open tasks, unread messages and unanswered questions", () => {
  const ctx = fakeCtx();
  const mk = () => createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const a = mk(), closed = mk();
  updateTask(ctx, a.id, x => { x.origin = "external:planner"; x.state = "done"; });
  updateTask(ctx, closed.id, x => { x.state = "done"; x.dismissed = true; });
  const base = { taskId: a.id, rootId: `task:${a.id}`, body: "x", replyTo: null, requestId: null };
  const q = store.insertMessage(ctx, { ...base, from: `task:${a.id}`, to: "external:planner", kind: "question" }).message;
  const answered = store.insertMessage(ctx, { ...base, from: `task:${a.id}`, to: "external:planner", kind: "question" }).message;
  store.insertMessage(ctx, { ...base, from: "external:planner", to: `task:${a.id}`, kind: "answer", replyTo: answered.id });
  store.markRead(ctx, "external:planner", [answered.id]);
  const s = buildSnapshot(ctx);
  expect(s.tasks.map(n => [n.task.id, n.parent, n.depth, n.work])).toEqual([[a.id, "external:planner", 0, false]]);
  expect(s.questions.map(m => m.id)).toEqual([q.id]);
  expect(s.unread.map(m => m.kind).sort()).toEqual(["answer", "question"]);
  expect(s.retryDelivery).toBe(true);
});
