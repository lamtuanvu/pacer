import { expect, test } from "bun:test";
import { emptySnapshot } from "../src/link/envelope";
import { homeModel } from "../app/src/model/home";
import { tasksModel, taskCounts, delegateParams, nextTaskLimit, taskActions } from "../app/src/model/tasks";
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

const draft = { goal: " Add SSH keepalive ", repo: "github.com/acme/api", base: "main", acceptance: " bun test ", executor: "", kind: "" };
const known = ["github.com/acme/api"];
test("quick delegate sends a repo key, base, source and an idempotency id to a 2.1+ service", () => {
  expect(delegateParams(draft, new Set(["repo.list"]), "req-1", known)).toEqual({ goal: "Add SSH keepalive", repo: "github.com/acme/api", base: "main", acceptance: "bun test", source: "ui", request_id: "req-1" });
  expect(delegateParams({ ...draft, executor: "codex#team", base: "" }, new Set(["repo.list"]), "req-1", known)).toEqual({ goal: "Add SSH keepalive", repo: "github.com/acme/api", acceptance: "bun test", executor: "codex#team", source: "ui", request_id: "req-1" });
});
test("an older service gets only the fields it knows and needs an absolute path", () => {
  expect(delegateParams({ ...draft, repo: "/tmp/fixture/api" }, new Set(), "req-1", [])).toEqual({ goal: "Add SSH keepalive", repo: "/tmp/fixture/api", acceptance: "bun test" });
  expect(() => delegateParams(draft, new Set(), "req-1", known)).toThrow("Choose a repository.");
});
test("quick delegate refuses an empty goal or an unknown repository", () => {
  expect(() => delegateParams({ ...draft, goal: "  " }, new Set(["repo.list"]), "r", known)).toThrow("Goal is required.");
  expect(() => delegateParams({ ...draft, repo: "acme" }, new Set(["repo.list"]), "r", known)).toThrow("Choose a repository.");
  expect(() => delegateParams({ ...draft, repo: "" }, new Set(["repo.list"]), "r", known)).toThrow("Choose a repository.");
});
test("the dialog prefers the active repo filter over a saved repo", async () => {
  const { initialDelegateDraft, blankDelegate } = await import("../app/src/model/tasks");
  expect(initialDelegateDraft(blankDelegate, "github.com/acme/web").repo).toBe("github.com/acme/web");
  expect(initialDelegateDraft({ ...blankDelegate, repo: "/tmp/x" }, "github.com/acme/web").repo).toBe("github.com/acme/web");
  expect(initialDelegateDraft(blankDelegate, null).repo).toBe("");
});
