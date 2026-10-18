import { expect, test } from "bun:test";
import type { AttentionItem } from "../src/api/read-model/types";
import { initialReview, reviewReducer, verdictParams } from "../app/src/screens/review/model";
const items = ["one", "two", "three"].map(taskId => ({ id: `review:${taskId}`, taskId, title: taskId } as AttentionItem));
const start = () => reviewReducer(initialReview, { type: "queue", items });
test("selection defaults to first task; moving clamps", () => {
  let v = start();
  expect(v.selectedId).toBe("one");
  v = reviewReducer(v, { type: "move", by: -1 });
  expect(v.selectedId).toBe("one");
  for (let n = 0; n < 4; n++) v = reviewReducer(v, { type: "move", by: 1 });
  expect(v.selectedId).toBe("three");
});
test("removal selects next, or previous at the end, and clears an empty queue", () => {
  const middle = reviewReducer(start(), { type: "select", id: "two" });
  expect(reviewReducer(middle, { type: "queue", items: [items[0]!, items[2]!] }).selectedId).toBe("three");
  const last = reviewReducer(start(), { type: "select", id: "three" });
  expect(reviewReducer(last, { type: "verdict-done", id: "three" }).selectedId).toBe("two");
  expect(reviewReducer(last, { type: "queue", items: [] }).selectedId).toBeNull();
});
test("notes reset on selection and pending ends on verdict", () => {
  const v = reviewReducer(start(), { type: "open-note", for: "reject" });
  expect(v.noteFor).toBe("reject");
  expect(reviewReducer(v, { type: "move", by: 1 }).noteFor).toBeNull();
  expect(reviewReducer(reviewReducer(v, { type: "verdict-sent" }), { type: "verdict-done", id: "one" })).toMatchObject({ selectedId: "two", pending: false, noteFor: null });
});
test("verdict params carry the task revision so a stale window cannot overwrite another verdict", () => {
  for (const verdict of ["accept", "reject", "send_back", "retry"] as const) {
    expect(verdictParams({ id: "one", rev: 8 }, { verdict, note: "fix it", kind: "tests", executor: "codex" })).toEqual({ id: "one", verdict, accepted: verdict === "accept", note: "fix it", kind: "tests", executor: "codex", expect_rev: 8 });
  }
  expect(verdictParams({ id: "one" }, { verdict: "accept" })).toEqual({ id: "one", verdict: "accept", accepted: true });
  for (const verdict of ["reject", "send_back"] as const) expect(() => verdictParams({ id: "one" }, { verdict, note: "  " })).toThrow("Add a note first.");
  expect(() => verdictParams({ id: "one" }, { verdict: "retry" })).toThrow("Choose an executor to retry on.");
});
test("batched removals select the surviving successor from the previous queue", () => {
  const extra = { ...items[2]!, id: "four", taskId: "four", title: "four" };
  let v = reviewReducer(initialReview, { type: "queue", items: [...items, extra] });
  v = reviewReducer(v, { type: "select", id: "two" });
  expect(reviewReducer(v, { type: "queue", items: [items[2]!, extra] }).selectedId).toBe("three");
});

test("a review link for a task no longer in the queue says so instead of picking another", async () => {
  const { reviewReducer, initialReview } = await import("../app/src/screens/review/model");
  const items = [{ id: "review:a", taskId: "a" }, { id: "review:b", taskId: "b" }] as never[];
  const v = reviewReducer(reviewReducer(initialReview, { type: "queue", items }), { type: "request", id: "gone" });
  expect(v.missing).toBe("gone");
  expect(v.selectedId).toBeNull();
  const picked = reviewReducer(v, { type: "select", id: "b" });
  expect(picked).toMatchObject({ missing: null, selectedId: "b" });
  const present = reviewReducer(reviewReducer(initialReview, { type: "queue", items }), { type: "request", id: "b" });
  expect(present).toMatchObject({ missing: null, selectedId: "b" });
});
