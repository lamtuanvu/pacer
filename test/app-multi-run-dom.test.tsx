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
    { id: "run_child", workflow: "fixture/plan", title: "Generated plan", status: "running", priority: "normal", createdAt: 997_000, parentRunId: "run_a" },
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
    // (the generated child run is read with its parent's detail, and is never a line of its own)
    expect(calls.ops.filter(c => c.op === "run.get").map(c => (c.params as { id: string }).id).filter(id => id !== "run_child").sort()).toEqual(["run_a", "run_b", "run_c"]);
    expect(runIds(dom.container)).not.toContain("run_child");
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
    expect(domText(dom.container)).toContain("2 of 6 slots are in use.");
  } finally { await done(dom); }
});

test("links go to each run's Live board, journey replay and run view", async () => {
  const { dom } = await open();
  try {
    const hrefs = all(row(dom.container, "data-run", "run_b")).filter(n => n.tagName === "a").map(n => [text(n), attr(n, "href")]);
    expect(hrefs).toEqual([["Live board", "#/live/run_b"], ["Replay journey", "#/live/run_b/journey"], ["Run view", "#/runs/run_b"]]);
    // identical visible words are told apart for screen readers by the run's letter
    const names = all(row(dom.container, "data-run", "run_b")).filter(n => n.tagName === "a").map(n => attr(n, "aria-label"));
    expect(names).toEqual(["Live board of run B", "Replay journey of run B", "Run view of run B"]);
    const answers = all(dom.container as Node).filter(n => n.tagName === "button" && /^Answer the question/.test(attr(n, "aria-label") ?? "")).map(n => attr(n, "aria-label"));
    expect(answers.map(a => a!.split(": ")[0])).toEqual(["Answer the question from run A", "Answer the question from run B", "Answer the question from run C"]);
    expect(answers[0]).toBe("Answer the question from run A: Approve the brainstormed spec?");
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
    expect(domText(first.dom.container)).not.toContain("service down");
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

test("overlapping loads: a slow older list never overwrites a newer one", async () => {
  const dom = installDom();
  const calls: Calls = { ops: [] };
  let n = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const api = apiFor(fixture, calls, {
    "run.get": p => details[(p as { id: string }).id] ?? details.run_a,
    "run.list": async () => { n++; if (n === 1) { await gate; return [...(fixture.list ?? []), { id: "run_z", workflow: "pacer-dev/feature", title: "Stale zombie run", status: "running", priority: "normal", createdAt: 990_000 }]; } return fixture.list; },
  });
  const base = stateFor(fixture, ALL_OPS);
  const stateAt = (bump: number) => ({ ...base, snapshot: { ...base.snapshot!, runs: snapshotRuns, attention, executors } as never, invalidations: { ...base.invalidations, runs: bump } });
  const render = (bump: number) => mount(dom, <TaskContext.Provider value={{ state: stateAt(bump), api }}><MultiRun query={query} /></TaskContext.Provider>);
  try {
    await render(0);                                   // load #1 starts and is held
    await until(() => n >= 1, 2000);
    await render(1);                                   // an invalidation starts load #2, which is fast and newest
    await until(() => domText(dom.container).includes("Executor bench"), 3000);
    await act(async () => { await tick(); });
    release();                                         // the old response now arrives
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(domText(dom.container)).not.toContain("Stale zombie run");
    expect(n).toBeGreaterThanOrEqual(2);
  } finally { await unmount(dom); dom.restore(); }
});

test("a row without a title is named by its letter, never by its run id; an unread summary says so", async () => {
  const { dom } = await open({
    "run.list": () => [{ id: "run_untitled_9c", workflow: "", status: "running", priority: "normal", createdAt: 999_000 }],
    "run.get": () => { throw new ApiError("internal", "raw detail"); },
  }, ALL_OPS, { runs: [], attention: [] });
  try {
    const line = text(row(dom.container, "data-run", "run_untitled_9c"));
    expect(line).toMatch(/Run [A-Z]/);
    expect(line).toContain("The summary couldn't be loaded.");
    expect(domText(dom.container)).not.toContain("run_untitled_9c");
    expect(domText(dom.container)).not.toContain("raw detail");
  } finally { await done(dom); }
});

test("while the first list read is in flight the page says loading, not that there are no runs", async () => {
  const dom = installDom();
  const calls: Calls = { ops: [] };
  const api = apiFor(fixture, calls, { "run.list": () => new Promise(() => {}) });
  try {
    await mount(dom, <TaskContext.Provider value={{ state: stateFor(fixture, ALL_OPS), api }}><MultiRun query={query} /></TaskContext.Provider>);
    expect(domText(dom.container)).toContain("Loading runs…");
    expect(domText(dom.container)).not.toContain("No runs yet");
  } finally { await unmount(dom); dom.restore(); }
});

test("a run whose detail was never read claims neither steps nor a summary", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `run_m${i}`, workflow: "pacer-dev/feature", title: `Run number ${i}`, status: "done", priority: "normal", createdAt: 990_000 - i }));
  const { dom, calls } = await open({ "run.list": () => many, "run.get": p => ({ run: run((p as { id: string }).id, "read"), steps: [] }) }, ALL_OPS, { runs: [], attention: [] });
  try {
    expect(calls.ops.filter(c => c.op === "run.get")).toHaveLength(8);
    const unread = text(row(dom.container, "data-run", "run_m9"));
    expect(unread).toContain("Not loaded.");
    expect(unread).not.toContain("No steps yet");
    expect(unread).not.toContain("No summary yet.");
    const read = text(row(dom.container, "data-run", "run_m0"));
    expect(read).toContain("No steps yet");
    expect(read).toContain("No summary yet.");
  } finally { await done(dom); }
});

