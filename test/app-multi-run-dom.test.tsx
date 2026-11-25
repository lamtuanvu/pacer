/** DOM tests for the several-runs board (board 8) with three fixture runs. Each test asserts on rendered text and the calls made. */
import { expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { ApiError } from "../app/src/data/api";
import { TaskContext } from "../app/src/screens/task-shared";
import { MultiRun } from "../app/src/screens/runs/MultiRun";
import { domText, installDom, mount, tick, until, unmount } from "./app-setup-health-dom";
import { ALL_OPS, apiFor, stateFor, type Calls, type Fixture } from "./app-run-view-fixtures";
import { attention, executors, runA, runB, runC, snapshotRuns } from "./app-multi-run-fixtures";

const query = { repo: null, scope: null };
type Node = { childNodes?: Node[]; nodeType: number; tagName?: string; data?: string; value?: string; attrs?: Record<string, string>; l?: Record<string, (e: unknown) => void>; _listeners?: Record<string, (e: unknown) => void>; getAttribute?: (n: string) => string | null };
function all(root: Node): Node[] { const out: Node[] = []; const walk = (n: Node) => { if (n.nodeType === 1) out.push(n); for (const c of n.childNodes ?? []) walk(c); }; walk(root); return out; }
const text = (n: Node): string => n.nodeType === 3 ? String(n.data ?? "") : (n.childNodes ?? []).map(text).join("");
const attr = (n: Node, name: string) => n.getAttribute?.(name) ?? null;
const must = <T,>(v: T | undefined, what: string): T => { if (v === undefined) throw new Error(`missing ${what}`); return v; };
function fire(node: Node, type: string, props: Record<string, unknown> = {}) {
  const ev = { type, bubbles: true, cancelable: true, defaultPrevented: false, target: node, currentTarget: node, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, ...props };
  const slots = node.l ?? {};
  const key = Object.keys(slots).find(k => k.toLowerCase() === `${type}false` || k.toLowerCase() === `${type}true` || k.toLowerCase() === type);
  (key ? slots[key] : node._listeners?.[type])?.call(node, ev);
}
const within = (root: Node, pred: (n: Node) => boolean) => must(all(root).find(pred), "element");
const button = (root: Node, label: string) => within(root, n => n.tagName === "button" && text(n).trim() === label);
const click = async (root: Node, label: string) => { await act(async () => { (button(root, label) as unknown as { click(): void }).click(); }); };
const row = (root: unknown, name: string, id: string) => within(root as Node, n => attr(n, name) === id);
const queueIds = (root: unknown) => all(root as Node).filter(n => attr(n, "data-queue") !== null).map(n => attr(n, "data-queue")!);
const runIds = (root: unknown) => all(root as Node).filter(n => attr(n, "data-run") !== null).map(n => attr(n, "data-run")!);

const run = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, workflow: "pacer-dev/feature", version: 1, title, status: "running", priority: "normal", rev: 1, createdAt: 1000, updatedAt: 1100, orchestrator: { state: "idle" }, ...over });
const details: Record<string, Record<string, unknown>> = {
  run_a: { run: run("run_a", runA.title, { status: "waiting", priority: "urgent", summary: "Spec drafted; waiting on your approval.", summaryAt: 999_500 }), steps: [] },
  run_b: { run: run("run_b", runB.title), steps: [] },
  run_c: { run: run("run_c", runC.title, { priority: "background" }), steps: [] },
};
const fixture: Fixture = {
  id: "run_a",
  get: { run: details.run_a!.run as Record<string, unknown>, steps: [] },
  list: [
    { id: "run_a", workflow: "pacer-dev/feature", title: runA.title, status: "waiting", priority: "urgent", createdAt: 996_400 },
    { id: "run_b", workflow: "pacer-dev/feature", title: runB.title, status: "running", priority: "normal", createdAt: 998_200 },
    { id: "run_c", workflow: "pacer-dev/feature", title: runC.title, status: "running", priority: "background", createdAt: 992_800 },
  ],
};

