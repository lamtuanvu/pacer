import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/task-get.json";
import type { TaskDetail } from "../src/core/task-detail";
import { TaskActions } from "../app/src/screens/trace/TaskActions";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { uiHref } from "../app/src/data/actions";

const task = fixture as unknown as TaskDetail;
const root = { ...task, state: "done" as const, rev: 4, review: undefined, resolved: undefined, dismissed: undefined, retriedBy: undefined, acceptance: { ...task.acceptance, state: "passed" as const }, executor: "codex", work: { rootId: task.id, parentId: null, depth: 0, allowDelegation: true, userStarted: true } };
const api = { hello: async () => ({}) as never, snapshot: async () => ({}) as never, call: async <T,>() => ({}) as T };
const state = { ...initialState(), features: { ...initialState().features, ops: new Set(["task.review", "dispatch.review"]) } };
const render = (t: TaskDetail) => renderToString(<TaskContext.Provider value={{ state, api }}><TaskActions task={t} query={{ repo: null, scope: null }} reload={() => {}} /></TaskContext.Provider>);

test("the task page keeps Reject and Send back for a work root a person started", () => {
  const html = render(root as TaskDetail);
  expect(html).toContain(">Reject<");
  expect(html).toContain(">Send back<");
});

test("managed children and planner roots get no Send back on the task page", () => {
  for (const work of [{ ...root.work, parentId: "root" }, { ...root.work, userStarted: undefined }]) {
    const html = render({ ...root, work } as TaskDetail);
    expect(html).not.toContain(">Send back<");
  }
});

test("message deep links open the workspace's Messages panel", () => {
  expect(uiHref({ view: "task", id: "t1", tab: "messages" })).toBe("#/workspace?task=t1&panel=messages");
  expect(uiHref({ view: "session", id: "t1", tab: "messages" })).toBe("#/workspace?task=t1&panel=messages");
  expect(uiHref({ view: "task", id: "t1", tab: "answer" })).toBe("#/tasks/t1?tab=answer");
});
