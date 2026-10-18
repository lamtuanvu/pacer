import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import snapshot from "./fixtures/ui/snapshot.json";
import fixture from "./fixtures/ui/task-get.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { TaskDetail } from "../src/core/task-detail";
import { ReviewView } from "../app/src/screens/Review";
import { Diff } from "../app/src/screens/review/Diff";
import { initialReview, reviewReducer } from "../app/src/screens/review/model";
import { reviewQueue } from "../src/view-model/selectors";
const snap = snapshot as unknown as ClientSnapshot;
const task = fixture as unknown as TaskDetail;
const view = (detail = task, s = snap) => renderToString(<ReviewView snapshot={s} view={reviewReducer(initialReview, { type: "queue", items: reviewQueue(s) })} task={detail} now={snap.at} />);
test("review item shows run line, facts, collapsed brief and all file counts", () => {
  const html = view();
  for (const word of [task.goal, task.executor!, "50m", "pacer/review → main", task.repo.label, "Done when", "bun test", "✓ 38 passed · 41 s · run by pacer on devbox", "Why this executor", "Best available capacity", "other", "over budget", "Implemented and verified", "src/example.ts", "+3", "−1"]) expect(html).toContain(word);
  expect(html).not.toContain(">Cost<");
  expect(html).toContain("<details>");
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
  expect(html).toContain("Open in editor");
  expect(html).not.toContain("+line-2000");
  expect(renderToString(<Diff path="x" binary patch="" />)).toContain("Binary file");
  const deleted = renderToString(<Diff path="x" patch={'diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-<script>bad</script>'} />);
  expect(deleted).toContain("diff-removed");
  expect(deleted).toContain("&lt;script>");
});
test("remote diff note is visible", () => {
  expect(renderToString(<Diff path="x" patch="" note="changes are on devbox until the run ends" />)).toContain("changes are on devbox until the run ends");
});
