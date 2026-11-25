/** Rail "Runs" badge: counts person-answerable run questions from the snapshot attention. */
import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type { AttentionItem } from "../src/attention/types";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { runAttentionQueue, runsBadgeCount } from "../app/src/data/runs-badge";
import { initialState } from "../app/src/data/store";
import { TaskContext } from "../app/src/screens/task-shared";
import { Rail } from "../app/src/shell/Rail";
import { resolveRoute, type Route } from "../app/src/router";

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id, kind: "question", severity: "decide", repo: null, title: "Pick", detail: "", raisedAt: 1, since: 1,
    actions: [], notify: "all", unblocks: "run",
    run: { id: `run_${id}`, letter: "A", title: "Feature", priority: "normal" },
    question: { id: `q_${id}`, rev: 1, answerType: "text", text: "?", blocks: "run" },
    ...overrides,
  };
}

// Run attention that is not an answerable run question: another kind, no question body, or no run.
const others: AttentionItem[] = [
  item("review", { kind: "review" }),
  item("failed", { kind: "failed" }),
  item("bare", { question: undefined }),
  item("task", { run: undefined }),
];

function rail(attention: AttentionItem[], narrow = false): string {
  const state = {
    ...initialState(),
    snapshot: { seq: 1, at: 1000, tasks: [], attention } as unknown as ClientSnapshot,
  };
  const counts = { attention: 9, running: 0, queued: 0, review: 0, failed: 0, setupOpen: 0 } as never;
  return renderToString(
    <TaskContext.Provider value={{ state, api: {} as never }}>
      <Rail route={resolveRoute("#/", true) as Route} counts={counts} narrow={narrow} />
    </TaskContext.Provider>,
  );
}

const runsLink = (html: string) => html.match(/<a[^>]*aria-label="Runs[^"]*"[^>]*>.*?<\/a>/)?.[0] ?? "";

test("the queue keeps only run questions", () => {
  const attention = [item("one"), ...others];
  expect(runAttentionQueue(attention).map(a => a.id)).toEqual(["one"]);
  expect(runsBadgeCount(attention)).toBe(1);
  expect(runsBadgeCount(undefined)).toBe(0);
});

test.each([false, true])("rail badge count and singular/plural label (narrow=%p)", narrow => {
  const one = runsLink(rail([item("one"), ...others], narrow));
  expect(one).toContain('aria-label="Runs, 1 question"');
  expect(one).toMatch(/pc-rail__badge[^>]*>1<\/span>/);
  const two = runsLink(rail([item("one"), item("two"), ...others], narrow));
  expect(two).toContain('aria-label="Runs, 2 questions"');
  expect(two).toMatch(/pc-rail__badge[^>]*>2<\/span>/);
  const none = runsLink(rail(others, narrow));
  expect(none).toContain('aria-label="Runs"');
  expect(none).not.toContain("pc-rail__badge");
});
