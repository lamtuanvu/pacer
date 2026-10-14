import { expect, test } from "bun:test";
import type { ApiClient } from "../src/api/client";
import { emptySnapshot, type LinkSnapshot, type TaskData } from "../src/link/envelope";
import { refreshView } from "../src/dashboard/data";

const task = (id: string, state = "running"): TaskData => ({ id, state, goal: id, executor: "codex", backend: "direct", worktree: null, updatedAt: 1 });
const snap = (tasks: TaskData[]): LinkSnapshot => ({ ...emptySnapshot(), seq: 1, tasks });
const fake = (s: LinkSnapshot): ApiClient => ({ kind: "inprocess", hello: async () => ({ protocol: "2.0.0", pacer: "0", ops: [], events: [] }), snapshot: async () => ({ protocol: "2.0.0", seq: s.seq, snapshot: s }), call: async () => { throw new Error("unused"); }, subscribe: () => () => {}, close: () => {} });

test("refresh keeps the selected card by id, else clamps", async () => {
  const before = snap([task("a"), task("b"), task("c")]);
  const reordered = snap([task("c"), task("b"), task("a")]);
  const r1 = await refreshView(fake(reordered), { snapshot: before, selected: 1, now: 10 });
  expect(r1.selected).toBe(1);
  expect(r1.snapshot).toBe(reordered);
  const r2 = await refreshView(fake(reordered), { snapshot: before, selected: 2, now: 10 });
  expect(r2.selected).toBe(0);
  const r3 = await refreshView(fake(snap([task("x")])), { snapshot: before, selected: 2, now: 10 });
  expect(r3.selected).toBe(0);
  const r4 = await refreshView(fake(snap([])), { snapshot: before, selected: 2, now: 10 });
  expect(r4.selected).toBe(0);
  const r5 = await refreshView(fake(reordered), { snapshot: before, selected: -1, now: 10 });
  expect(r5.selected).toBe(0);
});