test("two questions from one run have different Answer button names", async () => {
  const second = { ...attention[0]!, id: "attn_extra", question: { ...attention[0]!.question!, id: "q_a2", text: "And the colour?" } };
  const { dom } = await open({}, ALL_OPS, { attention: [attention[0]!, second] });
  try {
    const names = all(dom.container as Node).filter(n => n.tagName === "button" && (attr(n, "aria-label") ?? "").startsWith("Answer the question")).map(n => attr(n, "aria-label"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  } finally { await done(dom); }
});

test("Try again moves focus to the page title once the list reads, even when a run's detail still fails", async () => {
  let fail = true;
  const { dom } = await open({ "run.list": () => { if (fail) throw new ApiError("internal", "raw"); return fixture.list; }, "run.get": () => { throw new ApiError("internal", "raw detail"); } }, ALL_OPS, { runs: [], attention: [] });
  try {
    fail = false;
    const again = button(dom.container as Node, "Try again");
    await act(async () => { (again as unknown as { focus(): void }).focus(); (again as unknown as { click(): void }).click(); });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(text((dom.doc as unknown as { activeElement: Node }).activeElement)).toBe("Several runs");
  } finally { await done(dom); }
});

/** Mounts the board with controllable refreshes. */
async function controlled(handlers: Parameters<typeof apiFor>[2]) {
  const dom = installDom();
  const calls: Calls = { ops: [] };
  const api = apiFor(fixture, calls, handlers);
  const base = stateFor(fixture, ALL_OPS);
  const tree = (revision: number) => <TaskContext.Provider value={{ state: { ...base, snapshot: { ...base.snapshot!, runs: [], attention: [] } as never, invalidations: { ...base.invalidations, runs: revision } }, api }}><MultiRun query={query} /></TaskContext.Provider>;
  await mount(dom, tree(0));
  return { dom, calls, tree };
}
const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
const gets = (calls: Calls) => calls.ops.filter(c => c.op === "run.get").map(c => (c.params as { id: string }).id);
const one = [{ id: "run_a", workflow: "w", title: "Alpha", status: "running", priority: "normal", createdAt: 2 }, { id: "run_b", workflow: "w", title: "Beta", status: "running", priority: "normal", createdAt: 1 }];

test("details are read one after another, in order, and each is shown as it arrives", async () => {
  let release: () => void = () => {};
  const { dom, calls } = await controlled({ "run.list": () => one, "run.get": async p => {
    const id = (p as { id: string }).id;
    if (id === "run_b") await new Promise<void>(r => { release = r; });
    return { run: run(id, id, { summary: `summary of ${id}` }), steps: [] };
  } });
  try {
    await wait();
    expect(gets(calls)).toEqual(["run_a", "run_b"]);
    expect(domText(dom.container)).toContain("summary of run_a");
    expect(domText(dom.container)).not.toContain("summary of run_b");
    await act(async () => { release(); });
    await wait();
    expect(domText(dom.container)).toContain("summary of run_b");
  } finally { await unmount(dom); dom.restore(); }
});

test("an older load skips a run a newer load already brought, and never overwrites it", async () => {
  let n = 0;
  let release: () => void = () => {};
  const { dom, calls, tree } = await controlled({ "run.list": () => one, "run.get": async p => {
    const id = (p as { id: string }).id;
    const mine = ++n;
    if (mine === 1) { await new Promise<void>(r => { release = r; }); return { run: run(id, id, { summary: "OLD answer" }), steps: [] }; }
    return { run: run(id, id, { summary: `NEW ${id}` }), steps: [] };
  } });
  try {
    await wait();
    await mount(dom, tree(1));
    await wait();
    expect(domText(dom.container)).toContain("NEW run_a");
    await act(async () => { release(); });
    await wait();
    expect(domText(dom.container)).toContain("NEW run_a");
    expect(domText(dom.container)).not.toContain("OLD answer");
    // the first load's turn for run_b is skipped: one held read, then two from the newer load
    expect(gets(calls)).toEqual(["run_a", "run_a", "run_b"]);
  } finally { await unmount(dom); dom.restore(); }
});

test("leaving the page stops the detail reads", async () => {
  let release: () => void = () => {};
  const { dom, calls } = await controlled({ "run.list": () => one, "run.get": async p => { await new Promise<void>(r => { release = r; }); return { run: run((p as { id: string }).id, "x"), steps: [] }; } });
  try {
    await wait();
    await unmount(dom);
    release();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(gets(calls)).toEqual(["run_a"]);
  } finally { dom.restore(); }
});

test("a detail that fails says so on that run only", async () => {
  const { dom } = await controlled({ "run.list": () => one, "run.get": p => { if ((p as { id: string }).id === "run_a") throw new ApiError("internal", "raw"); return { run: run("run_b", "Beta", { summary: "fine" }), steps: [] }; } });
  try {
    await wait();
    expect(text(row(dom.container, "data-run", "run_a"))).toContain("The summary couldn't be loaded.");
    expect(text(row(dom.container, "data-run", "run_b"))).toContain("fine");
  } finally { await unmount(dom); dom.restore(); }
});
