import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import taskGet from "./fixtures/ui/task-get.json";
import { createActionRunner, uiHref } from "../app/src/data/actions";
import { ActionContext } from "../app/src/data/action-context";
import { buildRunsListState } from "../app/src/data/runs";
import { initialState } from "../app/src/data/store";
import { NeedsYouList } from "../app/src/screens/dispatch/Dispatch";
import { NeedsYouPage } from "../app/src/screens/needs-you/NeedsYou";
import { VerdictPanel } from "../app/src/screens/review/VerdictPanel";
import { runBulkReview } from "../app/src/screens/review/BulkReview";
import { StepState } from "../app/src/screens/runs/run-shared";
import { TaskContext } from "../app/src/screens/task-shared";
import { performAction, rowLabel } from "../app/src/tray/Tray";
import { actionError, actionRoute } from "../app/src/tray/model";
import type { ApiClient } from "../src/api/client";
import type { AttentionItem } from "../src/attention/types";
import { Dashboard } from "../src/dashboard/controller";
import { PLAIN_THEME } from "../src/dashboard/theme";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { counts, needsYou } from "../src/view-model/selectors";
import { decisionKindLabel, stripSteps } from "../src/view-model/run-board";
import { buildRunTree } from "../src/view-model/run-tree";
import { conflictedTasks, OutcomeError, runGateNote, taskStatusIn } from "../src/view-model/run-gate";
import { deskWords } from "../app/src/screens/runs/BoardCanvas";
import { layoutLiveBoard } from "../app/src/screens/runs/live-board-layout";
import { waitsOnLabel } from "../src/view-model/runs";

const TASK = "t-20261001-100000-aaaa", RECORD = "t-20261001-100000-bbbb";
const base = { repo: null, raisedAt: 100, since: 100, notify: "all" as const, severity: "blocked" as const, run: { id: "run_abc", letter: "A", title: "Ship it", priority: "normal" as const } };
const verdict = (id: string, v: string, extra: Record<string, unknown> = {}) => ({ id, verdict: v, expect_rev: 3, ...extra });
const stepConflict: AttentionItem = {
  ...base, id: `run_review:${TASK}`, kind: "review", taskId: TASK, title: 'Merge conflict in step "impl"',
  detail: "Ship it. Accepting hit a merge conflict, so nothing was merged.",
  gate: { kind: "step_conflict", recordId: RECORD, commands: ["git merge pacer/run-abc", `pacer review ${TASK} --accept`] },
  actions: [
    { label: "Send back to resolve", op: "task.review", params: verdict(TASK, "send_back", { note: "Merge it." }), style: "primary" },
    { label: "Accept", op: "task.review", params: verdict(TASK, "accept"), confirm: "Accept now? This merges the task's branch into the run branch." },
    { label: "Reject", op: "task.review", params: verdict(TASK, "reject"), style: "danger", confirm: "Reject these changes?" },
  ],
};
const adoption: AttentionItem = {
  ...base, id: "run_review:adopt:run_child", kind: "orchestrator_failed", title: "Code from a sub-workflow cannot reach the run branch",
  detail: "Ship it. pacer keeps trying.", gate: { kind: "adoption", technical: "Step plan: fatal: broken" },
  actions: [
    { label: "Open run", op: "ui.open", params: { view: "run", id: "run_abc" }, style: "primary" },
    { label: "Stop run", op: "run.stop", params: { id: "run_abc", expect_rev: 2 }, style: "danger", confirm: "Stop this run?" },
  ],
};

