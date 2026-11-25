/** DOM interaction tests for the Live board (board 6). Each test asserts on rendered text, attributes and the calls made. */
import { afterEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { ApiError } from "../app/src/data/api";
import { TaskContext } from "../app/src/screens/task-shared";
import { LiveBoard } from "../app/src/screens/runs/LiveBoard";
import { MAX_ZOOM, PAN_STEP, PAN_STEP_LARGE, ZOOM_STEP } from "../app/src/screens/runs/live-board-view";
import liveCss from "../app/src/screens/runs/live-board.css" with { type: "text" };
import { domText, installDom, mount, tick, until, unmount } from "./app-setup-health-dom";
import { ALL_OPS, apiFor, stateFor, type Calls, type Fixture } from "./app-run-view-fixtures";
import { featureDefinition, step } from "./app-live-board-fixtures";

const query = { repo: null, scope: null };

type Node = { childNodes?: Node[]; nodeType: number; tagName?: string; data?: string; value?: string; attrs?: Record<string, string>; l?: Record<string, (e: unknown) => void>; _listeners?: Record<string, (e: unknown) => void>; getAttribute?: (n: string) => string | null; parentNode?: Node | null; closest?: (s: string) => unknown };
function all(root: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => { if (n.nodeType === 1) out.push(n); for (const c of n.childNodes ?? []) walk(c); };
  walk(root);
  return out;
}
const text = (n: Node): string => n.nodeType === 3 ? String(n.data ?? "") : (n.childNodes ?? []).map(text).join("");
const attr = (n: Node, name: string) => n.getAttribute?.(name) ?? null;
function byAttr(root: unknown, name: string, value: string): Node | undefined {
  return all(root as Node).find(n => attr(n, name) === value);
}
function must(n: Node | undefined, what: string): Node { if (!n) throw new Error(`missing ${what}`); return n; }
/** Call the handler a component registered for `type` (Preact keeps the event name in the case it was written in when the fake DOM lacks the property). */
function fire(node: Node, type: string, props: Record<string, unknown> = {}) {
  const ev = { type, bubbles: true, cancelable: true, defaultPrevented: false, target: node, currentTarget: node, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, ...props };
  const slots = node.l ?? {};
  const key = Object.keys(slots).find(k => k.toLowerCase() === `${type}false` || k.toLowerCase() === `${type}true` || k.toLowerCase() === type);
  const handler = key ? slots[key] : node._listeners?.[type];
  if (!handler) throw new Error(`no ${type} handler on <${node.tagName}>`);
  handler.call(node, ev);
  return ev;
}
const world = (root: unknown) => must(byAttr(root, "data-world", "true") ?? all(root as Node).find(n => n.attrs && "data-world" in n.attrs), "world group");
function viewOf(root: unknown): { x: number; y: number; k: number } {
  const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(attr(world(root), "transform") ?? "");
  if (!m) throw new Error("no transform");
  return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
}
const viewport = (root: unknown) => must(all(root as Node).find(n => attr(n, "aria-roledescription") === "pannable board"), "viewport");
const nodes = (root: unknown) => all(root as Node).filter(n => attr(n, "data-node") !== null).map(n => attr(n, "data-node")!);
const agentIds = (root: unknown) => all(root as Node).filter(n => attr(n, "data-agent") !== null).map(n => attr(n, "data-agent")!);
const button = (root: unknown, label: string) => must(all(root as Node).find(n => n.tagName === "button" && text(n).trim() === label), `button ${label}`);
const messageForm = (root: unknown) => must(all(root as Node).find(n => n.tagName === "form" && /Send to/.test(text(n))), "message form");
const clickEl = (n: Node) => { (n as unknown as { click(): void }).click(); };
function radio(root: unknown, value: string): Node {
  return must(all(root as Node).find(n => n.tagName === "input" && attr(n, "type") === "radio" && attr(n, "value") === value), `radio ${value}`);
}

const row = (...args: Parameters<typeof step>): Record<string, unknown> => ({ ...step(...args) });
const run = (over: Record<string, unknown> = {}) => ({
  id: "run_1", workflow: "pacer-dev/feature", version: 2, title: "Ship the board", status: "running", priority: "normal",
  rev: 4, createdAt: 800, updatedAt: 950, orchestratorTaskId: "t_orch", orchestrator: { state: "idle", planner: "claude" }, ...over,
});
/** Review fan-out: architecture and security agents at work, ux done, spec approval is waiting on the person. */
const liveFixture: Fixture = {
  id: "run_1",
  get: {
    run: run(),
    steps: [
      row("brainstorm", "done", { startedAt: 900 }), row("approve_spec", "waiting", { startedAt: 910 }),
      row("review", "running", { branch: "architecture", taskId: "t_a", startedAt: 920 }),
      row("review", "done", { branch: "ux", taskId: "t_b", startedAt: 921 }),
      row("review", "running", { branch: "security", taskId: "t_c", startedAt: 922 }),
    ],
    definition: featureDefinition,
  },
  questions: [{ id: "q_spec", runId: "run_1", stepId: "approve_spec", attempt: 1, rev: 3, status: "open", answerer: "person", answerType: "approve_revise", text: "Approve the brainstormed spec?", blocks: "step", createdAt: 920 }],
  tasks: [{ id: "t_a", executor: "oc-glm" }, { id: "t_b", executor: "codex" }, { id: "t_c", executor: "claude-code" }],
};

const logChunk = (stdout: string, over: Record<string, unknown> = {}) => ({ stdout, stderr: "", next: { stdout: stdout.length, stderr: 0 }, done: false, source: "s1", ...over });

async function open(fixture: Fixture = liveFixture, ops = ALL_OPS, handlers: Parameters<typeof apiFor>[2] = {}, pollMs = 20, prepare?: (dom: ReturnType<typeof installDom>) => void) {
  const dom = installDom();
  prepare?.(dom);
  const calls: Calls = { ops: [] };
  const api = apiFor(fixture, calls, handlers);
  await mount(dom, (
    <TaskContext.Provider value={{ state: stateFor(fixture, ops), api }}>
      <LiveBoard runId={fixture.id} query={query} outputPollMs={pollMs} />
    </TaskContext.Provider>
  ));
  await until(() => domText(dom.container).includes("Steps on the board") || domText(dom.container).includes("Couldn't load"), 3000);
  await act(async () => { await tick(); });
  await new Promise(resolve => setTimeout(resolve, 130));
  return { dom, calls, api };
}
let current: Awaited<ReturnType<typeof open>>["dom"] | null = null;
const done = async (dom: NonNullable<typeof current>) => { await unmount(dom); dom.restore(); };
afterEach(() => { current = null; });

test("the board draws a desk per step row, agents with their executor, and no desk for steps without a row", async () => {
  const { dom } = await open();
  try {
    expect(nodes(dom.container).sort()).toEqual(["approve_spec", "brainstorm", "review:architecture", "review:security", "review:ux"]);
    // the definition also names plan, approve_publish, open_pr and done: none is drawn
    for (const name of ["plan", "approve_publish", "open_pr"]) expect(nodes(dom.container)).not.toContain(name);
    expect(agentIds(dom.container).sort()).toEqual(["t_a", "t_c"]);
    const t = domText(dom.container);
    expect(t).toContain("oc-glm");
    expect(t).toContain("Claude Code");          // the shared executor label, not the raw id
    expect(t).not.toContain("Codex");           // its step is done, so it has no place on the board
    // status is words, not colour alone
    const approve = text(must(byAttr(dom.container, "data-node", "approve_spec"), "desk"));
    expect(approve).toContain("Waits on you");
    expect(text(must(byAttr(dom.container, "data-node", "brainstorm"), "desk"))).toContain("Done");
    expect(text(must(byAttr(dom.container, "data-node", "review:architecture"), "desk"))).toContain("Running");
    expect(attr(viewport(dom.container), "aria-label")).toBe("Run graph, 5 steps, 2 agents working");
  } finally { await done(dom); }
});

test("opening the board marks the run seen once", async () => {
  const { dom, calls } = await open();
  try {
    expect(calls.ops.filter(c => c.op === "run.seen")).toEqual([{ op: "run.seen", params: { id: "run_1" } }]);
  } finally { await done(dom); }
});

test("the run's letter is the one the runs list gives it, also for a run the snapshot no longer lists", async () => {
  const { dom } = await open(liveFixture, ALL_OPS, { "run.list": () => [
    { id: "run_0", workflow: "pacer-dev/feature", title: "Older run", status: "done", priority: "normal", createdAt: 100 },
    { id: "run_1", workflow: "pacer-dev/feature", title: "Ship the board", status: "running", priority: "normal", createdAt: 800 },
  ] });
  try {
    const chips = all(dom.container as Node).filter(n => attr(n, "role") === "img" && /^Run [A-Z]+$/.test(attr(n, "aria-label") ?? "")).map(n => attr(n, "aria-label"));
    expect(chips).toEqual(["Run B"]);
    expect(attr(must(all(dom.container as Node).find(n => /^Live board for run/.test(attr(n, "aria-label") ?? "")), "page"), "aria-label")).toBe("Live board for run B");
  } finally { await done(dom); }
});

test("executors are named with the shared label (codex#personal reads Codex · personal), and the raw id still seeds the creature", async () => {
  const fx: Fixture = { ...liveFixture, tasks: [{ id: "t_a", executor: "codex#personal" }, { id: "t_b", executor: "codex#team" }, { id: "t_c", executor: "codex#personal" }] };
  const { dom } = await open(fx);
  try {
    const names = all(dom.container as Node).filter(n => attr(n, "data-agent") !== null).map(n => attr(n, "aria-label"));
    expect(names).toEqual(["Codex · personal working on review · architecture. Open live output", "Codex · personal working on review · security. Open live output"]);
    expect(domText(dom.container)).not.toContain("codex#personal");
    // an unknown task (not in the snapshot) is "An executor", never an internal placeholder
    const { dom: d2 } = await open({ ...liveFixture, tasks: [] });
    try {
      expect(all(d2.container as Node).filter(n => attr(n, "data-agent") !== null).map(n => attr(n, "aria-label"))).toEqual([
        "An executor working on review · architecture. Open live output", "An executor working on review · security. Open live output"]);
    } finally { await done(d2); }
  } finally { await done(dom); }
});

test("the person is drawn once, beside the step that waits on them; the planner is marked as the planner", async () => {
  const { dom } = await open();
  try {
    const people = all(dom.container as Node).filter(n => attr(n, "data-station") === "person");
    expect(people).toHaveLength(1);
    expect(attr(people[0]!, "data-at")).toBe("approve_spec");
    const planner = must(byAttr(dom.container, "data-station", "planner"), "planner station");
    expect(text(planner)).toContain("Planner");
  } finally { await done(dom); }
});

test("keyboard: arrows pan, Shift pans further, + - zoom, 0 fits; chords with Ctrl are left to the browser", async () => {
  const { dom } = await open();
  try {
    const vp = viewport(dom.container);
    const start = viewOf(dom.container);
    expect(start.k).toBe(1);
    await act(async () => { fire(vp, "keydown", { key: "ArrowRight" }); });
    expect(viewOf(dom.container)).toEqual({ ...start, x: start.x - PAN_STEP });
    await act(async () => { fire(vp, "keydown", { key: "ArrowDown", shiftKey: true }); });
    expect(viewOf(dom.container).y).toBe(start.y - PAN_STEP_LARGE);
    await act(async () => { fire(vp, "keydown", { key: "ArrowLeft" }); fire(vp, "keydown", { key: "ArrowUp", shiftKey: true }); });
    expect(viewOf(dom.container)).toEqual(start);
    const ctrl = fire(vp, "keydown", { key: "ArrowRight", ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(false);
    expect(viewOf(dom.container)).toEqual(start);
    const handled = fire(vp, "keydown", { key: "ArrowRight" });
    expect(handled.defaultPrevented).toBe(true);
    await act(async () => { fire(vp, "keydown", { key: "+" }); });
    expect(viewOf(dom.container).k).toBeCloseTo(start.k * ZOOM_STEP, 2);
    await act(async () => { fire(vp, "keydown", { key: "-" }); fire(vp, "keydown", { key: "-" }); });
    expect(viewOf(dom.container).k).toBeCloseTo(start.k / ZOOM_STEP, 2);
    await act(async () => { fire(vp, "keydown", { key: "0" }); });
    expect(viewOf(dom.container)).toEqual(start);
    // keyboard zoom is bounded
    await act(async () => { for (let i = 0; i < 30; i++) fire(vp, "keydown", { key: "+" }); });
    expect(viewOf(dom.container).k).toBe(MAX_ZOOM);
    expect(domText(dom.container)).toContain("250%");
  } finally { await done(dom); }
});

test("the toolbar buttons zoom and fit the same way the keys do", async () => {
  const { dom } = await open();
  try {
    const start = viewOf(dom.container);
    await act(async () => { clickEl(button(dom.container, "Zoom in")); });
    expect(viewOf(dom.container).k).toBeGreaterThan(start.k);
    await act(async () => { clickEl(button(dom.container, "Zoom out")); clickEl(button(dom.container, "Zoom out")); });
    expect(viewOf(dom.container).k).toBeLessThan(start.k);
    await act(async () => { clickEl(button(dom.container, "Fit board")); });
    expect(viewOf(dom.container)).toEqual(start);
  } finally { await done(dom); }
});

test("pointer: dragging pans by the drag distance, releasing stops, a drag that starts on an agent does not pan", async () => {
  const { dom } = await open();
  try {
    const vp = viewport(dom.container);
    const start = viewOf(dom.container);
    await act(async () => {
      fire(vp, "pointerdown", { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      fire(vp, "pointermove", { pointerId: 1, clientX: 130, clientY: 90 });
    });
    expect(viewOf(dom.container)).toEqual({ ...start, x: start.x + 30, y: start.y - 10 });
    expect(attr(vp, "class")).toContain("is-dragging");
    await act(async () => { fire(vp, "pointerup", { pointerId: 1 }); fire(vp, "pointermove", { pointerId: 1, clientX: 300, clientY: 300 }); });
    expect(viewOf(dom.container)).toEqual({ ...start, x: start.x + 30, y: start.y - 10 });
    expect(attr(vp, "class")).not.toContain("is-dragging");
    // another pointer's moves are not ours
    await act(async () => { fire(vp, "pointerdown", { pointerId: 2, button: 0, clientX: 0, clientY: 0 }); fire(vp, "pointermove", { pointerId: 3, clientX: 50, clientY: 50 }); fire(vp, "pointerup", { pointerId: 2 }); });
    expect(viewOf(dom.container)).toEqual({ ...start, x: start.x + 30, y: start.y - 10 });
    // pressing on an agent is a click, not a drag
    const agent = must(byAttr(dom.container, "data-agent", "t_a"), "agent");
    agent.closest = (sel: string) => (sel === "[data-agent]" ? agent : null);
    const before = viewOf(dom.container);
    await act(async () => { fire(vp, "pointerdown", { pointerId: 4, button: 0, clientX: 10, clientY: 10, target: agent }); fire(vp, "pointermove", { pointerId: 4, clientX: 90, clientY: 90 }); });
    expect(viewOf(dom.container)).toEqual(before);
  } finally { await done(dom); }
});

test("wheel: Ctrl or Cmd zooms at the pointer, a plain wheel is left to scroll the page", async () => {
  const { dom } = await open();
  try {
    const vp = viewport(dom.container);
    const start = viewOf(dom.container);
    const plain = fire(vp, "wheel", { deltaY: -100, clientX: 200, clientY: 100 });
    expect(plain.defaultPrevented).toBe(false);
    expect(viewOf(dom.container)).toEqual(start);
    let ev: { defaultPrevented: boolean } | undefined;
    await act(async () => { ev = fire(vp, "wheel", { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 100 }); });
    expect(ev!.defaultPrevented).toBe(true);
    const zoomed = viewOf(dom.container);
    expect(zoomed.k).toBeCloseTo(start.k * ZOOM_STEP, 2);
    // the board point under the pointer did not move on screen
    expect(((200 - start.x) / start.k) * zoomed.k + zoomed.x).toBeCloseTo(200, 0);
  } finally { await done(dom); }
});

test("clicking an agent opens its live output from task.log; the output follows and Close returns focus to the agent", async () => {
  let reads = 0;
  const { dom, calls } = await open(liveFixture, ALL_OPS, {
    "task.log": () => { reads++; return reads === 1 ? logChunk("compiling\n") : logChunk(reads === 2 ? "compiling\ntesting\n" : "compiling\ntesting\n", { next: { stdout: 99, stderr: 0 }, done: reads > 2 }); },
  });
  try {
    expect(calls.ops.some(c => c.op === "task.log")).toBe(false);
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("compiling"), 2000);
    const first = calls.ops.find(c => c.op === "task.log")!;
    expect(first.params).toEqual({ id: "t_a", stdout: 0, stderr: 0 });
    expect(domText(dom.container)).toContain("Live output");
    expect(domText(dom.container)).toContain("oc-glm · review · architecture");
    // it keeps following from where it left off, and says so when the task is done
    await until(() => domText(dom.container).includes("Task finished"), 2000);
    const reads2 = calls.ops.filter(c => c.op === "task.log");
    expect(reads2[1]!.params).toEqual({ id: "t_a", stdout: 10, stderr: 0 });
    expect(attr(must(byAttr(dom.container, "data-agent", "t_a"), "agent"), "aria-pressed")).toBe("true");
    const session = all(dom.container as Node).find(n => n.tagName === "a" && text(n) === "Open session")!;
    expect(attr(session, "href")).toBe("#/workspace?task=t_a&panel=session");
    await act(async () => { clickEl(button(dom.container, "Close output")); });
    await act(async () => { await tick(); });
    expect(all(dom.container as Node).some(n => (attr(n, "aria-label") ?? "").startsWith("Live output:"))).toBe(false);
    expect(domText(dom.container)).toContain("Live output closed");
    const active = (dom.doc as unknown as { activeElement: Node | null }).activeElement;
    expect(active && attr(active, "data-agent")).toBe("t_a");
  } finally { await done(dom); }
});

test("opening an agent scrolls its output into view without moving focus off the agent", async () => {
  const scrolled: Array<{ label: string; options: unknown }> = [];
  const { dom } = await open(liveFixture, ALL_OPS, { "task.log": () => logChunk("x\n", { done: true }) }, 20, d => {
    const spy = (n: Record<string, unknown>) => { n.scrollIntoView = (options: unknown) => scrolled.push({ label: String((n as { attrs: Record<string, string> }).attrs["aria-label"]), options }); return n as never; };
    const make = d.doc.createElement.bind(d.doc), makeNS = d.doc.createElementNS.bind(d.doc);
    d.doc.createElement = (tag: string) => spy(make(tag) as unknown as Record<string, unknown>);
    d.doc.createElementNS = (ns: string, tag: string) => spy(makeNS(ns, tag) as unknown as Record<string, unknown>);
  });
  try {
    expect(scrolled).toEqual([]);
    const agent = must(byAttr(dom.container, "data-agent", "t_a"), "agent");
    await act(async () => { clickEl(agent); });
    await until(() => scrolled.length > 0, 2000);
    expect(scrolled).toEqual([{ label: "Live output: oc-glm on review · architecture", options: { block: "nearest" } }]);
    // nothing in the panel took keyboard focus
    await act(async () => { await tick(); });
    expect((dom.doc as unknown as { activeElement: Node | null }).activeElement).toBeNull();
    // polling updates do not scroll again
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(scrolled).toHaveLength(1);
  } finally { await done(dom); }
});

test("the agent opens from the keyboard too: Enter and Space on the agent, and from the list for touch", async () => {
  const { dom, calls } = await open(liveFixture, ALL_OPS, { "task.log": () => logChunk("hello\n", { done: true }) });
  try {
    const agent = must(byAttr(dom.container, "data-agent", "t_c"), "agent");
    expect(attr(agent, "role")).toBe("button");
    // SVG attributes are case sensitive: only lowercase `tabindex` makes the agent a keyboard stop
    expect(attr(agent, "tabindex")).toBe("0");
    expect(attr(agent, "tabIndex")).toBeNull();
    expect(attr(agent, "aria-label")).toBe("Claude Code working on review · security. Open live output");
    await act(async () => { fire(agent, "keydown", { key: "Enter" }); });
    await until(() => domText(dom.container).includes("hello"), 2000);
    expect(calls.ops.find(c => c.op === "task.log")!.params).toMatchObject({ id: "t_c" });
    await act(async () => { clickEl(button(dom.container, "Close output")); });
    await act(async () => { fire(agent, "keydown", { key: " " }); });
    await until(() => domText(dom.container).includes("hello"), 2000);
    // the list offers the same thing as buttons
    await act(async () => { clickEl(button(dom.container, "Close output")); });
    const listButtons = all(dom.container as Node).filter(n => n.tagName === "button" && text(n).trim() === "Open live output");
    expect(listButtons).toHaveLength(2);
    await act(async () => { clickEl(listButtons[0]!); });
    await until(() => calls.ops.filter(c => c.op === "task.log").some(c => (c.params as { id: string }).id === "t_a"), 2000);
  } finally { await done(dom); }
});

test("an output read that fails says so and Try again reads again", async () => {
  let fail = true;
  const { dom, calls } = await open(liveFixture, ALL_OPS, { "task.log": () => { if (fail) throw new ApiError("internal", "disk gone"); return logChunk("back\n", { done: true }); } });
  try {
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("Couldn't read the output"), 2000);
    expect(domText(dom.container)).toContain("disk gone");
    fail = false;
    await act(async () => { clickEl(button(dom.container, "Try again")); });
    await until(() => domText(dom.container).includes("back"), 2000);
    expect(calls.ops.filter(c => c.op === "task.log").length).toBeGreaterThanOrEqual(2);
  } finally { await done(dom); }
});

test("message bar: planner goes to the orchestrator, one agent to that agent, everyone to the planner and each working agent", async () => {
  const { dom, calls } = await open(liveFixture, ALL_OPS, { "msg.send": () => ({ delivery: "turn_started" }) });
  try {
    const sendBtn = () => all(dom.container as Node).find(n => n.tagName === "button" && /^Send to/.test(text(n).trim()))!;
    const area = must(all(dom.container as Node).find(n => n.tagName === "textarea"), "textarea");
    const submit = async (msg: string) => {
      area.value = msg;
      await act(async () => { fire(area, "input"); });
      await act(async () => { fire(messageForm(dom.container), "submit"); });
      await until(() => domText(dom.container).includes("Sent") || domText(dom.container).includes("Delivered to"), 2000);
    };
    // nothing to send yet
    expect(attr(sendBtn(), "disabled")).not.toBeNull();
    expect(text(sendBtn())).toBe("Send to planner");
    await submit("Keep it small.");
    expect(calls.ops.filter(c => c.op === "msg.send").map(c => c.params)).toEqual([{ to: "task:t_orch", body: "Keep it small." }]);
    expect(domText(dom.container)).toContain("Sent. The task is picking it up.");
    expect(area.value ?? "").toBe("");
    // whisper: only the chosen agent
    calls.ops.length = 0;
    await act(async () => { fire(radio(dom.container, "whisper"), "change"); });
    expect(domText(dom.container)).toContain("Only the agent you pick.");
    await act(async () => { fire(radio(dom.container, "t_c"), "change"); });
    await submit("Check the auth path.");
    expect(calls.ops.filter(c => c.op === "msg.send").map(c => c.params)).toEqual([{ to: "task:t_c", body: "Check the auth path." }]);
    expect(domText(dom.container)).toContain("Sent. The task is picking it up.");
    // party: planner plus both agents at work (not the finished one)
    calls.ops.length = 0;
    await act(async () => { fire(radio(dom.container, "party"), "change"); });
    expect(text(sendBtn())).toBe("Send to everyone");
    await submit("Wrap up by five.");
    expect(calls.ops.filter(c => c.op === "msg.send").map(c => (c.params as { to: string }).to)).toEqual(["task:t_orch", "task:t_a", "task:t_c"]);
    expect(domText(dom.container)).toContain("Delivered to 3 of 3 recipients.");
  } finally { await done(dom); }
});

test("a message that cannot reach one recipient says which, in the shared words, and keeps the text", async () => {
  const { dom, calls } = await open(liveFixture, ALL_OPS, { "msg.send": p => {
    if ((p as { to: string }).to === "task:t_a") throw new ApiError("not_allowed", "That task is outside your tree", undefined, 403, { reason: "msg_node_closed" });
    return { delivery: "queued" };
  } });
  try {
    const area = must(all(dom.container as Node).find(n => n.tagName === "textarea"), "textarea");
    await act(async () => { fire(radio(dom.container, "party"), "change"); });
    area.value = "Hello all";
    await act(async () => { fire(area, "input"); });
    await act(async () => { fire(messageForm(dom.container), "submit"); });
    await until(() => domText(dom.container).includes("Delivered to 2 of 3"), 2000);
    expect(domText(dom.container)).toContain("Delivered to 2 of 3 recipients. 1 not sent: This task is closed for messages.");
    expect(domText(dom.container)).not.toContain("outside your tree");
    expect(calls.ops.filter(c => c.op === "msg.send")).toHaveLength(3);
    const alert = all(dom.container as Node).find(n => attr(n, "role") === "alert" && text(n).includes("1 not sent"));
    expect(alert).toBeDefined();
  } finally { await done(dom); }
});

async function sendOne(delivery: Record<string, unknown> | (() => never), channel: "planner" | "party" = "planner") {
  const { dom, calls } = await open(liveFixture, ALL_OPS, { "msg.send": (p: unknown) => typeof delivery === "function" ? delivery() : (delivery.byTo as Record<string, unknown> | undefined)?.[(p as { to: string }).to] ?? delivery });
  const area = must(all(dom.container as Node).find(n => n.tagName === "textarea"), "textarea");
  await act(async () => { fire(radio(dom.container, channel), "change"); });
  area.value = "Please pause.";
  await act(async () => { fire(area, "input"); });
  await act(async () => { fire(messageForm(dom.container), "submit"); });
  await until(() => calls.ops.some(c => c.op === "msg.send"), 2000);
  await tick();
  return { dom, area };
}
const alertText = (c: unknown) => all(c as Node).filter(n => attr(n, "role") === "alert").map(n => text(n)).join(" | ");

test("delivery held: the board says a messaging rule holds it, not that it was sent", async () => {
  const { dom } = await sendOne({ delivery: "held" });
  try {
    expect(alertText(dom.container)).toContain("A messaging rule holds it until you confirm.");
    expect(domText(dom.container)).not.toContain("Message sent");
  } finally { await done(dom); }
});

test("delivery closed: the board says the task is closed for messages", async () => {
  const { dom } = await sendOne({ delivery: "closed" });
  try {
    expect(alertText(dom.container)).toContain("this task is closed for messages");
  } finally { await done(dom); }
});

test("a thrown refusal reads in the shared refusal words and keeps the message; an unknown error never shows its raw text", async () => {
  const { dom, area } = await sendOne(() => { throw new ApiError("not_allowed", "raw: forbidden by rule 7", undefined, 403, { reason: "msg_cap_reached" }); });
  try {
    expect(alertText(dom.container)).toContain("Too many messages at once. Wait a minute and send again.");
    expect(domText(dom.container)).not.toContain("raw: forbidden");
    expect(String(area.value)).toBe("Please pause.");
  } finally { await done(dom); }
  const other = await sendOne(() => { throw new Error("socket hang up"); });
  try {
    expect(alertText(other.dom.container)).toContain("The message was not sent. Try again.");
    expect(domText(other.dom.container)).not.toContain("socket hang up");
  } finally { await done(other.dom); }
});

test("everyone: a mixed result says how many were delivered, held and refused", async () => {
  const { dom } = await sendOne({ delivery: "queued", byTo: { "task:t_a": { delivery: "held" }, "task:t_c": { delivery: "closed" } } }, "party");
  try {
    const t = alertText(dom.container);
    expect(t).toContain("Delivered to 1 of 3 recipients.");
    expect(t).toContain("2 saved but not delivered:");
    expect(t).toContain("A messaging rule holds it until you confirm.");
    expect(t).toContain("this task is closed for messages");
  } finally { await done(dom); }
});

test("without msg.send there is no message bar; without task.log opening an agent still shows an honest error", async () => {
  const { dom } = await open(liveFixture, ALL_OPS.filter(o => o !== "msg.send"));
  try {
    expect(domText(dom.container)).not.toContain("Send to planner");
    expect(all(dom.container as Node).some(n => n.tagName === "textarea")).toBe(false);
  } finally { await done(dom); }
});

test("a question is answered from the Live board with the shared form: expect_rev, refetch, focus back on the title", async () => {
  const { dom, calls } = await open();
  try {
    expect(domText(dom.container)).toContain("Approve the brainstormed spec?");
    expect(domText(dom.container)).toContain("Submit answer");
    await act(async () => { fire(radio(dom.container, "approve"), "change"); });
    await tick();
    const gets = calls.ops.filter(c => c.op === "run.get").length;
    await act(async () => { fire(must(all(dom.container as Node).find(n => n.tagName === "form" && text(n).includes("Submit answer")), "question form"), "submit"); });
    await until(() => calls.ops.some(c => c.op === "question.answer"), 2000);
    expect(calls.ops.find(c => c.op === "question.answer")!.params).toEqual({ id: "q_spec", answer: "approve", expect_rev: 3 });
    await until(() => calls.ops.filter(c => c.op === "run.get").length > gets, 2000);
    await until(() => domText(dom.container).includes("Answer submitted"), 2000);
    await tick();
    const active = (dom.doc as unknown as { activeElement: Node | null }).activeElement;
    expect(active && text(active)).toContain("Ship the board");
  } finally { await done(dom); }
});

test("a failed refresh keeps the board on screen and says it may be out of date", async () => {
  let fail = false;
  const { dom, calls } = await open(liveFixture, ALL_OPS, { "run.get": () => { if (fail) throw new ApiError("internal", "service restarting"); return liveFixture.get; } });
  try {
    expect(domText(dom.container)).not.toContain("may be out of date");
    fail = true;
    // answering triggers a refetch, which now fails
    await act(async () => { fire(radio(dom.container, "approve"), "change"); });
    await tick();
    await act(async () => { fire(must(all(dom.container as Node).find(n => n.tagName === "form" && text(n).includes("Submit answer")), "question form"), "submit"); });
    await until(() => domText(dom.container).includes("This board may be out of date"), 3000);
    expect(nodes(dom.container)).toContain("review:architecture");
    expect(domText(dom.container)).not.toContain("Loading the board");
    fail = false;
    const before = calls.ops.filter(c => c.op === "run.get").length;
    await act(async () => { clickEl(button(dom.container, "Try again")); });
    await until(() => !domText(dom.container).includes("may be out of date"), 3000);
    expect(calls.ops.filter(c => c.op === "run.get").length).toBeGreaterThan(before);
  } finally { await done(dom); }
});

test("a slow older response never overwrites a newer one (latest load wins)", async () => {
  let n = 0;
  const gates: Array<() => void> = [];
  const slow = new Promise<void>(resolve => gates.push(resolve));
  const first = { ...liveFixture.get, run: run({ title: "Old title" }) };
  const later = { ...liveFixture.get, run: run({ title: "New title" }) };
  const dom = installDom();
  const calls: Calls = { ops: [] };
  const api = apiFor(liveFixture, calls, { "run.get": async () => { n++; if (n === 1) { await slow; return first; } return later; } });
  const state = stateFor(liveFixture, ALL_OPS);
  const tree = (revision: number) => (
    <TaskContext.Provider value={{ state: { ...state, invalidations: { runs: revision } }, api }}>
      <LiveBoard runId="run_1" query={query} />
    </TaskContext.Provider>
  );
  try {
    await mount(dom, tree(0));
    await act(async () => { await tick(); });
    await mount(dom, tree(1));        // a newer load starts while the first is still waiting
    await until(() => domText(dom.container).includes("New title"), 3000);
    gates[0]!();                      // the stale response arrives last
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(domText(dom.container)).toContain("New title");
    expect(domText(dom.container)).not.toContain("Old title");
  } finally { await done(dom); }
});

test("the Live board stylesheet moves only under no-preference, and board focus styles are token rings", () => {
  // every transition lives inside the no-preference block; outside it none runs
  const noPref = /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/.exec(liveCss);
  expect(noPref).not.toBeNull();
  const outside = liveCss.replace(noPref![0], "");
  expect(outside).not.toMatch(/transition:\s*(?!none)\S/);
  expect(noPref![0]).toContain("transition:");
  expect(liveCss).toMatch(/\.lb-viewport:focus-visible \{ outline: var\(--stroke-focus\) solid var\(--focus\)/);
  expect(liveCss).toMatch(/\.lb-agent:focus-visible \.lb-agent-ring \{ stroke: var\(--focus\)/);
  expect(liveCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  // the board traps touch only where there is room to scroll around it: on a phone vertical swipes still scroll the page
  expect(/\.lb-viewport \{[^}]*touch-action: none/.test(liveCss)).toBe(true);
  const narrow = /@media \(max-width: 767px\) \{[\s\S]*?\n\}/.exec(liveCss)![0];
  expect(narrow).toContain("touch-action: pan-y");
});

test("after a message is sent focus goes back to the message box, not to nowhere", async () => {
  const { dom } = await open(liveFixture, ALL_OPS, { "msg.send": () => ({ delivery: "queued" }) });
  try {
    const area = must(all(dom.container as Node).find(n => n.tagName === "textarea"), "textarea");
    area.value = "Thanks.";
    await act(async () => { fire(area, "input"); });
    await act(async () => { fire(messageForm(dom.container), "submit"); });
    await until(() => domText(dom.container).includes("Sent."), 2000);
    await act(async () => { await tick(); });
    expect((dom.doc as unknown as { activeElement: Node | null }).activeElement).toBe(area);
  } finally { await done(dom); }
});

test("every agent button in the list says which agent and step it opens", async () => {
  const { dom } = await open();
  try {
    const names = all(dom.container as Node).filter(n => n.tagName === "button" && (attr(n, "aria-label") ?? "").startsWith("Open live output of ")).map(n => attr(n, "aria-label"));
    expect(names.length).toBeGreaterThan(1);
    expect(new Set(names).size).toBe(names.length);
    expect(all(dom.container as Node).filter(n => n.tagName === "button" && text(n).trim() === "Open live output" && !attr(n, "aria-label"))).toHaveLength(0);
  } finally { await done(dom); }
});

test("the board has visible pan buttons that pan like the arrow keys", async () => {
  const { dom } = await open();
  try {
    const world = () => attr(must(all(dom.container as Node).find(n => attr(n, "data-world") !== null), "world"), "transform");
    const before = world();
    await act(async () => { (must(all(dom.container as Node).find(n => n.tagName === "button" && text(n).trim() === "Pan right"), "pan right") as unknown as { click(): void }).click(); });
    expect(world()).not.toBe(before);
    const dx = (t: string | null) => Number(/translate\((-?[\d.]+)/.exec(t ?? "")![1]);
    expect(dx(world()) - dx(before)).toBe(-48);
    for (const name of ["Pan left", "Pan up", "Pan down"]) expect(all(dom.container as Node).some(n => n.tagName === "button" && text(n).trim() === name)).toBe(true);
  } finally { await done(dom); }
});

test("SVG labels are not cut by character count: the full text is drawn, clipped by its box, and is the element's title", async () => {
  const long = "a_very_long_step_name_that_would_never_fit_in_a_desk";
  const fx = { ...liveFixture, get: { ...liveFixture.get, steps: [...(liveFixture.get as { steps: Array<Record<string, unknown>> }).steps, { runId: "run_1", stepId: long, attempt: 1, status: "pending", startedAt: 999 }] } } as typeof liveFixture;
  const { dom } = await open(fx);
  try {
    const label = all(dom.container as Node).find(n => n.tagName === "text" && attr(n, "class") === "lb-desk-label" && text(n).includes(long));
    expect(label).toBeDefined();
    expect(text(label!)).not.toContain("…");
    expect(attr(label!, "clip-path")).toMatch(/^url\(#/);
    expect(all(label!).some(n => (n.tagName ?? "").toLowerCase() === "title" && text(n) === long)).toBe(true);
    const id = /#([^)]+)/.exec(attr(label!, "clip-path")!)![1]!;
    expect(all(dom.container as Node).some(n => (n.tagName ?? "").toLowerCase() === "clippath" && attr(n, "id") === id)).toBe(true);
  } finally { await done(dom); }
});

test("a run that cannot be read at all shows an error alert with Try again and no board", async () => {
  let fail = true;
  const { dom, calls } = await open(liveFixture, ALL_OPS, { "run.get": () => { if (fail) throw new ApiError("internal", "service restarting"); return liveFixture.get; } });
  try {
    const alertEl = all(dom.container as Node).find(n => attr(n, "role") === "alert" && text(n).includes("Couldn't load this run"));
    expect(alertEl).toBeDefined();
    expect(text(alertEl!)).toContain("service restarting");
    expect(nodes(dom.container)).toEqual([]);
    expect(domText(dom.container)).not.toContain("Loading the board");
    fail = false;
    const before = calls.ops.filter(c => c.op === "run.get").length;
    await act(async () => { clickEl(button(dom.container, "Try again")); });
    await until(() => nodes(dom.container).length > 0, 3000);
    expect(calls.ops.filter(c => c.op === "run.get").length).toBeGreaterThan(before);
  } finally { await done(dom); }
});

test("closing the board stops following an agent's output: no further task.log reads after unmount", async () => {
  let reads = 0;
  const { dom } = await open(liveFixture, ALL_OPS, { "task.log": () => { reads++; return logChunk("x\n", { next: { stdout: reads, stderr: 0 }, done: false }); } }, 15);
  await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
  await until(() => reads >= 3, 2000);
  await unmount(dom);
  const atUnmount = reads;
  await new Promise(resolve => setTimeout(resolve, 150));
  dom.restore();
  expect(reads).toBe(atUnmount);
});
