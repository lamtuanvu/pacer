// test/messaging-liveness.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  live.upsertLiveness(ctx, { node: "task:t-1", reason: "undelivered", since: 10, attempts: 1, nudges: 0, nextAt: 70, progressMark: "p1", stalledAt: null, escalatedAt: null });
  expect(live.getLiveness(ctx, "task:t-1")).toMatchObject({ reason: "undelivered", since: 10, attempts: 1, nextAt: 70, progressMark: "p1", hookBlocks: 0, hookSet: null });
  live.upsertLiveness(ctx, { node: "task:t-1", reason: "cycle", since: 10, attempts: 2, nudges: 1, nextAt: 130, progressMark: "p1", stalledAt: 120, escalatedAt: null });
  expect(live.getLiveness(ctx, "task:t-1")).toMatchObject({ reason: "cycle", attempts: 2, stalledAt: 120 });
  live.upsertLiveness(ctx, { node: "human", reason: "unread_human", since: 5, attempts: 0, nudges: 0, nextAt: 5, progressMark: null, stalledAt: null, escalatedAt: null });
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
const node = (t: TaskRecord, o: Partial<SnapshotTask> = {}): SnapshotTask => ({ task: t, work: false, parent: "external:planner", depth: 1, lastProgressAt: NOW, ...o });
const snap = (o: Partial<LivenessSnapshot>): LivenessSnapshot => ({ tasks: [], unread: [], questions: [], retryDelivery: true, noProgressS: 1800, idleAfterS: 600, ...o });

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