async function open(handlers: Parameters<typeof apiFor>[2] = {}, ops = ALL_OPS, snapshotOver: Record<string, unknown> = {}) {
  const dom = installDom();
  const calls: Calls = { ops: [] };
  const api = apiFor(fixture, calls, { "run.get": p => details[(p as { id: string }).id] ?? details.run_a, ...handlers });
  const base = stateFor(fixture, ops);
  const state = { ...base, snapshot: { ...base.snapshot!, runs: snapshotRuns, attention, executors, ...snapshotOver } as never };
  await mount(dom, <TaskContext.Provider value={{ state, api }}><MultiRun query={query} /></TaskContext.Provider>);
  await until(() => domText(dom.container).includes("Executor bench") || domText(dom.container).includes("Couldn't load") || domText(dom.container).includes("unavailable") || domText(dom.container).includes("No runs yet"), 3000);
  await act(async () => { await tick(); });
  await new Promise(resolve => setTimeout(resolve, 150));
  return { dom, calls };
}
const done = async (dom: Awaited<ReturnType<typeof open>>["dom"]) => { await unmount(dom); dom.restore(); };

test("one queue across three runs, most blocking first, each question marked with its run's fixed letter and what it unblocks", async () => {
  const { dom } = await open();
  try {
    expect(queueIds(dom.container)).toEqual(["q_a", "q_b", "q_c"]);
    const a = text(row(dom.container, "data-queue", "q_a"));
    expect(a).toContain("Approve the brainstormed spec?");
    expect(a).toContain("Stops the run");
    expect(a).toContain("Add the Runs board");
    expect(text(row(dom.container, "data-queue", "q_b"))).toContain("Stops a branch");
    expect(text(row(dom.container, "data-queue", "q_c"))).toContain("Informational");
    const letters = all(row(dom.container, "data-queue", "q_b")).filter(n => attr(n, "role") === "img").map(n => attr(n, "aria-label"));
    expect(letters).toEqual(["Run B"]);
    expect(attr(row(dom.container, "data-queue", "q_b"), "class")).toContain("mr-tone-2");
  } finally { await done(dom); }
});

test("each run is a line with its letter, status words, step counts and a text summary of the bar", async () => {
  const { dom } = await open();
  try {
    expect(runIds(dom.container)).toEqual(["run_a", "run_b", "run_c"]);
    const b = row(dom.container, "data-run", "run_b");
    expect(text(b)).toContain("Running");
    expect(text(b)).toContain("4 done · 3 running · 1 waiting");
    expect(text(b)).toContain("Normal priority");
    const bar = within(b, n => n.tagName === "svg" && attr(n, "role") === "img");
    expect(attr(bar, "aria-label")).toBe("Run B: 4 done · 3 running · 1 waiting");
    // segment widths follow the counts: 4 + 3 + 1 of 8
    const widths = all(bar).filter(n => n.tagName === "rect").map(n => Number(attr(n, "width")));
    expect(widths).toEqual([50, 37.5, 12.5]);
    expect(text(row(dom.container, "data-run", "run_a"))).toContain("Waits on You");
    expect(attr(row(dom.container, "data-run", "run_c"), "class")).toContain("mr-tone-3");
  } finally { await done(dom); }
});

test("since you last looked: the orchestrator's summary where one exists, an honest line where not", async () => {
  const { dom, calls } = await open();
  try {
    expect(text(row(dom.container, "data-run", "run_a"))).toContain("Since you last looked: Spec drafted; waiting on your approval.");
    expect(text(row(dom.container, "data-run", "run_a"))).toContain("written 8m ago");
    expect(text(row(dom.container, "data-run", "run_b"))).toContain("Since you last looked: No summary yet.");
    // the summary comes from run.get, once per live run
    expect(calls.ops.filter(c => c.op === "run.get").map(c => (c.params as { id: string }).id).sort()).toEqual(["run_a", "run_b", "run_c"]);
  } finally { await done(dom); }
});

