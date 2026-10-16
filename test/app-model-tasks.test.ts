import { expect, test } from "bun:test";
import { emptySnapshot } from "../src/link/envelope";
import { homeModel } from "../app/src/model/home";
import { tasksModel, taskCounts, delegateParams, recentRepos, nextTaskLimit, taskActions, executorLabel } from "../app/src/model/tasks";

const task = (task_id: string, state: string, extra = {}) => ({ task_id, state, kind: "tests", requested_executor: null, attempts: [], result: null, review: null, resolved: null, ...extra });
test("tabs distinguish active, unreviewed and historical tasks and preserve snapshot titles", () => {
  const tasks = [task("q", "queued"), task("r", "running"), task("d", "done"), task("p", "partial"), task("a", "done", { review: { accepted: true } }), task("f", "failed")];
  const snapshot = [{ id: "r", goal: "Real title", state: "running", executor: "codex", backend: null, worktree: null, updatedAt: 1 }];
  expect(tasksModel(tasks, snapshot, "running").map(t => t.id)).toEqual(["q", "r"]);
  expect(tasksModel(tasks, snapshot, "running")[1]?.goal).toBe("Real title");
  expect(tasksModel(tasks, snapshot, "review").map(t => t.id)).toEqual(["d", "p"]);
  expect(tasksModel(tasks, snapshot, "history").map(t => t.id)).toEqual(["a", "f"]);
  expect(taskActions(task("q", "queued"))).toEqual(["stop"]);
  expect(taskActions(task("f", "failed"))).toEqual(["retry", "dismiss"]);
  expect(executorLabel("claude-code#work@box")).toBe("Claude Code · work on box");
});
test("snapshot events override stale query states and reviews", () => {
  const live = [{ id: "r", goal: "Done now", state: "done", executor: "codex", backend: null, worktree: null, updatedAt: 2 }];
  expect(tasksModel([task("r", "running")], live, "running")).toEqual([]);
  expect(tasksModel([task("r", "running")], live, "review")[0]?.goal).toBe("Done now");
});
test("pagination grows bounded API limits; delegate validates input and omits automatic executor", () => {
  expect(nextTaskLimit(20)).toBe(40);
  expect(nextTaskLimit(190)).toBe(200);
  expect(nextTaskLimit(200)).toBeNull();
  expect(() => delegateParams({ goal: " ", repo: "/repo", kind: "tests", executor: "", worktree: "auto", timeout: "30", acceptance: "" })).toThrow("Goal");
  expect(() => delegateParams({ goal: "Test", repo: "/repo", kind: "tests", executor: "", worktree: "auto", timeout: "241", acceptance: "" })).toThrow("Timeout");
  expect(delegateParams({ goal: " Test ", repo: " /repo ", kind: "tests", executor: "", worktree: "new", timeout: "30", acceptance: "bun test" })).toEqual({ goal: "Test", repo: "/repo", kind: "tests", worktree: "new", timeout_min: 30, acceptance: "bun test" });
  expect(recentRepos(["/a", "/b", "/a", ""])).toEqual(["/a", "/b"]);
});
test("dismissed history stays hidden when a task is older than the snapshot", () => {
  expect(tasksModel([task("old", "failed")], [], "history", ["old"])).toEqual([]);
});

test("service review attention controls review and history membership", () => {
  const live = { ...emptySnapshot(), attention: [{ id: "review:d", taskId: "d", kind: "review" as const, severity: "decide" as const, repo: null, title: "Review", detail: "", raisedAt: 1, since: 1, notify: "important" as const, actions: [] }] };
  const tasks = [task("d", "done"), task("planner", "done")];
  expect(tasksModel(tasks, live, "review").map(t => t.id)).toEqual(["d"]);
  expect(tasksModel(tasks, live, "history").map(t => t.id)).toEqual(["planner"]);
  expect(tasksModel(tasks, { ...live, attention: [] }, "review")).toEqual([]);
  const counts = { attention: 9, problems: 2, review: 7, running: 3, queued: 2, ready: 1, executors: 1, setupOpen: 0, hostsWithProblems: 0, byRepo: {} };
  expect(taskCounts({ ...live, counts })).toEqual({ running: 5, review: 7 });
  expect(homeModel({ ...live, counts }, []).attentionCount).toBe(9);
});
