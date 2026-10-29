import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import snapshot from "./fixtures/ui/snapshot.json";
import fixture from "./fixtures/ui/task-get.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { TaskDetail } from "../src/core/task-detail";
import { ReviewView } from "../app/src/screens/Review";
import { ApiError } from "../app/src/data/api";
import { Diff } from "../app/src/screens/review/Diff";
import { initialReview, reviewReducer } from "../app/src/screens/review/model";
import { reviewQueue } from "../src/view-model/selectors";
const snap = snapshot as unknown as ClientSnapshot;
const task = fixture as unknown as TaskDetail;
const view = (detail = task, s = snap) => renderToString(<ReviewView snapshot={s} view={reviewReducer(initialReview, { type: "queue", items: reviewQueue(s) })} task={detail} now={snap.at} />);
test("removed worktree failures from task.diff and task.get preserve the review item without exposing paths", () => {
  const state = reviewReducer(initialReview, { type: 'queue', items: reviewQueue(snap) });
  for (const error of [new Error("fatal: cannot change to '/tmp/deleted-worktree': No such file or directory"), new Error('No such file or directory: /tmp/deleted-worktree'), new ApiError('invalid_input', 'Unable to read task', '/tmp/deleted-worktree')]) {
    for (const detail of [task, undefined]) {
      const html = renderToString(<ReviewView snapshot={snap} view={state} task={detail} now={snap.at} error={error} verdictPanel={<button>Accept and bring back</button>} />);
      expect(html).toContain('Changes unavailable · the worktree was removed after the task finished');
      expect(html).toContain('Review queue · 2');
      expect(html).toContain('Accept and bring back');
      expect(html).not.toContain('/tmp/');
      expect(html).not.toContain('cannot change to');
      expect(html).not.toContain('No such file or directory');
      if (detail) for (const text of [task.goal, 'Done when', 'Executor summary', 'Changes']) expect(html).toContain(text);
      else expect(html).toContain(state.queue.find(item => item.taskId === state.selectedId)!.title);
    }
  }
});
test("other Review query errors stay useful and redact path-bearing errors and hints", () => {
  const state = reviewReducer(initialReview, { type: 'queue', items: reviewQueue(snap) });
  for (const error of [new Error('Unable to read /tmp/private-worktree'), new ApiError('internal', 'Unable to read changes', 'Check /tmp/private-worktree')]) {
    const html = renderToString(<ReviewView snapshot={snap} view={state} task={task} now={snap.at} error={error} />);
    expect(html).not.toContain('/tmp/');
    expect(html).toContain('Could not load changes. Please try again.');
  }
  expect(renderToString(<ReviewView snapshot={snap} view={state} task={task} now={snap.at} error={new Error('Service disconnected')} />)).toContain('Service disconnected');
});
test("review item shows run line, facts, collapsed brief and all file counts", () => {
  const html = view();
  for (const word of [task.goal, task.executor!, "50m", "pacer/review</code> → <code>main", task.repo.label, "Done when", "bun test", "✓ 38 passed · checks ran 41 s · run by pacer on devbox", "Why Codex · team on devbox", "Best available capacity", "other", "over budget", "Implemented and verified", "src/example.ts", "+3", "−1"]) expect(html).toContain(word);
  expect(html).toContain("Cost not recorded");
  expect(html).toContain('<details class="pc-disclosure">');
  expect(html).not.toContain("<details open");
});
test("acceptance none and empty review queue use the requested words", () => {
  expect(view({ ...task, acceptance: { cmd: null, state: "none", tail: "", machine: null } })).toContain("No done-when command");
  const html = view(task, { ...snap, attention: [] });
  expect(html).toContain("Review queue is clear");
  expect(html).toContain("Accepted today 6 · rejected 1");
});
test("diff truncates after 2000 lines, labels binaries and escapes content", () => {
  const patch = "diff --git a/x b/x\n" + Array.from({ length: 2500 }, (_, i) => i === 0 ? "@@ -0,0 +1,2499 @@" : `+line-${i}`).join("\n");
  const html = renderToString(<Diff path="x" patch={patch} />);
  expect(html.match(/class="diff-/g)?.length).toBe(2000);
  expect(html).toContain("Copy worktree path");
  expect(html).not.toContain("+line-2000");
  expect(renderToString(<Diff path="x" binary patch="" />)).toContain("Binary file");
  const deleted = renderToString(<Diff path="x" patch={'diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-<script>bad</script>'} />);
  expect(deleted).toContain("diff-removed");
  expect(deleted).toContain("&lt;script>");
});
test("remote diff note is visible", () => {
  expect(renderToString(<Diff path="x" patch="" note="changes are on devbox until the run ends" />)).toContain("changes are on devbox until the run ends");
});
test("a requested task that left the queue gets a notice, the queue stays, and no other task opens", () => {
  const v = reviewReducer(reviewReducer(initialReview, { type: "queue", items: reviewQueue(snap) }), { type: "request", id: "t-0999" });
  const html = renderToString(<ReviewView snapshot={snap} view={v} now={snap.at} />);
  expect(html).toContain("is no longer waiting for review");
  expect(html).toContain('href="#/sessions/t-0999"');
  expect(html).toContain("Review queue · 2");
  expect(html).not.toContain("Accept and bring back");
});
test("the diff's button says what it does", () => {
  const html = renderToString(<Diff path="a.ts" patch={"diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n" + "+x\n".repeat(2100)} />);
  expect(html).toContain("Copy worktree path");
  expect(html).not.toContain("Open in editor");
});

test("review heading uses the service title and shared task state while Brief keeps the full goal", () => {
  const html = view({ ...task, title: "Short service title", goal: "A longer goal with detailed requirements", brief: { ...task.brief, goal: "A longer goal with detailed requirements" } });
  expect(html).toMatch(/<h2[^>]*>Short service title<\/h2><span[^>]*>[\s\S]*?Completed<\/span>/);
  expect(html).toMatch(/<summary>Brief<\/summary>[\s\S]*A longer goal with detailed requirements/);
  expect(view({ ...task, title: "Failed task", state: "failed", acceptance: { ...task.acceptance, state: "failed" } })).toMatch(/<h2[^>]*>Failed task<\/h2><span[^>]*>[\s\S]*?Failed<\/span>/);
});

test("review keeps all three cards, the compact queue status and verdict learning note", () => {
  const html = view({ ...task, cost: { executor: { account: "team", deltaPct: 1.2, window: "week" }, planner: null } });
  expect(html).toMatch(/pc-review-cards[\s\S]*Done when[\s\S]*Why Codex[\s\S]*Cost/);
  expect(html).toContain('used 1% of weekly quota');
  expect(html).toContain('Your verdicts teach routing which executor suits which kind.');
  expect(html).toMatch(/pc-pill--warn[^>]*>[\s\S]*?Review requested<\/span> · /);
  expect(html).toContain('j k next · a accept · r reject · t retry elsewhere');
});

test('review keeps task content visible with a subtle updating status during a refresh',()=>{
 const html=renderToString(<ReviewView snapshot={snap} view={reviewReducer(initialReview,{type:'queue',items:reviewQueue(snap)})} task={task} now={snap.at} loading updating/>);
 expect(html).toContain('Updating…');
 expect(html).toContain('Executor summary');
 expect(html).not.toContain('Loading task…');
});

test("review clips full titles with CSS and makes command scrollers keyboard reachable", () => {
  const fullTitle = "Repair the review queue " + "for all existing workers ".repeat(5) + "(keep the closing bracket)";
  const command = "bun run typecheck && bun run test && bun run app:build";
  const detail = { ...task, fullTitle, title: "Repair the review queue…", acceptance: { ...task.acceptance, cmd: command } };
  const s = { ...snap, tasks: snap.tasks.map(t => ({ ...t, fullTitle })) };
  const html = view(detail, s);
  expect(html).toContain(`title="${fullTitle}" class="pc-ellipsis"`);
  expect(html).toContain(`title="${fullTitle}" class="pc-section-heading pc-ellipsis grow"`);
  expect(html).toMatch(/<code(?=[^>]*class="pc-code-scroll")(?=[^>]*tabindex="0")[^>]*>bun run typecheck &amp;&amp; bun run test &amp;&amp; bun run app:build<\/code>/);
});

test('review hides internal routing and cost strings in collapsed technical disclosures and avoids empty arrows', () => {
  const html = view({...task, branch:null, base:null, routing:{...task.routing!,why:'ok, used 0%; codex busy',skipped:[]},cost:{executor:{account:'cursor',deltaPct:0,window:'limit'},planner:null}});
  const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  expect(visible).toContain('Available capacity · 0% of quota used; Codex is busy');
  expect(visible).toContain('Cursor · no measured quota increase');
  expect(visible).toContain('ran 50m');
  for (const raw of ['ok, used', '+0%', ' → ']) expect(visible).not.toContain(raw);
  expect(html).toContain('<summary>Technical routing details</summary>');
  expect(html).toContain('ok, used 0%; codex busy');
  expect(html).not.toMatch(/<details[^>]*\bopen\b/);
});
