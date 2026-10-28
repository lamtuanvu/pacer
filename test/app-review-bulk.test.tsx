import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import snapshotFixture from "./fixtures/ui/snapshot.json";
import taskFixture from "./fixtures/ui/task-get.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { TaskDetail } from "../src/core/task-detail";
import type { AttentionItem } from "../src/api/read-model/types";
import { initialState, type StoreState } from "../app/src/data/store";
import { TaskContext } from "../app/src/screens/task-shared";
import { ActionContext } from "../app/src/data/action-context";
import { ApiError } from "../app/src/data/api";
import { createActionRunner } from "../app/src/data/actions";
import { BulkReview, ReviewCheckbox, runBulkReview, scopedReviewQueue, selectedReviews } from "../app/src/screens/review/BulkReview";
import { DispatchView } from "../app/src/screens/dispatch/Dispatch";
import { Review, ReviewView } from "../app/src/screens/Review";
import { initialReview } from "../app/src/screens/review/model";

const base = taskFixture as unknown as TaskDetail;
const snapshot = snapshotFixture as unknown as ClientSnapshot;
const repoA = { key: "repo-a", label: "Repo A", path: "/tmp/repo-a" };
const repoB = { key: "repo-b", label: "Repo B", path: "/tmp/repo-b" };
const states = ["passed", "failed", "none", "pending", "running", "passed"] as const;
const tasks = states.map((state, i): TaskDetail => ({ ...base, id: `bulk-${i}`, title: `Task ${i}`, state: "done", rev: 10 + i,
  repo: i === 5 ? repoB : repoA, review: undefined, resolved: undefined, dismissed: false, retriedBy: undefined,
  acceptance: { ...base.acceptance, state } }));
const items = tasks.map((task, i): AttentionItem => ({ ...snapshot.attention!.find(item => item.kind === "review")!,
  id: `review-${i}`, taskId: task.id, title: task.title!, repo: task.repo, kind: "review" }));
const snap = { ...snapshot, tasks, attention: items, repos: [repoA, repoB] };
function harness({ confirm = true, note = "Needs fixes", failures = {} as Record<string, string>, readFailures = [] as string[], settled = true } = {}) {
  const calls: { op: string; params: Record<string, unknown> }[] = [], confirmations: string[] = [];
  const runner = createActionRunner({
    call: async <T,>(op: string, raw: unknown) => {
      const params = raw as Record<string, unknown>;
      calls.push({ op, params });
      if (op === "task.get") {
        if (readFailures.includes(String(params.id))) throw new ApiError("not_found", "Evidence unavailable");
        return tasks.find(task => task.id === params.id) as T;
      }
      if (failures[String(params.id)]) throw new ApiError(failures[String(params.id)]!, "Review failed");
      return {} as T;
    },
    waitFor: async match => {
      expect(match({ snapshot: null } as StoreState)).toBe(false);
      expect(match({ snapshot: snap } as unknown as StoreState)).toBe(false);
      expect(match({ snapshot: { ...snap, attention: [] } } as unknown as StoreState)).toBe(true);
      return settled;
    }, refetch() {}, navigate() {},
  });
  return { calls, confirmations, runner,
    confirm: (text: string) => { confirmations.push(text); return confirm; }, prompt: () => note };
}
const writes = (h: ReturnType<typeof harness>) => h.calls.filter(call => call.op !== "task.get");

test("accept-all checks explicit passing evidence in the repository and confirms the exact task list", async () => {
  const h = harness();
  const result = await runBulkReview({ ...h, items: scopedReviewQueue(snap, repoA.key), passingOnly: true, verdict: "accept" });
  expect(result).toBe("Accepted 1 of 1 task(s).");
  expect(writes(h)).toEqual([{ op: "task.review", params: { id: "bulk-0", verdict: "accept", accepted: true, expect_rev: 10 } }]);
  expect(h.confirmations).toHaveLength(1);
  expect(h.confirmations[0]).toContain("Task 0 (bulk-0) · Repo A");
  for (let i = 1; i < 6; i++) expect(h.confirmations[0]).not.toContain(`Task ${i}`);
  expect(h.confirmations[0]).toContain("You merge branches.");
});