test("a settled task owes its caller a decision", () => {
  const owed = task("t-a", { origin: "external:planner" });
  expect(analyzeLiveness(snap({ tasks: [node(owed)] }), NOW))
    .toEqual([{ node: "external:planner", reason: "caller_decision", blocking: ["task:t-a"] }]);

  // A running task, a retried task and a caller that already wrote owe nothing yet.
  expect(analyzeLiveness(snap({ tasks: [node(task("t-a", { origin: "external:planner", state: "running" }))] }), NOW)).toEqual([]);
  expect(analyzeLiveness(snap({ tasks: [node(task("t-a", { origin: "external:planner", retriedBy: "t-b" }))] }), NOW)).toEqual([]);
  expect(analyzeLiveness(snap({ tasks: [node(owed)], unread: [msg("external:planner", "task:t-a")] }), NOW))
    .toEqual([expect.objectContaining({ node: "task:t-a", reason: "undelivered" })]);
  // A verdict or a dismissal closes the task before the analysis ever sees it.
  expect(analyzeLiveness(snap({ tasks: [node(task("t-a", { origin: "external:planner", review: { accepted: true, kind: null, note: null, at: 1 } }))] }), NOW)).toEqual([]);
  expect(analyzeLiveness(snap({ tasks: [node(task("t-a", { origin: "external:planner", dismissed: true }))] }), NOW)).toEqual([]);
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

const working = (phase: string, o: Partial<TaskRecord> = {}) =>
  task("t-a", { state: "running", progress: { phase, lastOutputAt: NOW - 5, lastChangeAt: NOW - 3600, gitObserved: true } as TaskRecord["progress"], ...o });
const stale = (t: TaskRecord) => analyzeLiveness(snap({ tasks: [node(t, { lastProgressAt: NOW - 7200 })] }), NOW);

test("a running task with output but no progress for 30 min is no_progress", () => {
  expect(analyzeLiveness(snap({ tasks: [node(working("working"), { lastProgressAt: NOW - 1800 })] }), NOW))
    .toEqual([expect.objectContaining({ node: "task:t-a", reason: "no_progress" })]);
  expect(analyzeLiveness(snap({ tasks: [node(working("working"), { lastProgressAt: NOW - 1799 })] }), NOW)).toEqual([]);
  // The configured window applies, and idle_run keeps precedence.
  expect(analyzeLiveness(snap({ tasks: [node(working("working"), { lastProgressAt: NOW - 1800 })], noProgressS: 3600 }), NOW)).toEqual([]);
  expect(analyzeLiveness(snap({ tasks: [node(working("idle"), { lastProgressAt: NOW - 7200 })] }), NOW))
    .toEqual([expect.objectContaining({ reason: "idle_run" })]);
});

test("a driving or needs-input task is never no_progress", () => {
  for (const phase of ["driving", "needs-input"]) {
    // Fresh silentSince keeps needs-input out of silent_prompt; driving stays exempt entirely.
    expect(analyzeLiveness(snap({ tasks: [node(working(phase), { lastProgressAt: NOW - 7200, silentSince: NOW - 5 })] }), NOW)).toEqual([]);
  }
  // A settled task is not a run.
  expect(analyzeLiveness(snap({ tasks: [node(working("working", { state: "done" }), { lastProgressAt: NOW - 7200 })] }), NOW)).toEqual([]);
});

test("a needs-input run with no open question becomes silent_prompt after idle_after_min", () => {
  const stalled = working("needs-input", {
    attemptStartedAt: NOW - 700,
    progress: { phase: "needs-input", lastOutputAt: NOW - 600, lastChangeAt: NOW - 3600, gitObserved: true } as TaskRecord["progress"],
  });
  expect(analyzeLiveness(snap({ tasks: [node(stalled, { silentSince: NOW - 600 })] }), NOW))
    .toEqual([expect.objectContaining({ node: "task:t-a", reason: "silent_prompt" })]);
  // Still inside the idle window.
  expect(analyzeLiveness(snap({ tasks: [node(working("needs-input"), { silentSince: NOW - 5 })] }), NOW)).toEqual([]);
  // An open task.question or question message means someone owes an answer.
  const withQuestion = working("needs-input", {
    question: { text: "which?", at: NOW - 700 },
    progress: { phase: "needs-input", lastOutputAt: NOW - 700, lastChangeAt: NOW - 3600, gitObserved: true } as TaskRecord["progress"],
  });
  expect(analyzeLiveness(snap({ tasks: [node(withQuestion, { silentSince: NOW - 700 })] }), NOW)).toEqual([]);
  const q = msg("task:t-a", "external:planner", { kind: "question", status: "delivered" });
  expect(analyzeLiveness(snap({
    tasks: [node(working("needs-input", { progress: { phase: "needs-input", lastOutputAt: NOW - 700, lastChangeAt: NOW - 3600, gitObserved: true } as TaskRecord["progress"] }), { silentSince: NOW - 700 })],
    questions: [q],
  }), NOW)).toEqual([]);
});

test("a conversation task at its prompt is never silent_prompt", () => {
  for (const activity of ["waiting", "idle"] as const) {
    const atPrompt = working("needs-input", {
      interactionMode: "conversation",
      conversation: { activity },
      attemptStartedAt: NOW - 700,
      progress: { phase: "needs-input", lastOutputAt: NOW - 700, lastChangeAt: NOW - 3600, gitObserved: true } as TaskRecord["progress"],
    });
    expect(analyzeLiveness(snap({ tasks: [node(atPrompt, { silentSince: NOW - 700 })] }), NOW)).toEqual([]);
    const waiting = working("working", {
      interactionMode: "conversation",
      conversation: { activity },
      progress: { phase: "working", lastOutputAt: NOW - 700, lastChangeAt: NOW - 3600, gitObserved: true } as TaskRecord["progress"],
    });
    expect(analyzeLiveness(snap({ tasks: [node(waiting)] }), NOW)).toEqual([]);
  }
});

test("silent_prompt timer is not reset by a later lastOutputAt (terminal redraw)", () => {
  // Viewer attach / spinner moves lastOutputAt while phase stays needs-input; silentSince stays put.
  const t = working("needs-input", {
    attemptStartedAt: NOW - 700,
    progress: { phase: "needs-input", lastOutputAt: NOW - 1, lastChangeAt: NOW - 3600, gitObserved: true } as TaskRecord["progress"],
  });
  expect(analyzeLiveness(snap({ tasks: [node(t, { silentSince: NOW - 700 })] }), NOW))
    .toEqual([expect.objectContaining({ node: "task:t-a", reason: "silent_prompt" })]);
  expect(analyzeLiveness(snap({ tasks: [node(t, { silentSince: NOW - 100 })] }), NOW)).toEqual([]);
});

test("a human-controlled or testing run is never silent_prompt", () => {
  const base = { phase: "needs-input" as const, lastOutputAt: NOW - 700, lastChangeAt: NOW - 3600, gitObserved: true };
  expect(analyzeLiveness(snap({ tasks: [node(working("needs-input", { progress: { ...base, controlled: true } as TaskRecord["progress"] }), { silentSince: NOW - 700 })] }), NOW)).toEqual([]);
  expect(analyzeLiveness(snap({ tasks: [node(working("testing", { progress: { ...base, phase: "testing" } as TaskRecord["progress"] }), { silentSince: NOW - 700 })] }), NOW)).toEqual([]);
  expect(analyzeLiveness(snap({ tasks: [node(working("driving", { progress: { ...base, phase: "driving" } as TaskRecord["progress"] }), { silentSince: NOW - 700 })] }), NOW)).toEqual([]);
});

test("a task in pacer's acceptance testing phase is never no_progress", () => {
  expect(analyzeLiveness(snap({ tasks: [node(working("testing"), { lastProgressAt: NOW - 7200 })] }), NOW)).toEqual([]);
  // A run stuck starting is still flagged.
  expect(analyzeLiveness(snap({ tasks: [node(working("starting"), { lastProgressAt: NOW - 7200 })] }), NOW))
    .toEqual([expect.objectContaining({ reason: "no_progress" })]);
});

test("a conversation waiting for its user is never no_progress", () => {
  for (const activity of ["idle", "waiting"] as const) expect(stale(working("working", { conversation: { activity } }))).toEqual([]);
  // A conversation whose agent is working (for example a provider retry loop) is still covered.
  expect(stale(working("working", { conversation: { activity: "working" } }))).toEqual([expect.objectContaining({ reason: "no_progress" })]);
});

test("a run without a git progress signal is never no_progress", () => {
  // Remote-host runs and runs whose worktree git cannot be read have no way to show file changes or commits.
  expect(stale(working("working", { progress: { phase: "working", lastOutputAt: NOW - 5, lastChangeAt: null, host: "devbox" } as TaskRecord["progress"] }))).toEqual([]);
  expect(stale(working("working", { progress: { phase: "working", lastOutputAt: NOW - 5, lastChangeAt: null, gitObserved: true } as TaskRecord["progress"] })))
    .toEqual([expect.objectContaining({ reason: "no_progress" })]);
});

test("a human typing in the run's terminal is never no_progress", () => {
  expect(stale(working("working", { progress: { phase: "working", lastOutputAt: NOW - 5, lastChangeAt: null, gitObserved: true, controlled: true } as TaskRecord["progress"] }))).toEqual([]);
});

test("the default no-progress window stays after idle_after_min", () => {
  const ctx = fakeCtx({ now: NOW });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nexecution:\n  idle_after_min: 40\n  idle_fail_min: 50\n");
  expect(buildSnapshot(ctx).noProgressS).toBe(40 * 60 + 60);
});

test("an outgoing message counts as progress", () => {
  const ctx = fakeCtx({ now: NOW });
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, t.id, x => {
    x.state = "running"; x.origin = "external:planner"; x.attemptStartedAt = NOW - 3600;
    x.progress = { phase: "working", lastOutputAt: NOW - 5, lastChangeAt: NOW - 3000, gitObserved: true } as typeof x.progress;
  });
  const from = `task:${t.id}`;
  const base = { taskId: t.id, rootId: from, from, to: "external:planner", body: "x", replyTo: null, requestId: null };
  // A nudge is not progress.
  store.insertMessage({ ...ctx, now: NOW - 600 }, { ...base, kind: "nudge" });
  let s = buildSnapshot(ctx);
  expect(s.noProgressS).toBe(1800);
  expect(s.tasks[0]!.lastProgressAt).toBe(NOW - 3000);
  expect(analyzeLiveness(s, NOW).filter(x => x.node === from)).toEqual([expect.objectContaining({ reason: "no_progress" })]);
  store.insertMessage({ ...ctx, now: NOW - 300 }, { ...base, kind: "message" });
  s = buildSnapshot(ctx);
  expect(s.tasks[0]!.lastProgressAt).toBe(NOW - 300);
  expect(analyzeLiveness(s, NOW).filter(x => x.node === from)).toEqual([]);
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

test("a human-origin task does not raise caller_decision", () => {
  // A human already gets the task's own review item; only planner callers are woken.
  expect(analyzeLiveness(snap({ tasks: [node(task("t-a", { origin: "human" }), { parent: "human" })] }), NOW)).toEqual([]);
});

test("a task handed to the human does not owe the caller a decision", () => {
  const handed = task("t-a", { origin: "external:planner", reviewRequest: { note: "please look", at: 1 } } as never);
  const resolved = task("t-b", { origin: "external:planner", resolved: "human" } as never);
  expect(analyzeLiveness(snap({ tasks: [node(handed), node(resolved)] }), NOW)).toEqual([]);
});
