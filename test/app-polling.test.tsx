import { expect, jest, test } from "bun:test";
import { initialState, reduceStore } from "../app/src/data/store";
import { queryRevision } from "../app/src/screens/task-shared";
import fixture from "./fixtures/ui/snapshot.json";

const ready = () => ({ ...reduceStore(initialState(), { type: "snapshot", snapshot: fixture as never }), features: { readModel: true, ops: new Set<string>() } });

test("WorkView events reload follows the dispatch.tree revision", () => {
  const state = ready();
  const base = queryRevision(state, "dispatch.tree", { id: "task-1" });
  const taskEvent = reduceStore(state, { type: "event", event: { type: "task", seq: state.snapshot!.seq + 1, at: 2, data: { ...state.snapshot!.tasks[0], state: "done", updatedAt: 2 } } });
  expect(queryRevision(taskEvent, "dispatch.tree", { id: "task-1" })).not.toBe(base);
});

test("an unrelated plugin invalidation does not change the dispatch.tree revision", () => {
  const state = ready();
  const base = queryRevision(state, "dispatch.tree", { id: "task-1" });
  const pluginEvent = reduceStore(state, { type: "event", event: { type: "plugin", seq: state.snapshot!.seq + 1, at: 2, data: {} } });
  expect(queryRevision(pluginEvent, "dispatch.tree", { id: "task-1" })).toBe(base);
});

test("WorkView no longer keys its events reload on every invalidation", async () => {
  const source = await Bun.file("app/src/screens/work/WorkView.tsx").text();
  expect(source).toContain("treeRevision");
  expect(source).not.toContain("state.invalidations]");
});

test("Machines gates its live poll on view visibility", async () => {
  const source = await Bun.file("app/src/screens/settings/Machines.tsx").text();
  expect(source).toContain("if (!visible) return;");
  expect(source).toContain("useViewActive");
});

test("JobList reloads on tracked jobs rather than the whole jobs object", async () => {
  const source = await Bun.file("app/src/screens/settings/shared.tsx").text();
  expect(source).toContain("trackedJobSignature");
  expect(source).not.toContain("[state.jobs]");
});

test("AccountUsage reloads on tracked jobs rather than the whole jobs object", async () => {
  const source = await Bun.file("app/src/screens/settings/AccountUsage.tsx").text();
  expect(source).toContain("trackedJobSignature");
  expect(source).not.toContain("[state.jobs]");
});

test("Setup FirstRun keeps only a slow safety poll", async () => {
  const source = await Bun.file("app/src/screens/setup/Setup.tsx").text();
  expect(source).not.toMatch(/setInterval\(task\.reload,\s*1500\)/);
  expect(source).toContain("30000");
});

test("fake timers do not fire a short poll before its interval", () => {
  jest.useFakeTimers();
  let calls = 0;
  const timer = setInterval(() => { calls += 1; }, 1500);
  jest.advanceTimersByTime(1400);
  expect(calls).toBe(0);
  jest.advanceTimersByTime(200);
  expect(calls).toBe(1);
  clearInterval(timer);
  jest.useRealTimers();
});