test("cancel and no passing evidence never send verdict operations", async () => {
  const h = harness({ confirm: false });
  expect(await runBulkReview({ ...h, items, passingOnly: true, verdict: "accept" })).toContain("Cancelled");
  expect(writes(h)).toEqual([]);
  const empty = harness();
  expect(await runBulkReview({ ...empty, items: items.slice(1, 5), passingOnly: true, verdict: "accept" })).toBe("No eligible tasks.");
  expect(empty.confirmations).toEqual([]);
  expect(writes(empty)).toEqual([]);
});

test("multi-select accept and reject use existing verdict ops, revisions and the shared rejection note", async () => {
  const selected = selectedReviews(scopedReviewQueue(snap, repoA.key), new Set(["bulk-0", "bulk-1", "bulk-5", "stale"]));
  expect(selected.map(item => item.taskId)).toEqual(["bulk-0", "bulk-1"]);
  for (const verdict of ["accept", "reject"] as const) {
    const h = harness();
    await runBulkReview({ ...h, items: selected, passingOnly: false, verdict });
    expect(writes(h)).toEqual(selected.map((item, i) => ({ op: "task.review", params: {
      id: item.taskId, verdict, accepted: verdict === "accept", expect_rev: 10 + i, ...(verdict === "reject" ? { note: "Needs fixes" } : {}),
    } })));
    expect(h.confirmations[0]).toContain("Task 1 (bulk-1)");
  }
});

test("reject validates the note, and duplicate selections only record one verdict", async () => {
  for (const note of ["", "   "]) {
    const h = harness({ note });
    expect(await runBulkReview({ ...h, items, passingOnly: false, verdict: "reject" })).toContain("requires a note");
    expect(writes(h)).toEqual([]);
    expect(h.confirmations).toEqual([]);
  }
  const h = harness();
  await runBulkReview({ ...h, items: [items[0]!, items[0]!], passingOnly: false, verdict: "accept" });
  expect(writes(h)).toHaveLength(1);
});

test("partial failures and conflicts remain visible while later tasks are still reviewed", async () => {
  const h = harness({ failures: { "bulk-0": "conflict", "bulk-1": "invalid_input" }, readFailures: ["bulk-2"] });
  const result = await runBulkReview({ ...h, items: items.slice(0, 4), passingOnly: false, verdict: "accept" });
  expect(result).toContain("Accepted 1 of 3 task(s).");
  expect(result).toContain("Task 0: Already handled elsewhere");
  expect(result).toContain("Task 1: Review failed");
  expect(result).toContain("Task 2: Evidence unavailable");
  expect(h.confirmations[0]).toContain("Skipped:");
  expect(writes(h).map(call => call.params.id)).toEqual(["bulk-0", "bulk-1", "bulk-3"]);
});

test("successful operation responses count even when the review snapshot has not caught up", async () => {
  const h = harness({ settled: false });
  const result = await runBulkReview({ ...h, items: [items[0]!, items[5]!], passingOnly: true, verdict: "accept" });
  expect(result).toBe("Accepted 2 of 2 task(s).");
  expect(writes(h)).toHaveLength(2);
});

test("Overview has no bulk verdict controls while legacy review controls remain compatible", () => {
  const h = harness();
  const overview = renderToString(<DispatchView snapshot={snap} query={{ repo: repoA.key, scope: null }} now={snap.at}
    runner={h.runner}/>);
  const review = renderToString(<BulkReview snapshot={snap} repo={repoA.key} runner={h.runner}>
    <ReviewView snapshot={snap} view={{ ...initialReview, queue: scopedReviewQueue(snap, repoA.key) }} now={snap.at} />
  </BulkReview>);
  expect(overview).not.toContain("Accept all with passing checks");
  expect(overview).not.toContain("Select all review tasks");
  for (const html of [review]) {
    expect(html).toContain("Accept all with passing checks");
    expect(html).toContain("Select all review tasks");
    expect(html).toContain("Accept selected");
    expect(html).toContain("Reject selected");
    expect(html).toContain('aria-label="Select Task 0"');
    expect(html).not.toContain('aria-label="Select Task 5"');
    expect(html).toMatch(/disabled[^>]*>Accept selected/);
  }
  expect(renderToString(<ReviewCheckbox item={{ ...items[0]!, kind: "failed", taskId: undefined }} />)).toBe("");
});


