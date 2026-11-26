/** Several runs at once: one queue ranked by what each answer unblocks, fixed letters and colours, focus, quiet, summaries, bench. */
import { expect, test } from "bun:test";
import { buildMultiRun, countWords, countsFromSteps, runTone, summaryOf } from "../app/src/screens/runs/multi-run";
import { buildRunsListState, initialRunsStore } from "../app/src/data/runs";
import { attention, executors, listRows, snapshotRuns } from "./app-multi-run-fixtures";

const queue = buildRunsListState({ ops: new Set(["run.list"]), attention, snapshotRuns, store: initialRunsStore(), now: 1_000_000 }).queue;
const model = (over: Partial<Parameters<typeof buildMultiRun>[0]> = {}) => buildMultiRun({ runs: listRows, queue, snapshotRuns, details: {}, executors, focusId: null, quiet: false, ...over });

test("one attention queue across the three runs keeps the service's order and names what each answer unblocks", () => {
  const m = model();
  expect(m.queue.map(q => [q.runId, q.letter, q.rank])).toEqual([
    ["run_a", "A", "Stops the run"], ["run_b", "B", "Stops a branch"], ["run_c", "C", "Informational"],
  ]);
  expect(m.queue[0]).toMatchObject({ text: "Approve the brainstormed spec?", runTitle: "Add the Runs board", priority: "urgent", question: { id: "q_a", rev: 1 } });
});

test("runs are lines with fixed letters and colours: waiting-on-you first, then priority; the colour follows the letter, not the position", () => {
  const m = model();
  expect(m.lines.map(l => [l.letter, l.tone])).toEqual([["A", 1], ["B", 2], ["C", 3]]);       // all three wait on the person: urgent, normal, background
  // when B has nothing waiting on the person, the runs that do come first
  const bQuiet = model({ queue: queue.filter(q => q.question.runId !== "run_b") });
  expect(bQuiet.lines.map(l => l.letter)).toEqual(["A", "C", "B"]);
  // the colour follows the letter, not the order the list arrived in
  const reversed = model({ runs: [...listRows].reverse() });
  expect(reversed.lines.map(l => [l.letter, l.tone])).toEqual(m.lines.map(l => [l.letter, l.tone]));
  expect(runTone("a")).toBe(1);
  expect(runTone("F")).toBe(1);            // wraps after five tones
  expect(runTone("")).toBe(1);
  expect(m.lines[0]!.counts).toEqual({ running: 0, waiting: 1, done: 2, failed: 0 });
  expect(m.lines[0]!.questions).toBe(1);
  expect(countWords(m.lines[1]!.counts!)).toBe("4 done · 3 running · 1 waiting");
  expect(countWords({ running: 0, waiting: 0, done: 0, failed: 0 })).toBe("No steps yet");
});

test("focus mode keeps one run: its line and its questions, and counts what it hides", () => {
  const m = model({ focusId: "run_b" });
  expect(m.lines.map(l => l.id)).toEqual(["run_b"]);
  expect(m.queue.map(q => q.runId)).toEqual(["run_b"]);
  expect(m.hidden.focus).toBe(2);
  expect(model().hidden.focus).toBe(0);
  // focusing a run that has no questions leaves an empty queue rather than the others'
  const none = buildMultiRun({ runs: listRows, queue: [], snapshotRuns, details: {}, executors: [], focusId: "run_b", quiet: false });
  expect(none.queue).toEqual([]);
});

