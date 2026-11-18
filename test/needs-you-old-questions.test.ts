import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { createTask, listActiveAndRecentTasks, updateTask } from "../src/tasks/store";
import { snapshotTasks } from "../src/api/read-model/tasks";
import { deriveItems, type RuleInput } from "../src/attention/rules";
import type { Ctx } from "../src/types";

function input(now: number, tasks: ReturnType<typeof snapshotTasks>): RuleInput {
  return { now, tasks, executors: [], accounts: [], planner: null, setup: { complete: true, open: 0, items: [] }, update: null, retryTarget: () => null };
}

function need(ctx: Ctx, now: number, patch: Record<string, unknown>) {
  const task = createTask({ ...ctx, now }, { brief: { goal: "pick a db", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask({ ...ctx, now }, task.id, t => Object.assign(t, { state: "needs_input", question: { text: "Which database?", answer: undefined, at: now }, ...patch }));
  return task.id;
}

test("an unanswered needs_input older than 24h stays in the active set, the snapshot, and raises a question item", () => {
  const ctx = fakeCtx();
  const old = ctx.now - 3 * 86400; // well outside the 24h recency window
  const openId = need(ctx, old, {});
  const answeredId = need(ctx, old, { question: { text: "Which database?", answer: "postgres", at: old } });
  const dismissedId = need(ctx, old, { dismissed: true });
  const retriedId = need(ctx, old, { retriedBy: "t-other" });

  // Root cause: the active selection keeps only the unanswered needs_input at any
  // age; one answered (via the retry path or directly), retried or dismissed
  // must not reappear as a live question.
  const activeIds = new Set(listActiveAndRecentTasks(ctx).map(t => t.id));
  expect(activeIds.has(openId), openId).toBe(true);
  for (const id of [answeredId, dismissedId, retriedId]) expect(activeIds.has(id), id).toBe(false);

  // The unanswered task appears in the snapshot tasks surface.
  const snap = snapshotTasks(ctx, listActiveAndRecentTasks(ctx));
  expect(snap.map(t => t.id)).toContain(openId);

  // Only the unanswered question raises a "question" item; answered/dismissed/retried do not.
  const items = deriveItems(input(ctx.now, snap));
  const raised = items.filter(i => i.kind === "question").map(i => i.taskId);
  expect(raised).toContain(openId);
  expect(raised).not.toContain(answeredId);
  expect(raised).not.toContain(dismissedId);
  expect(raised).not.toContain(retriedId);
});

test("an old open question is kept even when 205 newer tasks fill the snapshot cap", () => {
  const ctx = fakeCtx();
  const old = ctx.now - 3 * 86400;
  const openId = need(ctx, old, {});
  for (let i = 0; i < 205; i++) {
    const t = createTask(ctx, { brief: { goal: `newer ${i}`, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, t.id, row => { row.state = "done"; });
  }
  const snap = snapshotTasks(ctx, listActiveAndRecentTasks(ctx));
  // The old open question must survive the 200-row recent-window cap.
  expect(snap.map(t => t.id)).toContain(openId);
  expect(snap.length).toBeGreaterThan(200);
});

test("a recently updated (non-aged) needs_input keeps its existing behavior", () => {
  const ctx = fakeCtx();
  const id = need(ctx, ctx.now, {});
  const activeIds = new Set(listActiveAndRecentTasks(ctx).map(t => t.id));
  expect(activeIds.has(id)).toBe(true);
  const snap = snapshotTasks(ctx, listActiveAndRecentTasks(ctx));
  expect(deriveItems(input(ctx.now, snap)).some(i => i.taskId === id && i.kind === "question")).toBe(true);
});