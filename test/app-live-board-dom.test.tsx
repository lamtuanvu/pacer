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

const LIVE_OPS = [...ALL_OPS, "task.log"];
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

async function open(fixture: Fixture = liveFixture, ops = LIVE_OPS, handlers: Parameters<typeof apiFor>[2] = {}, pollMs = 20, prepare?: (dom: ReturnType<typeof installDom>) => void) {
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
  const { dom } = await open(liveFixture, LIVE_OPS, { "run.list": () => [
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
  const { dom, calls } = await open(liveFixture, LIVE_OPS, {
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
  const { dom } = await open(liveFixture, LIVE_OPS, { "task.log": () => logChunk("x\n", { done: true }) }, 20, d => {
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
  const { dom, calls } = await open(liveFixture, LIVE_OPS, { "task.log": () => logChunk("hello\n", { done: true }) });
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
  const { dom, calls } = await open(liveFixture, LIVE_OPS, { "task.log": () => { if (fail) throw new ApiError("internal", "disk gone"); return logChunk("back\n", { done: true }); } });
  try {
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("Couldn't read the output"), 2000);
    expect(domText(dom.container)).toContain("The output could not be read.");
    expect(domText(dom.container)).not.toContain("disk gone");
    fail = false;
    await act(async () => { clickEl(button(dom.container, "Try again")); });
    await until(() => domText(dom.container).includes("back"), 2000);
    expect(calls.ops.filter(c => c.op === "task.log").length).toBeGreaterThanOrEqual(2);
  } finally { await done(dom); }
});

test("message bar: planner goes to the orchestrator, one agent to that agent, everyone to the planner and each working agent", async () => {
  const { dom, calls } = await open(liveFixture, LIVE_OPS, { "msg.send": () => ({ delivery: "turn_started" }) });
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
    expect(calls.ops.filter(c => c.op === "msg.send").map(c => c.params)).toEqual([{ to: "task:t_orch", body: "Keep it small.", request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    expect(domText(dom.container)).toContain("Sent. The task is picking it up.");
    expect(area.value ?? "").toBe("");
    // whisper: only the chosen agent
    calls.ops.length = 0;
    await act(async () => { fire(radio(dom.container, "whisper"), "change"); });
    expect(domText(dom.container)).toContain("Only the agent you pick.");
    await act(async () => { fire(radio(dom.container, "t_c"), "change"); });
    await submit("Check the auth path.");
    expect(calls.ops.filter(c => c.op === "msg.send").map(c => c.params)).toEqual([{ to: "task:t_c", body: "Check the auth path.", request_id: expect.any(String) }]);
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
  const { dom, calls } = await open(liveFixture, LIVE_OPS, { "msg.send": p => {
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
  const { dom, calls } = await open(liveFixture, LIVE_OPS, { "msg.send": (p: unknown) => typeof delivery === "function" ? delivery() : (delivery.byTo as Record<string, unknown> | undefined)?.[(p as { to: string }).to] ?? delivery });
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

test("without msg.send there is no message bar, and an agent's output still opens", async () => {
  const { dom, calls } = await open(liveFixture, LIVE_OPS.filter(o => o !== "msg.send"), { "task.log": () => logChunk("still here\n", { done: true }) });
  try {
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("still here"), 2000);
    expect(calls.ops.some(c => c.op === "task.log")).toBe(true);
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
  const { dom, calls } = await open(liveFixture, LIVE_OPS, { "run.get": () => { if (fail) throw new ApiError("internal", "service restarting"); return liveFixture.get; } });
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
  const state = stateFor(liveFixture, LIVE_OPS);
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
  const { dom } = await open(liveFixture, LIVE_OPS, { "msg.send": () => ({ delivery: "queued" }) });
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
  const { dom, calls } = await open(liveFixture, LIVE_OPS, { "run.get": () => { if (fail) throw new ApiError("internal", "service restarting"); return liveFixture.get; } });
  try {
    const alertEl = all(dom.container as Node).find(n => attr(n, "role") === "alert" && text(n).includes("Couldn't load this run"));
    expect(alertEl).toBeDefined();
    expect(text(alertEl!)).toContain("Couldn't load this run's details.");
    expect(domText(dom.container)).not.toContain("service restarting");
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
  const { dom } = await open(liveFixture, LIVE_OPS, { "task.log": () => { reads++; return logChunk("x\n", { next: { stdout: reads, stderr: 0 }, done: false }); } }, 15);
  await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
  await until(() => reads >= 3, 2000);
  await unmount(dom);
  const atUnmount = reads;
  await new Promise(resolve => setTimeout(resolve, 150));
  dom.restore();
  expect(reads).toBe(atUnmount);
});

const h1Text = (root: unknown) => all(root as Node).filter(n => n.tagName === "h1").map(n => text(n));

test("the heading never shows the raw run id, and no letter is guessed for a run nothing names", async () => {
  const absent: Fixture = { ...liveFixture, id: "run_gone_7f3a", list: [] };
  const { dom } = await open(absent, LIVE_OPS, { "run.get": () => { throw new ApiError("internal", "boom"); } });
  try {
    expect(h1Text(dom.container)).toEqual(["Run"]);
    expect(domText(dom.container)).not.toContain("run_gone_7f3a");
  } finally { await done(dom); }
});

test("a failed run.seen is shown with a retry that clears it", async () => {
  let fail = true;
  const { dom, calls } = await open(liveFixture, LIVE_OPS, { "run.seen": () => { if (fail) throw new ApiError("internal", "raw seen"); return {}; } });
  try {
    await until(() => domText(dom.container).includes("Couldn't mark this run as seen."), 2000);
    expect(domText(dom.container)).not.toContain("raw seen");
    fail = false;
    await act(async () => { clickEl(button(dom.container, "Mark as seen")); });
    await until(() => !domText(dom.container).includes("Couldn't mark this run as seen."), 2000);
    expect(calls.ops.filter(c => c.op === "run.seen").length).toBe(2);
  } finally { await done(dom); }
});

test("a successful retry moves focus to the run title, and to Close output on the agent panel", async () => {
  let failRun = true, failLog = true;
  const { dom } = await open(liveFixture, LIVE_OPS, {
    "run.get": () => { if (failRun) throw new ApiError("internal", "x"); return liveFixture.get; },
    "task.log": () => { if (failLog) throw new ApiError("internal", "y"); return logChunk("back\n", { done: true }); },
  });
  const focused = () => { const a = (dom.doc as unknown as { activeElement: Node | null }).activeElement; return a ? text(a) : ""; };
  try {
    failRun = false;
    await act(async () => { clickEl(button(dom.container, "Try again")); });
    await until(() => focused().includes("Ship the board"), 2000);
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("Couldn't read the output"), 2000);
    failLog = false;
    const again = button(dom.container, "Try again");
    await act(async () => { (again as unknown as { focus(): void }).focus(); clickEl(again); });
    await until(() => focused() === "Close output", 2000);
  } finally { await done(dom); }
});

// ---- review fixes

/** A board whose run, snapshot tasks and handlers can change between refreshes. */
async function live(handlers: Parameters<typeof apiFor>[2] = {}, get: () => Fixture["get"] = () => liveFixture.get, ops = LIVE_OPS, pollMs = 10, tasks = liveFixture.tasks) {
  const dom = installDom();
  const calls: Calls = { ops: [] };
  const fx: Fixture = { ...liveFixture, tasks };
  const api = apiFor(fx, calls, { "run.get": () => get(), ...handlers });
  const state = stateFor(fx, ops);
  let revision = 0;
  const tree = () => <TaskContext.Provider value={{ state: { ...state, invalidations: { runs: revision } }, api }}><LiveBoard runId="run_1" query={query} outputPollMs={pollMs} /></TaskContext.Provider>;
  await mount(dom, tree());
  await until(() => domText(dom.container).includes("Steps on the board"), 3000);
  await act(async () => { await tick(); });
  await new Promise(resolve => setTimeout(resolve, 80));
  const refresh = async () => { revision++; await mount(dom, tree()); await new Promise(resolve => setTimeout(resolve, 80)); await act(async () => { await tick(); }); };
  return { dom, calls, refresh };
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
const without = (taskId: string): Fixture["get"] => ({ ...liveFixture.get, steps: (liveFixture.get.steps as Array<Record<string, unknown>>).map(s => s.taskId === taskId ? { ...s, status: "done", endedAt: 950 } : s) });
const typeMessage = async (root: unknown, value: string) => {
  const area = must(all(root as Node).find(n => n.tagName === "textarea"), "textarea");
  area.value = value;
  await act(async () => { fire(area, "input"); });
  return area;
};
const submitMessage = (root: unknown) => act(async () => { fire(messageForm(root), "submit"); await tick(); });
const sendButton = (root: unknown) => must(all(root as Node).find(n => n.tagName === "button" && /^(Send to|Sending)/.test(text(n).trim())), "send button");
const sends = (calls: Calls) => calls.ops.filter(c => c.op === "msg.send").map(c => c.params as { to: string; body: string; request_id: string });
const focusedNode = (dom: { doc: unknown }) => (dom.doc as { activeElement: Node | null }).activeElement;
const person = (root: unknown) => text(must(all(root as Node).find(n => attr(n, "data-station") === "person"), "person station"));

test("a whisper is never retargeted: when the chosen agent stops, the send is refused in words", async () => {
  let get = liveFixture.get;
  const { dom, calls, refresh } = await live({ "msg.send": () => ({ delivery: "queued" }) }, () => get);
  try {
    await act(async () => { fire(radio(dom.container, "whisper"), "change"); });
    await act(async () => { fire(radio(dom.container, "t_c"), "change"); });
    await typeMessage(dom.container, "only for security");
    get = without("t_c");
    await refresh();
    await submitMessage(dom.container);
    expect(sends(calls)).toEqual([]);
    expect(domText(dom.container)).toContain("That agent is no longer working.");
  } finally { await done(dom); }
});

test("a whisper picked by default is pinned too, and with no agent left the lane cannot send", async () => {
  let get = liveFixture.get;
  const { dom, calls, refresh } = await live({ "msg.send": () => ({ delivery: "queued" }) }, () => get);
  try {
    await act(async () => { fire(radio(dom.container, "whisper"), "change"); });
    await typeMessage(dom.container, "for the first agent");
    get = without("t_a");
    await refresh();
    await submitMessage(dom.container);
    expect(sends(calls)).toEqual([]);
    expect(domText(dom.container)).toContain("That agent is no longer working.");
    get = { ...liveFixture.get, steps: (without("t_a").steps as Array<Record<string, unknown>>).map(s => ({ ...s, status: s.status === "running" ? "done" : s.status })) };
    await refresh();
    expect(attr(sendButton(dom.container), "disabled")).not.toBeNull();
    expect(domText(dom.container)).toContain("That agent is no longer working.");
  } finally { await done(dom); }
});

test("the message form starts on an enabled lane: everyone when the run has no planner task", async () => {
  const { dom, calls } = await live({ "msg.send": () => ({ delivery: "queued" }) }, () => ({ ...liveFixture.get, run: run({ orchestratorTaskId: undefined }) }));
  try {
    expect(radio(dom.container, "planner")).toBeDefined();
    expect(attr(radio(dom.container, "planner"), "disabled")).not.toBeNull();
    expect(text(sendButton(dom.container))).toBe("Send to everyone");
    await typeMessage(dom.container, "hello");
    expect(attr(sendButton(dom.container), "disabled")).toBeNull();
    await submitMessage(dom.container);
    expect(sends(calls).map(s => s.to)).toEqual(["task:t_a", "task:t_c"]);
  } finally { await done(dom); }
});

test("a chosen lane that stops working is kept, disabled, and says why", async () => {
  let get = liveFixture.get;
  const { dom, calls, refresh } = await live({}, () => get);
  try {
    await act(async () => { fire(radio(dom.container, "planner"), "change"); });
    await typeMessage(dom.container, "to the planner");
    get = { ...liveFixture.get, run: run({ orchestratorTaskId: undefined }) };
    await refresh();
    expect(text(sendButton(dom.container))).toBe("Send to planner");
    expect(attr(sendButton(dom.container), "disabled")).not.toBeNull();
    expect(domText(dom.container)).toContain("This run has no planner to message.");
    expect(sends(calls)).toEqual([]);
  } finally { await done(dom); }
});

test("an in-flight send: no second send, button disabled, later typing kept, board reloaded", async () => {
  let release: (v: unknown) => void = () => {};
  const { dom, calls } = await live({ "msg.send": () => new Promise(r => { release = r; }) });
  try {
    await typeMessage(dom.container, "first part");
    const gets = calls.ops.filter(c => c.op === "run.get").length;
    const form = messageForm(dom.container);
    await act(async () => { fire(form, "submit"); fire(form, "submit"); await tick(); });
    expect(sends(calls)).toHaveLength(1);
    expect(text(sendButton(dom.container))).toBe("Sending…");
    expect(attr(sendButton(dom.container), "disabled")).not.toBeNull();
    const area = await typeMessage(dom.container, "first part and more");
    await act(async () => { release({ delivery: "queued" }); await tick(); });
    await settle();
    expect(area.value).toBe("and more");
    expect(calls.ops.filter(c => c.op === "run.get").length).toBeGreaterThan(gets);
  } finally { await done(dom); }
});

test("a partial refusal keeps the text, and sending it again reuses each recipient's request id", async () => {
  let refuse = true;
  const { dom, calls } = await live({ "msg.send": p => { if (refuse && (p as { to: string }).to === "task:t_c") throw new ApiError("not_allowed", "no", undefined, 403, { reason: "msg_node_closed" }); return { delivery: "queued" }; } });
  try {
    await act(async () => { fire(radio(dom.container, "party"), "change"); });
    const area = await typeMessage(dom.container, "all of you");
    await submitMessage(dom.container);
    await settle();
    expect(area.value).toBe("all of you");
    refuse = false;
    await submitMessage(dom.container);
    await settle();
    const all6 = sends(calls);
    expect(all6).toHaveLength(6);
    expect(all6.slice(3).map(s => s.request_id)).toEqual(all6.slice(0, 3).map(s => s.request_id));
    expect(new Set(all6.slice(0, 3).map(s => s.request_id)).size).toBe(3);
    expect(area.value).toBe("");
    // the same words sent as a new message get new ids
    await typeMessage(dom.container, "all of you");
    await submitMessage(dom.container);
    await settle();
    expect(sends(calls)[6]!.request_id).not.toBe(all6[0]!.request_id);
  } finally { await done(dom); }
});

test("the You station never says nothing waits while a question is open, even on a running step", async () => {
  const get = () => ({ ...liveFixture.get, questions: undefined });
  const onRunning = [{ ...(liveFixture.questions![0] as Record<string, unknown>), id: "q_run", stepId: "review", branch: "architecture" }];
  const { dom } = await live({ "question.list": () => onRunning }, get);
  try {
    expect(person(dom.container)).toContain("A question");
    expect(person(dom.container)).not.toContain("Nothing");
  } finally { await done(dom); }
  const failed = await live({ "question.list": () => { throw new ApiError("internal", "raw"); } }, get);
  try {
    expect(person(failed.dom.container)).toContain("Questions not");
    expect(person(failed.dom.container)).not.toContain("Nothing");
  } finally { await done(failed.dom); }
  const none = await live({ "question.list": () => [] }, get);
  try { expect(person(none.dom.container)).toContain("Nothing waits"); } finally { await done(none.dom); }
});

test("a finished task's pages are all read before it is called done, and clipped output is not called full", async () => {
  const pages = ["a".repeat(30_000) + "\n", "middle\n", "THE LAST LINE\n"];
  const { dom, calls } = await live({ "task.log": p => {
    const at = (p as { stdout: number }).stdout;
    return { stdout: pages[at] ?? "", stderr: "", next: { stdout: Math.min(at + 1, pages.length), stderr: 0 }, done: true, source: "s1" };
  } });
  try {
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("Task finished; showing the end of its output"), 3000);
    expect(domText(dom.container)).toContain("THE LAST LINE");
    expect(domText(dom.container)).not.toContain("full output");
    expect(domText(dom.container)).toContain("Earlier output is not shown here.");
    const reads = calls.ops.filter(c => c.op === "task.log").length;
    expect(reads).toBe(4);
    await settle();
    expect(calls.ops.filter(c => c.op === "task.log").length).toBe(reads);   // stops once done and drained
  } finally { await done(dom); }
});

test("while pages remain a finished task is not called finished-with-full-output", async () => {
  let hold = true;
  const { dom } = await live({ "task.log": p => {
    const at = (p as { stdout: number }).stdout;
    if (at === 0) return logChunk("one\n", { done: true, next: { stdout: 1, stderr: 0 } });
    return hold ? new Promise(() => {}) : logChunk("", { done: true, next: { stdout: 1, stderr: 0 } });
  } });
  try {
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("reading the rest of its output"), 3000);
    expect(domText(dom.container)).not.toContain("full output");
  } finally { hold = false; await done(dom); }
});

test("a rerouted output starts again from the top instead of splicing two sources", async () => {
  let n = 0;
  const { dom, calls } = await live({ "task.log": () => {
    n++;
    if (n === 1) return logChunk("OLD SOURCE\n");
    if (n === 2) return logChunk("tail of new\n", { source: "s2" });
    return logChunk(n === 3 ? "NEW FROM TOP\n" : "", { source: "s2", done: true, next: { stdout: 13, stderr: 0 } });
  } });
  try {
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("full output"), 3000);
    expect(domText(dom.container)).toContain("NEW FROM TOP");
    expect(domText(dom.container)).not.toContain("OLD SOURCE");
    expect(domText(dom.container)).not.toContain("tail of new");
    expect((calls.ops.filter(c => c.op === "task.log")[2]!.params as { stdout: number }).stdout).toBe(0);
  } finally { await done(dom); }
});

test("a failed read keeps the text and the failure on screen while retrying, and resumes from its offset", async () => {
  let mode: "ok" | "fail" | "hold" = "ok";
  let release: () => void = () => {};
  const { dom, calls } = await live({ "task.log": async () => {
    if (mode === "fail") throw new ApiError("internal", "raw");
    if (mode === "hold") { await new Promise<void>(r => { release = r; }); throw new ApiError("internal", "raw"); }
    mode = "fail";
    return logChunk("kept text\n", { next: { stdout: 10, stderr: 0 } });
  } });
  try {
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("Couldn't read the output"), 3000);
    expect(domText(dom.container)).toContain("kept text");
    mode = "hold";
    await act(async () => { clickEl(button(dom.container, "Try again")); await tick(); });
    expect(domText(dom.container)).toContain("Couldn't read the output");
    expect(domText(dom.container)).toContain("kept text");
    await act(async () => { release(); await tick(); });
    await settle();
    expect(domText(dom.container)).toContain("kept text");
    expect((calls.ops.filter(c => c.op === "task.log").at(-1)!.params as { stdout: number }).stdout).toBe(10);
  } finally { await done(dom); }
});

test("the log is quiet for screen readers and stays at its end until the person scrolls up", async () => {
  let n = 0;
  const { dom } = await live({ "task.log": () => { n++; return logChunk(`line ${n}\n`, { next: { stdout: n, stderr: 0 } }); } }, undefined, LIVE_OPS, 15);
  try {
    await act(async () => { clickEl(must(byAttr(dom.container, "data-agent", "t_a"), "agent")); });
    await until(() => domText(dom.container).includes("line 1"), 3000);
    const pre = must(all(dom.container as Node).find(n => n.tagName === "pre"), "log") as unknown as Node & { scrollTop: number; scrollHeight: number; clientHeight: number };
    expect(attr(pre, "aria-live")).toBe("off");
    pre.scrollHeight = 900; pre.clientHeight = 100;
    await until(() => pre.scrollTop === 900, 2000);
    pre.scrollTop = 100;
    await act(async () => { fire(pre, "scroll", { currentTarget: pre }); });
    const seen = n;
    await until(() => n > seen + 2, 2000);
    await settle();
    expect(pre.scrollTop).toBe(100);
  } finally { await done(dom); }
});

test("when the open agent's step ends its panel stays with the last output, and focus is not dropped", async () => {
  let get = liveFixture.get;
  let finished = false;
  const { dom, refresh } = await live({ "task.log": p => (p as { stdout: number }).stdout === 0 ? logChunk("working\n", { next: { stdout: 1, stderr: 0 } })
    : finished && (p as { stdout: number }).stdout === 1 ? logChunk("final words\n", { done: true, next: { stdout: 2, stderr: 0 } }) : logChunk("", { done: finished, next: { stdout: (p as { stdout: number }).stdout, stderr: 0 } }) }, () => get);
  try {
    const agent = must(byAttr(dom.container, "data-agent", "t_a"), "agent");
    await act(async () => { clickEl(agent); });
    await until(() => domText(dom.container).includes("working"), 2000);
    (agent as unknown as { focus(): void }).focus();
    finished = true; get = without("t_a");
    await refresh();
    await until(() => domText(dom.container).includes("final words"), 3000);
    expect(domText(dom.container)).toContain("This agent is no longer working on this step.");
    expect(text(focusedNode(dom)!)).toBe("Close output");
    await act(async () => { clickEl(button(dom.container, "Close output")); await tick(); });
    expect(domText(dom.container)).not.toContain("final words");
    expect(text(focusedNode(dom)!)).toContain("Ship the board");
  } finally { await done(dom); }
});

test("focus on a leaving agent that is not open goes to the title", async () => {
  let get = liveFixture.get;
  const { dom, refresh } = await live({}, () => get);
  try {
    (must(byAttr(dom.container, "data-agent", "t_c"), "agent") as unknown as { focus(): void }).focus();
    get = without("t_c");
    await refresh();
    expect(text(focusedNode(dom)!)).toContain("Ship the board");
  } finally { await done(dom); }
});

test("keyboard focus on an agent that was panned out of view brings it back", async () => {
  const { dom } = await live();
  try {
    const board = viewport(dom.container);
    const start = viewOf(dom.container);
    for (let i = 0; i < 8; i++) await act(async () => { fire(board, "keydown", { key: "ArrowRight", shiftKey: true }); });
    expect(viewOf(dom.container).x).toBeLessThan(start.x - 1000);
    const target = must(byAttr(dom.container, "data-agent", "t_a"), "agent");
await act(async () => { fire(target, "focusin"); await tick(); });
    await settle();
    const after = viewOf(dom.container);
    const transform = attr(must(byAttr(dom.container, "data-agent", "t_a"), "agent").childNodes![0] as Node, "x");
    const screenX = after.x + (Number(transform) + 3) * after.k;
    expect(screenX).toBeGreaterThanOrEqual(15);
    expect(screenX).toBeLessThanOrEqual(960);
  } finally { await done(dom); }
});

test("without task.log nothing offers to open output", async () => {
  const { dom } = await live({}, undefined, LIVE_OPS.filter(o => o !== "task.log"));
  try {
    expect(domText(dom.container)).toContain("Agents at work");
    expect(domText(dom.container)).not.toContain("Open live output");
    expect(all(dom.container as Node).some(n => attr(n, "data-agent") !== null)).toBe(false);
    expect(all(dom.container as Node).filter(n => attr(n, "data-agent-static") !== null)).toHaveLength(2);
  } finally { await done(dom); }
});

test("agents of tasks the snapshot does not list keep separate creatures", async () => {
  const { dom } = await live({}, undefined, LIVE_OPS, 10, []);
  try {
    const art = ["t_a", "t_c"].map(id => all(must(byAttr(dom.container, "data-agent", id), "agent")).filter(n => n.tagName === "rect").slice(1).map(n => `${attr(n, "class")}@${Math.round(Number(attr(n, "x")) * 10)},${Math.round(Number(attr(n, "y")) * 10)}`).join(" "));
    expect(art[0]).not.toBe(art[1]);
    expect(domText(dom.container)).toContain("An executor");
    expect(domText(dom.container)).not.toContain("task:t_a");
  } finally { await done(dom); }
});

test("station and zone notes are wrapped or clipped inside their boxes, with the full text as title", async () => {
  const { dom } = await live({ "question.list": () => [] }, () => ({ ...liveFixture.get, questions: undefined }));
  try {
    const station = must(all(dom.container as Node).find(n => attr(n, "data-station") === "person"), "station");
    const notes = all(station).filter(n => n.tagName === "text" && attr(n, "class") === "lb-station-note");
    expect(notes.map(n => text(all(n).find(x => x.tagName === "title")!))).toEqual(["Nothing waits on you", "Nothing waits on you"]);
    expect(notes.map(n => n.childNodes!.filter(c => (c as Node).nodeType === 3).map(c => (c as Node).data).join(""))).toEqual(["Nothing waits", "on you"]);
    for (const n of notes) expect(attr(n, "clip-path")).toMatch(/^url\(#/);
    expect(notes).toHaveLength(2);
  } finally { await done(dom); }
});