test("answering from the queue uses the shared form, sends expect_rev, reloads and returns focus to the queue", async () => {
  const { dom, calls } = await open();
  try {
    expect(domText(dom.container)).not.toContain("Submit answer");
    await click(dom.container as Node, "Answer");        // the first row is q_a
    const open1 = all(dom.container as Node).filter(n => n.tagName === "button" && text(n).trim() === "Answer").map(n => attr(n, "aria-expanded"));
    expect(open1).toEqual(["true", "false", "false"]);
    expect(domText(dom.container)).toContain("Submit answer");
    const radio = within(dom.container as Node, n => n.tagName === "input" && attr(n, "type") === "radio" && attr(n, "value") === "approve");
    await act(async () => { fire(radio, "change"); });
    await tick();
    const gets = calls.ops.filter(c => c.op === "run.list").length;
    await act(async () => { fire(within(dom.container as Node, n => n.tagName === "form" && text(n).includes("Submit answer")), "submit"); });
    await until(() => calls.ops.some(c => c.op === "question.answer"), 2000);
    expect(calls.ops.find(c => c.op === "question.answer")!.params).toEqual({ id: "q_a", answer: "approve", expect_rev: 1 });
    await until(() => calls.ops.filter(c => c.op === "run.list").length > gets, 2000);
    await until(() => domText(dom.container).includes("Answer submitted"), 2000);
    await tick();
    const active = (dom.doc as unknown as { activeElement: Node | null }).activeElement;
    expect(active && text(active)).toBe("Needs you");
  } finally { await done(dom); }
});

test("a stale answer on the queue shows the conflict and reloads", async () => {
  const { dom, calls } = await open({ "question.answer": () => { throw new ApiError("conflict", "stale"); } });
  try {
    await click(dom.container as Node, "Answer");
    await act(async () => { fire(within(dom.container as Node, n => n.tagName === "input" && attr(n, "type") === "radio" && attr(n, "value") === "approve"), "change"); });
    await tick();
    const before = calls.ops.filter(c => c.op === "run.list").length;
    await act(async () => { fire(within(dom.container as Node, n => n.tagName === "form" && text(n).includes("Submit answer")), "submit"); });
    await until(() => domText(dom.container).includes("This question changed"), 2000);
    expect(calls.ops.filter(c => c.op === "run.list").length).toBe(before);       // nothing reloads until the person asks
    await click(dom.container as Node, "Reload");
    await until(() => calls.ops.filter(c => c.op === "run.list").length > before, 2000);
    await until(() => domText(dom.container).includes("This question changed. Showing the latest version."), 2000);
  } finally { await done(dom); }
});

test("focus mode keeps one run and its questions, says what it hides, and Show all brings the rest back", async () => {
  const { dom } = await open();
  try {
    await click(dom.container as Node, "Focus on B");
    expect(queueIds(dom.container)).toEqual(["q_b"]);
    expect(runIds(dom.container)).toEqual(["run_b"]);
    expect(domText(dom.container)).toContain("Focused on run B. 2 other runs are hidden.");
    expect(attr(button(dom.container as Node, "Focus on B"), "aria-pressed")).toBe("true");
    await click(dom.container as Node, "Show all runs");
    expect(queueIds(dom.container)).toEqual(["q_a", "q_b", "q_c"]);
    expect(runIds(dom.container)).toEqual(["run_a", "run_b", "run_c"]);
    expect(domText(dom.container)).not.toContain("Focused on run");
  } finally { await done(dom); }
});

