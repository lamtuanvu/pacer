import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/task-get.json";
import type { TaskDetail } from "../src/core/task-detail";
import { TaskResultView, legacyQuestionPending, legacyReviewAvailable } from "../app/src/screens/TaskResult";
import { VerdictPanel } from "../app/src/screens/review/VerdictPanel";
import { ApiError } from "../app/src/data/api";
import { answerSteps, sendBackSteps, userStartedRoot, withManagedFallback } from "../src/view-model/managed-root";

const task = fixture as unknown as TaskDetail;
const root = { ...task, state: "done" as const, rev: 4, work: { rootId: task.id, parentId: null, depth: 0, allowDelegation: true, userStarted: true } };
const child = { ...root, work: { rootId: "root", parentId: "root", depth: 1, userStarted: true } };
const panel = (t: TaskDetail) => renderToString(<VerdictPanel task={t} note="" kind="" executor="" noteFor={null} pending={false} onNote={() => {}} onKind={() => {}} onExecutor={() => {}} onOpenNote={() => {}} onCancel={() => {}} onSubmit={() => {}}/>);

test("a work root a person started keeps the usual answer and verdict controls", () => {
  expect(userStartedRoot(root)).toBe(true);
  expect(legacyReviewAvailable(root, true)).toBe(true);
  expect(legacyQuestionPending({ ...root, state: "needs_input", question: { text: "Which format?", at: 1 } })).toBe(true);
  const html = renderToString(<TaskResultView task={{ ...root, reviewRequest: { note: "Check it", at: 1 } }} verdict={<button>Verdict form</button>}/>);
  expect(html).not.toContain("Use the Work tab for decisions and history.");
  expect(html).toContain("Verdict form");
  expect(html).toContain("This task can coordinate sub-agents.");
  const verdict = panel(root);
  expect(verdict).toContain(">Send back<");
  expect(verdict).toContain("Mark accepted");
  expect(verdict).toContain("Reject result");
});

test("work children and planner roots keep the Work tab", () => {
  for (const managed of [child, { ...root, work: { ...root.work, userStarted: undefined } }]) {
    expect(userStartedRoot(managed)).toBe(false);
    expect(legacyReviewAvailable(managed, true)).toBe(false);
    expect(legacyQuestionPending({ ...managed, state: "needs_input", question: { text: "?", at: 1 } })).toBe(false);
    expect(renderToString(<TaskResultView task={managed} verdict={<button>Verdict form</button>}/>)).toContain("Use the Work tab for decisions and history.");
    expect(panel(managed)).not.toContain(">Send back<");
  }
});

function fakeCall(fail: Record<string, Error>, results: Record<string, unknown> = {}) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const call = async (op: string, params: Record<string, unknown>) => { calls.push({ op, params }); if (fail[op]) throw fail[op]; return results[op] ?? {}; };
  return { calls, call };
}

test("answer uses task.answer and falls back to dispatch.answer when the service refuses", async () => {
  const ok = fakeCall({});
  await withManagedFallback(ok.call, { op: "task.answer", params: { id: "t1", text: "yes", expect_rev: 4 } }, answerSteps("t1", 4, "yes"));
  expect(ok.calls.map(c => c.op)).toEqual(["task.answer"]);
  const refused = fakeCall({ "task.answer": new ApiError("not_allowed", "Use dispatch.answer with a requestId and revision for managed work") });
  await withManagedFallback(refused.call, { op: "task.answer", params: { id: "t1", text: "yes", expect_rev: 4 } }, answerSteps("t1", 4, "yes"));
  expect(refused.calls.at(-1)).toEqual({ op: "dispatch.answer", params: { id: "t1", expect_rev: 4, requestId: "answer-t1-4", text: "yes" } });
});

test("a failed session turn rereads the revision before the managed answer", async () => {
  const f = fakeCall({ "task.answer": new ApiError("conflict", "The work could not continue its session; use dispatch.answer with a requestId and revision") }, { "task.get": { rev: 6 } });
  await withManagedFallback(f.call, { op: "task.answer", params: { id: "t1", text: "yes", expect_rev: 4 } }, answerSteps("t1", 4, "yes"));
  expect(f.calls.map(c => c.op)).toEqual(["task.answer", "task.get", "dispatch.answer"]);
  expect(f.calls.at(-1)!.params).toMatchObject({ expect_rev: 6, requestId: "answer-t1-4" });
});

test("send back without a session rejects a finished result, then retries with the note at the new revision", async () => {
  const f = fakeCall({ "task.review": new ApiError("not_allowed", "Use dispatch.review for work results") }, { "dispatch.review": { task: { rev: 5 } } });
  await withManagedFallback(f.call, { op: "task.review", params: { id: "t1", verdict: "send_back", note: "fix", expect_rev: 4 } }, sendBackSteps({ id: "t1", rev: 4, state: "done" }, "fix"));
  expect(f.calls.slice(1)).toEqual([
    { op: "dispatch.review", params: { id: "t1", accepted: false, note: "fix", expect_rev: 4 } },
    { op: "dispatch.retry", params: { id: "t1", expect_rev: 5, requestId: "sendback-t1-4", feedback: "fix" } },
  ]);
  expect(sendBackSteps({ id: "t1", rev: 4, state: "failed" }, "fix").map(s => s.op)).toEqual(["dispatch.retry"]);
});

test("other errors are not retried on the managed path", async () => {
  const f = fakeCall({ "task.review": new ApiError("conflict", "task changed") });
  await expect(withManagedFallback(f.call, { op: "task.review", params: { id: "t1" } }, sendBackSteps({ id: "t1", rev: 4, state: "done" }, "x"))).rejects.toThrow("task changed");
  expect(f.calls.map(c => c.op)).toEqual(["task.review"]);
});