test("quiet mode hides informational items and background runs, and counts what it hides", () => {
  const m = model({ quiet: true });
  expect(m.queue.map(q => q.runId)).toEqual(["run_a", "run_b"]);
  expect(m.lines.map(l => l.letter)).toEqual(["A", "B"]);
  expect(m.hidden).toEqual({ focus: 0, quietRuns: 1, quietItems: 0, quietBackgroundItems: 1 });
  // a normal-priority informational item is hidden too, and counted apart from background
  const info = buildMultiRun({ runs: listRows, queue: queue.map(q => q.question.id === "q_b" ? { ...q, item: { ...q.item, unblocks: "nothing" as const } } : q), snapshotRuns, details: {}, executors, focusId: null, quiet: true });
  expect(info.queue.map(q => q.runId)).toEqual(["run_a"]);
  expect(info.hidden).toMatchObject({ quietItems: 1, quietBackgroundItems: 1 });
  expect(info.lines.map(l => l.letter)).toEqual(["A", "B"]);       // B's line stays: only its informational item is hidden
  // off by default, and it combines with focus
  expect(model().hidden).toEqual({ focus: 0, quietRuns: 0, quietItems: 0, quietBackgroundItems: 0 });
  expect(model({ quiet: true, focusId: "run_c" })).toMatchObject({ queue: [], lines: [], hidden: { focus: 2, quietRuns: 1, quietBackgroundItems: 1 } });
});

test("since you last looked: the orchestrator's stored summary, with its time, per run", () => {
  expect(summaryOf({ summary: "  Two reviewers finished.  ", summaryAt: 990 })).toEqual({ text: "Two reviewers finished.", at: 990 });
  expect(summaryOf({ summary: "   " })).toBeNull();
  expect(summaryOf({})).toBeNull();
  expect(summaryOf(null)).toBeNull();
  const m = model({ details: { run_a: { id: "run_a", run: { summary: "Spec drafted; waiting on you.", summaryAt: 900 }, steps: [], questions: [], decisions: [], loading: false, error: null, stamp: 1 } } });
  expect(m.lines.find(l => l.id === "run_a")!.summary).toEqual({ text: "Spec drafted; waiting on you.", at: 900 });
  expect(m.lines.find(l => l.id === "run_b")!.summary).toBeNull();
});

test("the shared executor bench lists each executor in the dispatcher's words with its slots", () => {
  const m = model();
  expect(m.bench.map(b => [b.id, b.state, b.tone, b.slots])).toEqual([
    ["oc-glm", "Busy", "info", { used: 2, max: 3 }],
    ["codex", "Ready", "good", { used: 0, max: 2 }],
    ["claude-code", "Out of quota", "bad", { used: 0, max: 1 }],
  ]);
  expect(m.capacity).toEqual({ used: 2, max: 6 });
  const none = buildMultiRun({ runs: [], queue: [], snapshotRuns: undefined, details: {}, executors: undefined, focusId: null, quiet: false });
  expect(none.bench).toEqual([]);
  expect(none.capacity).toBeNull();
});

test("step counts for a run the snapshot no longer lists come from its own step rows: latest attempt per step and branch", () => {
  const steps = [
    { stepId: "a", attempt: 1, status: "failed" }, { stepId: "a", attempt: 2, status: "done" },
    { stepId: "review", attempt: 1, branch: "ux", status: "running" }, { stepId: "review", attempt: 1, branch: "arch", status: "done" },
    { stepId: "plan", attempt: 1, status: "waiting" }, { stepId: "x", attempt: 1, status: "stopped" }, { nope: true }, "junk",
  ];
  expect(countsFromSteps(steps)).toEqual({ running: 1, waiting: 1, done: 2, failed: 0 });
  expect(countsFromSteps(undefined)).toEqual({ running: 0, waiting: 0, done: 0, failed: 0 });
  const m = model({ snapshotRuns: [], details: { run_b: { id: "run_b", run: {}, steps, questions: [], decisions: [], loading: false, error: null, stamp: 1 } } });
  expect(m.lines.find(l => l.id === "run_b")!.counts).toEqual({ running: 1, waiting: 1, done: 2, failed: 0 });
  // the snapshot still wins when it lists the run
  expect(model({ details: { run_b: { id: "run_b", run: {}, steps, questions: [], decisions: [], loading: false, error: null, stamp: 1 } } }).lines.find(l => l.id === "run_b")!.counts).toEqual({ running: 3, waiting: 1, done: 4, failed: 0 });
});