test("quiet mode hides informational questions and background runs, counts them, and turning it off restores them", async () => {
  const { dom } = await open();
  try {
    const toggle = within(dom.container as Node, n => n.tagName === "input" && attr(n, "role") === "switch");
    expect(attr(toggle, "aria-checked")).toBe("false");
    toggle.value = "on";
    (toggle as unknown as { checked: boolean }).checked = true;
    await act(async () => { fire(toggle, "change"); });
    expect(queueIds(dom.container)).toEqual(["q_a", "q_b"]);
    expect(runIds(dom.container)).toEqual(["run_a", "run_b"]);
    expect(domText(dom.container)).toContain("Quiet mode is hiding 1 question from background runs, 1 background run.");
    expect(attr(toggle, "aria-checked")).toBe("true");
    (toggle as unknown as { checked: boolean }).checked = false;
    await act(async () => { fire(toggle, "change"); });
    expect(queueIds(dom.container)).toEqual(["q_a", "q_b", "q_c"]);
    expect(domText(dom.container)).not.toContain("Quiet mode is hiding");
  } finally { await done(dom); }
});

test("the shared executor bench shows each executor's state in words with its slots", async () => {
  const { dom } = await open();
  try {
    const glm = text(row(dom.container, "data-executor", "oc-glm"));
    expect(glm).toContain("Busy");
    expect(glm).toContain("2 of 3 slots in use");
    expect(text(row(dom.container, "data-executor", "codex"))).toContain("Ready");
    expect(text(row(dom.container, "data-executor", "claude-code"))).toContain("Out of quota");
  } finally { await done(dom); }
});

test("links go to each run's Live board, journey replay and run view", async () => {
  const { dom } = await open();
  try {
    const hrefs = all(row(dom.container, "data-run", "run_b")).filter(n => n.tagName === "a").map(n => [text(n), attr(n, "href")]);
    expect(hrefs).toEqual([["Live board", "#/live/run_b"], ["Replay journey", "#/live/run_b/journey"], ["Run view", "#/runs/run_b"]]);
  } finally { await done(dom); }
});

test("without run.list the board says runs are unavailable; with no runs it says so", async () => {
  const off = await open({}, ALL_OPS.filter(o => o !== "run.list"));
  try { expect(domText(off.dom.container)).toContain("Runs unavailable."); expect(queueIds(off.dom.container)).toEqual([]); } finally { await done(off.dom); }
  const none = await open({ "run.list": () => [] }, ALL_OPS, { runs: [], attention: [] });
  try { expect(domText(none.dom.container)).toContain("No runs yet"); } finally { await done(none.dom); }
});

test("a failed list load with nothing to show says so and offers Try again; with data it keeps it and warns", async () => {
  let fail = true;
  const first = await open({ "run.list": () => { if (fail) throw new ApiError("internal", "service down"); return fixture.list; } }, ALL_OPS, { runs: [], attention: [] });
  try {
    expect(domText(first.dom.container)).toContain("Couldn't load runs");
    expect(domText(first.dom.container)).toContain("service down");
    fail = false;
    await act(async () => { (button(first.dom.container as Node, "Try again") as unknown as { click(): void }).click(); });
    await until(() => domText(first.dom.container).includes("Executor bench"), 2000);
  } finally { await done(first.dom); }
  fail = false;
  const second = await open({ "run.list": () => { if (fail) throw new ApiError("internal", "service down"); return fixture.list; } });
  try {
    expect(domText(second.dom.container)).not.toContain("may be out of date");
    fail = true;
    await act(async () => { fire(within(second.dom.container as Node, n => n.tagName === "input" && attr(n, "role") === "switch"), "change"); });
    // a refresh now fails: trigger one through answering conflict-free reload
    await click(second.dom.container as Node, "Answer");
    await act(async () => { fire(within(second.dom.container as Node, n => n.tagName === "input" && attr(n, "type") === "radio" && attr(n, "value") === "approve"), "change"); });
    await tick();
    await act(async () => { fire(within(second.dom.container as Node, n => n.tagName === "form" && text(n).includes("Submit answer")), "submit"); });
    await until(() => domText(second.dom.container).includes("These runs may be out of date"), 3000);
    expect(queueIds(second.dom.container).length).toBeGreaterThan(0);
  } finally { await done(second.dom); }
});
