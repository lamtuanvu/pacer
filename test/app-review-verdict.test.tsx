import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/task-get.json";
import type { TaskDetail } from "../src/core/task-detail";
import { VerdictPanel, handleNoteKey, verdictCommand } from "../app/src/screens/review/VerdictPanel";
import { copyWorktreePath, registerReviewKeys, submitVerdict } from "../app/src/screens/Review";
import { createActionRunner } from "../app/src/data/actions";
import { ApiError } from "../app/src/data/api";
import { createKeyRegistry } from "../app/src/keys/registry";
import { initialReview, reviewReducer, type ReviewAction } from "../app/src/screens/review/model";
import type { AttentionItem } from "../src/api/read-model/types";
const task = fixture as unknown as TaskDetail;
test("verdict panel has one primary, disables unavailable retry and explains accept", () => {
  const html = renderToString(<VerdictPanel task={task} note="" kind={task.kind ?? ""} executor="" noteFor={null} pending={false} onNote={() => {}} onKind={() => {}} onExecutor={() => {}} onOpenNote={() => {}} onCancel={() => {}} onSubmit={() => {}} />);
  expect(html).toContain("Accept and bring back");
  expect(html.match(/pc-btn--primary/g)?.length).toBe(1);
  expect(html).toContain("Accept records the verdict; you merge the branch.");
  expect(html).toMatch(/<option value="other" disabled[^>]*>other · Sign-in needed/);
  expect(html).toContain("Suggested from the task description");
  expect(html).not.toContain("classifier");
  expect(html).toContain(`pacer review ${task.id} --accept`);
});
test("CLI footer follows verdict, kind and safely quoted note", () => {
  const cmd = verdictCommand("t1", { verdict: "reject", kind: "tests", note: 'fix "this" $value' });
  expect(cmd).toContain('--reject --kind tests --note "fix \\"this\\" \\$value"');
  expect(verdictCommand("t1", { verdict: "send_back", note: "fix" })).toContain("--send-back");
  expect(verdictCommand("t1", { verdict: "retry", executor: "codex" })).toContain("--retry-on codex");
});
const key = (k: string, target: unknown = null) => ({ key: k, target, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} });
test("review shortcut registration preserves typing in textarea", () => {
  const registry = createKeyRegistry({ controlActive: () => false });
  registry.setScope("review");
  const calls: string[] = [];
  const off = registerReviewKeys(registry, { move: n => calls.push(String(n)), accept: () => calls.push("accept"), openNote: v => calls.push(v), retry: () => calls.push("retry"), open: () => calls.push("open") });
  registry.handle(key("r"));
  expect(calls).toEqual(["reject"]);
  expect(registry.handle(key("a", { tagName: "TEXTAREA" }))).toBe(false);
  expect(calls).toEqual(["reject"]);
  for (const k of ["j", "k", "a", "s", "t", "o"]) registry.handle(key(k));
  expect(calls).toEqual(["reject", "1", "-1", "accept", "send_back", "retry", "open"]);
  off();
  expect(registry.list()).toHaveLength(0);
});
test("note Enter submits, Shift Enter remains newline and Escape cancels", () => {
  const calls: string[] = [];
  const act = (key: string, shiftKey = false) => handleNoteKey({ key, shiftKey, isComposing: false, preventDefault: () => calls.push("prevent"), stopPropagation() {} }, () => calls.push("submit"), () => calls.push("cancel"));
  act("Enter", true); expect(calls).toEqual([]);
  act("Enter"); act("Escape");
  expect(calls).toEqual(["prevent", "submit", "prevent", "cancel"]);
});
function harness(conflict = false) {
  const calls: unknown[] = [], messages: string[] = [];
  let view = reviewReducer(initialReview, { type: "queue", items: [{ id: "a", taskId: task.id, title: task.goal }, { id: "b", taskId: "next", title: "Next goal" }] as AttentionItem[] });
  const dispatch = (a: ReviewAction) => { view = reviewReducer(view, a); };
  const runner = createActionRunner({ call: async <T,>(op: string, params: unknown) => { calls.push({ op, params }); if (conflict) throw new ApiError("conflict", "changed"); return {} as T; }, waitFor: async () => true, refetch() {}, navigate() {} });
  return { runner, dispatch, announce: (s: string) => messages.push(s), getView: () => view, calls, messages };
}
test("r then empty Enter validates without sending; accept advances to next item", async () => {
  const h = harness();
  h.dispatch({ type: "open-note", for: "reject" });
  await submitVerdict(task, { verdict: "reject", note: "" }, h.runner, h.dispatch, h.announce, h.getView);
  expect(h.calls).toHaveLength(0);
  expect(h.messages).toEqual(["Add a note first."]);
  await submitVerdict(task, { verdict: "accept" }, h.runner, h.dispatch, h.announce, h.getView);
  expect(h.calls).toEqual([{ op: "task.review", params: { id: task.id, verdict: "accept", accepted: true, expect_rev: task.rev } }]);
  expect(h.getView().selectedId).toBe("next");
  expect(h.messages.at(-1)).toBe("Accepted · next: Next goal");
});
test("conflict uses runner's handled words; event removes item without an error", async () => {
  const h = harness(true);
  await submitVerdict(task, { verdict: "accept" }, h.runner, h.dispatch, h.announce, h.getView);
  expect(h.messages).toEqual(["Already handled elsewhere"]);
  expect(h.getView().queue).toHaveLength(2);
  h.dispatch({ type: "queue", items: h.getView().queue.slice(1) });
  expect(h.getView().selectedId).toBe("next");
  expect(h.getView().pending).toBe(false);
});
test("open action copies the worktree path and announces success", async () => {
  const paths: string[] = [], messages: string[] = [];
  await copyWorktreePath("/tmp/fixture/worktree", s => messages.push(s), async p => { paths.push(p); });
  expect(paths).toEqual(["/tmp/fixture/worktree"]);
  expect(messages).toEqual(["Worktree path copied"]);
  await copyWorktreePath(null, s => messages.push(s), async p => { paths.push(p); });
  expect(paths).toHaveLength(1);
  expect(messages.at(-1)).toBe("No worktree path available");
});

test("verdict groups secondary actions, labels inline retry and collapses the CLI", () => {
  const html = renderToString(<VerdictPanel task={task} note="" kind="" executor="" noteFor={null} pending={false} onNote={() => {}} onKind={() => {}} onExecutor={() => {}} onOpenNote={() => {}} onCancel={() => {}} onSubmit={() => {}} />);
  expect(html).toContain('<h2 class="pc-section-heading">Your verdict</h2>');
  expect(html).toMatch(/pc-verdict-pair[^>]*><button[^>]*>Send back<\/button><button[^>]*>Reject<\/button><\/div>/);
  expect(html).toMatch(/<label for="review-retry" class="pc-section-heading">Or retry on<\/label><div class="row"><select(?=[^>]*class="pc-select(?: [^"]*)?")(?=[^>]*id="review-retry")/);
  expect(html).toMatch(/<details class="pc-disclosure"><summary>Use the CLI<\/summary><code[^>]*>pacer review/);
  expect(html).not.toContain('<details open');
});