test("Review route installs the repository filter and scopes its queue and bulk selection", () => {
  const h = harness();
  const html = renderToString(<TaskContext.Provider value={{ state: { ...initialState(), snapshot: snap }, api: {
    call: async <T,>() => ({} as T), hello: async () => { throw new Error("not used in SSR"); }, snapshot: async () => ({ protocol: "3.0.0", seq: snap.seq, snapshot: snap }),
  } }}><ActionContext.Provider value={h.runner}>
    <Review route={{ name: "review", query: { repo: repoB.key, scope: null } }} />
  </ActionContext.Provider></TaskContext.Provider>);
  expect(html).toContain('aria-label="Repository filter"');
  expect(html).toContain("Review queue · 1");
  expect(html).toContain('aria-label="Select Task 5"');
  expect(html).not.toContain('aria-label="Select Task 0"');
  expect(html).toContain("Accept all with passing checks");
});

test("bulk scope excludes snoozed and non-review attention, and stale selections disappear", () => {
  const scoped = scopedReviewQueue({ ...snap, attention: [
    { ...items[0]!, snoozedUntil: snap.at + 100 }, { ...items[1]!, kind: "failed" }, items[2]!,
  ] }, repoA.key);
  expect(scoped.map(item => item.taskId)).toEqual(["bulk-2"]);
  expect(selectedReviews(scoped, new Set(["bulk-0", "bulk-1"]))).toEqual([]);
});


test("bulk evidence reads start together and confirmation waits for all reads in queue order", async () => {
  const reads: string[] = [];
  const releases = new Map<string, () => void>();
  const confirmations: string[] = [];
  const runner = createActionRunner({
    call: async <T,>(op: string, raw: unknown) => {
      expect(op).toBe("task.get");
      const id = (raw as { id: string }).id;
      reads.push(id);
      await new Promise<void>(resolve => releases.set(id, resolve));
      return tasks.find(task => task.id === id) as T;
    },
    waitFor: async () => { throw new Error("No snapshot wait needed"); }, refetch() {}, navigate() {},
  });
  const pending = runBulkReview({ runner, items: [items[0]!, items[1]!, items[0]!], passingOnly: false, verdict: "accept",
    confirm: async text => { confirmations.push(text); return false; }, prompt: () => null });
  expect(reads).toEqual(["bulk-0", "bulk-1"]);
  expect(confirmations).toEqual([]);
  releases.get("bulk-1")!();
  await Promise.resolve();
  expect(confirmations).toEqual([]);
  releases.get("bulk-0")!();
  expect(await pending).toContain("Cancelled");
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]!.indexOf("Task 0")).toBeLessThan(confirmations[0]!.indexOf("Task 1"));
});

test("bulk review awaits the in-app confirmation before recording any verdict", async () => {
  const h = harness();
  let answer!: (value: boolean) => void;
  let shown!: () => void;
  const visible = new Promise<void>(resolve => { shown = resolve; });
  const pending = runBulkReview({ ...h, items: [items[0]!], passingOnly: false, verdict: "accept",
    confirm: () => { shown(); return new Promise<boolean>(resolve => { answer = resolve; }); } });
  await visible;
  expect(writes(h)).toEqual([]);
  answer(true);
  expect(await pending).toBe("Accepted 1 of 1 task(s).");
});

test('asynchronous in-app confirmation blocks all writes until the user confirms', async () => {
  const h = harness();
  let answer: ((confirmed: boolean) => void) | undefined;
  let shown!: () => void;
  const visible = new Promise<void>(resolve => { shown = resolve; });
  const result = runBulkReview({ ...h, items: items.slice(0, 1), passingOnly: true, verdict: 'accept',
    confirm: message => {
      expect(message).toContain('Task 0 (bulk-0) · Repo A');
      shown();
      return new Promise<boolean>(resolve => { answer = resolve; });
    },
  });
  await visible;
  expect(writes(h)).toEqual([]);
  answer!(true);
  expect(await result).toContain('Accepted 1 of 1');
  expect(writes(h)).toHaveLength(1);
});

test('asynchronous rejection reason and confirmation cancellations never record verdicts', async () => {
  for (const note of [null, 'Needs fixes']) {
    const h = harness();
    const result = await runBulkReview({ ...h, items: items.slice(0, 1), passingOnly: false, verdict: 'reject',
      prompt: async () => note, confirm: async () => false,
    });
    expect(result).toContain('Cancelled');
    expect(writes(h)).toEqual([]);
  }
});
