/** DOM tests for the journey playback (board 7): read-only, walks the recorded events, plays and pauses on a timer. */
import { expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { TaskContext } from "../app/src/screens/task-shared";
import { JourneyPlayback } from "../app/src/screens/runs/JourneyPlayback";
import { domText, installDom, mount, tick, until, unmount } from "./app-setup-health-dom";
import { ALL_OPS, apiFor, stateFor, type Calls, type Fixture } from "./app-run-view-fixtures";
import { journeyDecisions, journeyDefinition, journeyInput, step } from "./app-live-board-fixtures";

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
const button = (root: unknown, label: string) => must(all(root as Node).find(n => n.tagName === "button" && text(n).trim() === label), `button ${label}`);
const click = async (root: unknown, label: string) => { await act(async () => { (button(root, label) as unknown as { click(): void }).click(); }); };
const nodes = (root: unknown) => all(root as Node).filter(n => attr(n, "data-node") !== null).map(n => attr(n, "data-node")!);
const now = (root: unknown) => text(must(all(root as Node).find(n => attr(n, "data-now") !== null), "now line"));

const run = (over: Record<string, unknown> = {}) => ({
  id: "run_1", workflow: "pacer-dev/feature", version: 2, title: "Ship the board", status: "done", priority: "normal",
  rev: 9, createdAt: 900, updatedAt: 995, orchestratorTaskId: "t_orch", orchestrator: { state: "idle", planner: "claude" }, ...over,
});
const row = (...a: Parameters<typeof step>): Record<string, unknown> => ({ ...step(...a) });
const journeyFixture = (over: Record<string, unknown> = {}): Fixture => ({
  id: "run_1",
  get: {
    run: run(over),
    steps: journeyInput.steps.map(s => row(s.stepId, s.status, { startedAt: s.startedAt, endedAt: s.endedAt, taskId: s.taskId })),
    definition: journeyDefinition,
    graphs: journeyInput.graphs,
    decisions: journeyDecisions,
  },
  list: [
    { id: "run_1", workflow: "pacer-dev/feature", title: "Ship the board", status: "done", priority: "normal", createdAt: 900 },
    { id: "run_child", workflow: "generated", title: "Plan", status: "done", priority: "normal", createdAt: 956, parentRunId: "run_1" },
  ],
  children: { run_child: { run: run({ id: "run_child", parentRunId: "run_1", parentStep: "plan", createdAt: 956 }), steps: journeyInput.children![0]!.steps.map(s => row(s.stepId, s.status, { runId: "run_child", startedAt: s.startedAt, endedAt: s.endedAt, taskId: s.taskId })), definition: journeyInput.children![0]!.definition } },
  tasks: [{ id: "t_brain", executor: "oc-glm" }, { id: "t_api", executor: "codex" }, { id: "t_ui", executor: "oc-glm" }],
});

async function open(fixture = journeyFixture(), stepMs = 10) {
  const dom = installDom();
  const calls: Calls = { ops: [] };
  const api = apiFor(fixture, calls);
  await mount(dom, (
    <TaskContext.Provider value={{ state: stateFor(fixture, ALL_OPS), api }}>
      <JourneyPlayback runId="run_1" query={query} stepMs={stepMs} />
    </TaskContext.Provider>
  ));
  await until(() => domText(dom.container).includes("Events"), 3000);
  await act(async () => { await tick(); });
  return { dom, calls };
}
const done = async (dom: Awaited<ReturnType<typeof open>>["dom"]) => { await unmount(dom); dom.restore(); };

test("the replay starts before the first event with an empty board and the whole story listed", async () => {
  const { dom } = await open();
  try {
    expect(now(dom.container)).toBe("Ready. Press Play to replay the run.");
    expect(nodes(dom.container)).toEqual([]);
    const items = all(dom.container as Node).filter(n => attr(n, "data-event") !== null);
    expect(items).toHaveLength(19);
    expect(text(items[0]!)).toContain("Run started: Ship the board");
    expect(text(items[2]!)).toContain("The router chose pacer-dev/feature");
    expect(domText(dom.container)).toContain("Position: event 0 of 19");
    expect(domText(dom.container)).toContain("Replay of a finished run (done). Read-only");
    expect(all(dom.container as Node).filter(n => attr(n, "aria-current") === "step")).toHaveLength(0);
  } finally { await done(dom); }
});

test("stepping forward plays one recorded event at a time and back undoes it", async () => {
  const { dom } = await open();
  try {
    await click(dom.container, "Step forward");            // run started
    expect(now(dom.container)).toBe("Run started: Ship the board");
    expect(nodes(dom.container)).toEqual([]);
    await click(dom.container, "Step forward");            // route starts
    expect(now(dom.container)).toBe("route starts");
    expect(nodes(dom.container)).toEqual(["route"]);
    await click(dom.container, "Step forward");            // router chose
    expect(now(dom.container)).toBe("The router chose pacer-dev/feature");
    expect(domText(dom.container)).toContain("The brief asks for a new screen.");
    const current = all(dom.container as Node).filter(n => attr(n, "aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(attr(current[0]!, "data-event")).toBe("2");
    await click(dom.container, "Step back");
    await click(dom.container, "Step back");
    await click(dom.container, "Step back");
    expect(nodes(dom.container)).toEqual([]);
    expect(domText(dom.container)).toContain("Position: event 0 of 19");
  } finally { await done(dom); }
});

test("a new executor arrives with its generated mascot, and leaves when its step ends", async () => {
  const { dom } = await open();
  try {
    for (let i = 0; i < 5; i++) await click(dom.container, "Step forward");   // ... oc-glm joins and takes brainstorm
    expect(now(dom.container)).toBe("oc-glm joins and takes brainstorm; its mascot is generated");
    expect(all(dom.container as Node).some(n => attr(n, "data-agent-static") === "t_brain")).toBe(true);
    expect(text(must(all(dom.container as Node).find(n => attr(n, "data-node") === "brainstorm"), "desk"))).toContain("Running");
    await click(dom.container, "Step forward");
    expect(now(dom.container)).toBe("oc-glm leaves brainstorm · Done");
    expect(all(dom.container as Node).some(n => attr(n, "data-agent-static") === "t_brain")).toBe(false);
    expect(text(must(all(dom.container as Node).find(n => attr(n, "data-node") === "brainstorm"), "desk"))).toContain("Done");
  } finally { await done(dom); }
});

test("Play advances by itself, Pause stops it, and at the end it offers Play again", async () => {
  const { dom } = await open(journeyFixture(), 15);
  try {
    await click(dom.container, "Play");
    await until(() => domText(dom.container).includes("Position: event 3 of 19") || domText(dom.container).includes("Position: event 4 of 19"), 2000);
    await click(dom.container, "Pause");
    const paused = domText(dom.container).match(/Position: event (\d+) of 19/)![1];
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(domText(dom.container).match(/Position: event (\d+) of 19/)![1]).toBe(paused!);
    await click(dom.container, "Play");
    await until(() => domText(dom.container).includes("Position: event 19 of 19"), 3000);
    expect(now(dom.container)).toBe("Run done");
    expect(button(dom.container, "Play again")).toBeDefined();
    expect(domText(dom.container)).toContain("v2 approved · 4 steps · 2 started · v1 rejected");
    expect(nodes(dom.container).sort()).toEqual(["approve_spec", "brainstorm", "plan", "route", "zone:plan/api", "zone:plan/ui"]);
  } finally { await done(dom); }
});

test("the position slider and Jump to end move the replay; the slider reads out the event", async () => {
  const { dom } = await open();
  try {
    const slider = must(all(dom.container as Node).find(n => n.tagName === "input" && attr(n, "type") === "range"), "slider");
    slider.value = "10";
    await act(async () => { fire(slider, "input", { currentTarget: slider }); });
    expect(domText(dom.container)).toContain("Position: event 10 of 19");
    expect(now(dom.container)).toBe("The planner drafts plan v1 (2 steps)");
    expect(attr(slider, "aria-valuetext")).toBe("Event 10 of 19: The planner drafts plan v1 (2 steps)");
    expect(domText(dom.container)).toContain("v1 proposed · 2 steps");
    await click(dom.container, "Jump to end");
    expect(now(dom.container)).toBe("Run done");
    // clicking an event in the list jumps to it
    const second = must(all(dom.container as Node).find(n => attr(n, "data-event") === "1"), "event 1");
    await act(async () => { (must(all(second).find(n => n.tagName === "button"), "event button") as unknown as { click(): void }).click(); });
    expect(now(dom.container)).toBe("route starts");
  } finally { await done(dom); }
});

test("the replay is read-only: no message bar, no question form, no operation that changes the run", async () => {
  const { dom, calls } = await open();
  try {
    await click(dom.container, "Jump to end");
    expect(all(dom.container as Node).some(n => n.tagName === "textarea")).toBe(false);
    expect(domText(dom.container)).not.toContain("Submit answer");
    expect(all(dom.container as Node).some(n => attr(n, "role") === "button" && attr(n, "data-agent") !== null)).toBe(false);
    const writes = calls.ops.map(c => c.op).filter(op => !["run.list", "run.get", "question.list", "msg.log", "run.seen"].includes(op));
    expect(writes).toEqual([]);
    expect(calls.ops.some(c => c.op === "run.seen")).toBe(false);   // watching a replay is not "looking at the run"
  } finally { await done(dom); }
});

test("an unfinished run says the replay shows what has happened so far", async () => {
  const { dom } = await open(journeyFixture({ status: "running" }));
  try {
    expect(domText(dom.container)).toContain("This run is still in progress, so the replay shows what has happened so far.");
    expect(domText(dom.container)).toContain("Position: event 0 of 18");
  } finally { await done(dom); }
});

test("the event list marks played, now and next in words, and exposes one polite status line", async () => {
  const { dom } = await open();
  try {
    await click(dom.container, "Step forward");
    await click(dom.container, "Step forward");
    const labels = all(dom.container as Node).filter(n => attr(n, "data-event") !== null).map(n => text(all(n).find(x => attr(x, "class")?.includes("lb-item-state"))!).trim());
    expect(labels.slice(0, 4)).toEqual(["Played", "Now", "Next", "Next"]);
    const nowEl = must(all(dom.container as Node).find(n => attr(n, "data-now") !== null), "now");
    expect(attr(nowEl, "role")).toBe("status");
    expect(attr(nowEl, "aria-live")).toBe("polite");
  } finally { await done(dom); }
});

test("the replay names executors with the shared label (codex reads Codex), not the raw id", async () => {
  const { dom } = await open();
  try {
    const t = domText(dom.container);
    expect(t).toContain("Codex joins and takes api; its mascot is generated");
    expect(t).toContain("Codex leaves api");
    expect(t).not.toContain("codex joins");
    expect(t).toContain("oc-glm joins and takes brainstorm");      // an id the shared label does not know is shown as it is
  } finally { await done(dom); }
});

const active = (dom: { doc: unknown }) => (dom.doc as { activeElement: Node | null }).activeElement;
const activeText = (dom: { doc: unknown }) => { const a = active(dom); return a ? text(a).trim() : null; };

test("each event button says which event it jumps to; none is named Next, which Step forward would clash with", async () => {
  const { dom } = await open();
  try {
    const names = all(dom.container as Node).filter(n => attr(n, "data-event") !== null).map(n => attr(all(n).find(x => x.tagName === "button")!, "aria-label"));
    expect(names).toHaveLength(19);
    expect(names[0]).toBe("Go to event 1: Run started: Ship the board");
    expect(new Set(names).size).toBe(19);
    expect(names.every(n => n?.startsWith("Go to event "))).toBe(true);
    // the visible label is contained in the accessible name (WCAG label in name)
    const visible = text(all(dom.container as Node).find(n => attr(n, "data-event") === "2")!.childNodes!.find(c => (c as Node).tagName === "button") as Node).trim();
    expect(visible).toBe("Event 3");
    expect(names[2]!.toLowerCase()).toContain(visible.toLowerCase());
    expect(all(dom.container as Node).filter(n => n.tagName === "button" && text(n).trim() === "Next")).toHaveLength(0);
  } finally { await done(dom); }
});

test("Play and Pause is one pattern: the label changes and there is no aria-pressed", async () => {
  const { dom } = await open(journeyFixture(), 400);
  try {
    expect(attr(button(dom.container, "Play"), "aria-pressed")).toBeNull();
    await click(dom.container, "Play");
    expect(attr(button(dom.container, "Pause"), "aria-pressed")).toBeNull();
  } finally { await done(dom); }
});

test("a playback button that disables itself hands keyboard focus to Play instead of dropping it", async () => {
  const { dom } = await open();
  try {
    await click(dom.container, "Jump to end");
    await act(async () => { await tick(); });
    expect(activeText(dom)).toBe("Play again");
    await click(dom.container, "Restart");
    await act(async () => { await tick(); });
    expect(activeText(dom)).toBe("Play");
    // stepping back to the start disables Step back: same
    await click(dom.container, "Step forward");
    await click(dom.container, "Step back");
    await act(async () => { await tick(); });
    expect(activeText(dom)).toBe("Play");
    // stepping forward onto the last event disables Step forward
    await click(dom.container, "Jump to end");
    await click(dom.container, "Restart");
    await act(async () => { await tick(); });
    for (let i = 0; i < 19; i++) await click(dom.container, "Step forward");
    await act(async () => { await tick(); });
    expect(activeText(dom)).toBe("Play again");
  } finally { await done(dom); }
});

test("a replay that cannot be read keeps the run id out of the heading", async () => {
  const dom = installDom();
  const fixture = { ...journeyFixture(), id: "run_gone_7f3a", list: [] };
  const api = apiFor(fixture, { ops: [] }, { "run.get": () => { throw new Error("boom"); } });
  try {
    await mount(dom, <TaskContext.Provider value={{ state: stateFor(fixture, ALL_OPS), api }}><JourneyPlayback runId={fixture.id} query={query} /></TaskContext.Provider>);
    await until(() => domText(dom.container).includes("Couldn't load this run"), 3000);
    expect(domText(dom.container)).not.toContain("run_gone_7f3a");
    expect(domText(dom.container)).not.toContain("boom");
  } finally { await unmount(dom); dom.restore(); }
});