function snapshotWith(attention: AttentionItem[]): ClientSnapshot {
  const snapshot = structuredClone(fixture) as unknown as ClientSnapshot;
  snapshot.tasks = [{ ...snapshot.tasks[0]!, id: TASK, state: "done", title: "Implement it" }];
  snapshot.attention = attention;
  return snapshot;
}
const runner = createActionRunner({ call: async () => ({} as never), waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const draw = (snapshot: ClientSnapshot, node: preact.ComponentChildren) => renderToString(
  <ActionContext.Provider value={runner}><TaskContext.Provider value={{ state: { ...initialState(), snapshot }, api: {} as never }}>{node}</TaskContext.Provider></ActionContext.Provider>);

test("web Needs you lists every gate item with its own words, commands and actions", () => {
  const snapshot = snapshotWith([stepConflict, adoption]);
  expect(needsYou(snapshot, { repo: null }).map(i => i.id)).toEqual([stepConflict.id, adoption.id]);
  expect(counts(snapshot)?.attention).toBe(2);
  const html = draw(snapshot, <NeedsYouPage query={{ repo: null, scope: null }} />);
  for (const words of ["Merge conflict in step", "Merge conflict", "Send back to resolve", ">Accept<", ">Reject<", "git merge pacer/run-abc",
    "Code from a sub-workflow cannot reach the run branch", "Run blocked", "Open run", "Stop run", "Technical details"]) expect(html).toContain(words);
  expect(html).toContain(`#/tasks/${TASK}/review`);
});

test("Dispatch cards offer the gate item's first action, not a generic review link", () => {
  const snapshot = snapshotWith([stepConflict, adoption]);
  const html = draw(snapshot, <NeedsYouList snapshot={snapshot} scope={{ repo: null }} runner={runner} now={200} query={{ repo: null, scope: null }} narrow={false} />);
  expect(html).toContain("Send back to resolve");
  expect(html).toContain("Open run");
  expect(html).not.toContain("Review result");
});

test("an accept or base update that conflicts is a problem in the web runner, and review stays unrecorded", async () => {
  const accepted: string[] = [];
  const conflicting = createActionRunner({
    call: async op => (op === "run.sync_base" ? { ok: false, merge: "conflict" } : { accepted: false, merge: "conflict" }) as never,
    waitFor: async () => true, refetch: () => {}, navigate: () => {}, reviewAccepted: id => accepted.push(id),
  });
  const state = await conflicting.run("k", stepConflict.actions[1]!);
  expect(state).toMatchObject({ status: "error", problem: true, message: expect.stringContaining("Not accepted") });
  expect(await conflicting.run("s", { label: "Try the update again", op: "run.sync_base", params: { id: "run_abc", expect_rev: 1 } }))
    .toMatchObject({ status: "error", message: expect.stringContaining("still conflicts") });
  expect(accepted).toEqual([]);
  await expect(conflicting.call("task.review", verdict(TASK, "accept"))).rejects.toBeInstanceOf(OutcomeError);
  expect(uiHref({ view: "run", id: "run_abc" })).toBe("#/runs/run_abc");
});

test("the verdict panel and bulk accept say that accepting a code step merges it", async () => {
  const panel = (gate?: AttentionItem) => renderToString(<VerdictPanel gate={gate} task={taskGet as never} note="" kind="" executor="" noteFor={null} pending={false}
    onNote={() => {}} onKind={() => {}} onExecutor={() => {}} onOpenNote={() => {}} onCancel={() => {}} onSubmit={() => {}} />);
  expect(panel()).toContain("you merge the branch");
  expect(panel(stepConflict)).toContain("Accepting merges the changes into the run branch.");
  expect(panel(stepConflict)).not.toContain("you merge the branch");
  let asked = "";
  const reading = { ...runner, run: async () => ({ status: "done" as const }), result: () => ({ ...taskGet, id: TASK, state: "done", review: null, resolved: null, dismissed: false, retriedBy: null }) };
  await runBulkReview({ items: [stepConflict], passingOnly: false, verdict: "accept", runner: reading as never, confirm: text => { asked = text; return false; }, prompt: () => null });
  expect(asked).toContain("merges its changes into the run branch");
});

test("the tray words, confirms and reports gate actions without cutting them", async () => {
  expect(["Send back to resolve", "Try the update again", "Accept the resolution", "Open run"].map(rowLabel)).toEqual(["Send back", "Try again", "Accept", "Details"]);
  expect(actionRoute(adoption.actions[0]!)).toBe("/needs-you");
  const api = { call: async () => ({ ok: false, merge: "conflict" }) };
  const failed = await performAction({ label: "Try the update again", op: "run.sync_base", params: {} }, api as never, {} as never).catch(e => e);
  expect(failed).toBeInstanceOf(OutcomeError);
  expect(actionError(failed)).toBe(failed.message);
});

const detail = (steps: Record<string, unknown>[]) => ({
  run: { id: "run_abc", status: "waiting" }, graphs: [], questions: [],
  definition: { entry: "impl", edges: [], steps: { impl: { type: "agent" }, fan: { type: "fanout", branches: ["a", "b"] } } },
  steps: steps.map(s => ({ runId: "run_abc", attempt: 1, startedAt: 1, ...s })),
}) as never;

test("a parked code step reads waiting for review everywhere the run is shown", () => {
  const parked = detail([{ stepId: "impl", status: "waiting", taskId: TASK, result: { summary: "ok" } }]);
  expect(buildRunTree(parked)[0]!.awaitsReview).toBe(true);
  expect(stripSteps(parked, [])[0]!.awaitsReview).toBe(true);
  expect(renderToString(<StepState marker="waits_others" status="waiting" awaitsReview />)).toContain("Waiting for review");
  const child = detail([{ stepId: "impl", status: "waiting", taskId: TASK, result: { childRunId: "run_c" } }]);
  expect(buildRunTree(child)[0]!.awaitsReview).toBeUndefined();
  const fan = (b: string) => buildRunTree(detail([
    { stepId: "fan", branch: "a", status: "waiting", taskId: TASK, result: {} },
    { stepId: "fan", branch: "b", status: b },
  ]))[0]!;
  expect(fan("done").awaitsReview).toBe(true);
  expect(fan("running").awaitsReview).toBeUndefined();
  const list = buildRunsListState({
    ops: undefined, now: 200, attention: [stepConflict], store: { list: [] } as never,
    snapshotRuns: [{ id: "run_abc", title: "Ship it", workflow: "t/x", status: "waiting", priority: "normal", letter: "A", waits_on: "orchestrator" } as never],
  });
  expect(list.runs[0]!.waitsOn).toBe(waitsOnLabel("review"));
  expect(waitsOnLabel("review")).toBe("Review by you or the planner");
});

test("a publish decision is worded Published", () => {
  expect(decisionKindLabel("published")).toBe("Published");
});

test("a fan-out with a retried branch and no join keeps the fan-out's attempt number", () => {
  const tree = buildRunTree(detail([
    { stepId: "fan", branch: "a", status: "done" },
    { stepId: "fan", branch: "b", attempt: 2, trigger: "retry:1:b", status: "running" },
  ]));
  expect(tree[0]).toMatchObject({ id: "step:fan:1:", attempt: 1 });
});

function dashboard(attention: AttentionItem[], respond: (op: string) => unknown) {
  const s = snapshotWith(attention), calls: { op: string; params: unknown }[] = [], frames: string[] = [];
  const client: ApiClient = {
    kind: "http",
    hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: ["task.review", "task.get", "run.stop", "run.sync_base", "run.get"], events: [] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
    call: async <T,>(op: string, params?: unknown) => {
      calls.push({ op, params });
      if (op === "task.get") return { ...taskGet, id: (params as { id: string }).id, state: "done", worktree: "/tmp/wt" } as T;
      return (respond(op) ?? {}) as T;
    },
    subscribe: () => () => {}, close: () => {},
  };
  const dash = new Dashboard({
    client, theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp/repo", timeZone: "UTC",
    now: () => s.at, size: () => ({ width: 140, height: 50 }), write: frame => frames.push(frame),
    attachHere: async () => {}, handoff: async () => 0,
  });
  const keys = async (...list: string[]) => { for (const key of list) { await dash.key(key); await dash.settle(); } };
  return { keys, dash, calls, last: () => frames.at(-1)! };
}

test("the terminal offers the conflict's actions and reports a conflicting accept as a failure", async () => {
  const t = dashboard([stepConflict], op => op === "task.review" ? { accepted: false, merge: "conflict" } : undefined);
  await t.dash.refresh();
  await t.keys("2");
  expect(t.last()).toContain("Merge conflict");
  expect(t.last()).toContain("Send back to resolve");
  expect(t.last()).toContain("git merge pacer/run-abc");
  expect(t.last()).not.toContain("you merge the branch");
  expect(t.last()).not.toContain("Retry on another executor");
  await t.keys("a");
  expect(t.last()).toContain("merges the task's branch into the run branch");
  await t.keys("enter");
  expect(t.calls.filter(c => c.op === "task.review")).toEqual([{ op: "task.review", params: verdict(TASK, "accept") }]);
  expect(t.last()).toContain("Not accepted");
  expect(t.last()).not.toContain("review queue is clear");
});

test("the terminal's send-back to resolve sends the service's own note", async () => {
  const t = dashboard([stepConflict], () => undefined);
  await t.dash.refresh();
  await t.keys("2", "s");
  expect(t.calls.filter(c => c.op === "task.review")).toEqual([{ op: "task.review", params: verdict(TASK, "send_back", { note: "Merge it." }) }]);
});

test("a task held by a gate never reads completed in a list", () => {
  const task = { id: TASK, state: "done" };
  expect(taskStatusIn([stepConflict], task).label).toBe("Merge conflict");
  expect(taskStatusIn([{ ...stepConflict, gate: { kind: "step_review" } }], task).label).toBe("Waiting for review");
  expect(taskStatusIn([stepConflict], { id: RECORD, state: "needs_input" }).label).toBe("Merge conflict");
  expect(taskStatusIn([], task).label).toBe("Completed");
});

test("the live board names review and conflict desks and never says nothing waits", () => {
  const board = layoutLiveBoard({ steps: [
    { runId: "run_abc", stepId: "impl", attempt: 1, status: "waiting", taskId: TASK, result: {}, startedAt: 1 },
  ], graphs: [], children: [], openQuestions: [] } as never);
  const desk = board.nodes[0]!;
  expect(deskWords(desk).label).toBe("Waiting for review");
  expect(deskWords({ ...desk, conflict: true }).label).toBe("Merge conflict");
  expect(conflictedTasks([stepConflict]).has(TASK)).toBe(true);
  expect(runGateNote("run_abc", [stepConflict])).toBe("A conflict waits for you");
  expect(runGateNote("run_abc", [{ ...stepConflict, gate: { kind: "step_review" } }])).toContain("A review waits");
  expect(runGateNote("run_other", [stepConflict])).toBeNull();
});
