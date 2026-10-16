import { expect, test } from "bun:test";
import { tasksModel, delegateParams, recentRepos, nextTaskLimit, taskActions } from "../app/src/model/tasks";
import { executorLabel } from "../src/view-model/words";

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
