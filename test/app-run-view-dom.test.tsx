/** DOM interaction tests for the run view boards 1-5. Each test can fail: it asserts on rendered text and on the calls made. */
import { expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { ApiError } from "../app/src/data/api";
import { TaskContext } from "../app/src/screens/task-shared";
import { RunsPage } from "../app/src/screens/runs/RunsPage";
import { ArtifactText } from "../app/src/screens/runs/run-shared";
import { RunView } from "../app/src/screens/runs/RunView";
import { clickText, domText, installDom, isDisabled, mount, submitForm, tick, until, unmount } from "./app-setup-health-dom";
import {
  ALL_OPS, WAKE_AT_1800_VN, apiFor, evidence, failed, fanout, generated, joined, paused, plain, plannerAtLimit, stateFor, type Calls, type Fixture,
} from "./app-run-view-fixtures";

const query = { repo: null, scope: null };

type Node = { childNodes?: Node[]; nodeType: number; tagName?: string; data?: string; value?: string; attrs?: Record<string, string>; l?: Record<string, (e: unknown) => void>; _listeners?: Record<string, (e: unknown) => void>; getAttribute?: (n: string) => string | null; click?: () => void };
function all(root: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => { if (n.nodeType === 1) out.push(n); for (const c of n.childNodes ?? []) walk(c); };
  walk(root);
  return out;
}
const text = (n: Node): string => n.nodeType === 3 ? String(n.data ?? "") : (n.childNodes ?? []).map(text).join("");
function control(root: unknown, tag: string, pred: (n: Node) => boolean): Node | undefined {
  return all(root as Node).find(n => String(n.tagName).toLowerCase() === tag && pred(n));
}
function fire(node: Node, type: string) {
  const ev = { type, bubbles: true, cancelable: true, defaultPrevented: false, target: node, currentTarget: node, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {} };
  (node.l?.[`${type}false`] ?? node.l?.[`${type}true`] ?? node.l?.[type] ?? node._listeners?.[type])?.call(node, ev);
}
function radio(root: unknown, value: string): Node {
  const r = control(root, "input", n => n.getAttribute?.("type") === "radio" && n.getAttribute?.("value") === value);
  if (!r) throw new Error(`no radio ${value}`);
  return r;
}
function formOf(node: Node): { submit(): void } {
  let cur = node as Node & { parentNode?: Node & { submit?: () => void } };
  while (cur && String(cur.tagName).toLowerCase() !== "form") cur = (cur.parentNode ?? null) as typeof cur;
  if (!cur) throw new Error("no enclosing form");
  return cur as unknown as { submit(): void };
}
function pressed(root: unknown, label: string): boolean | null {
  const b = control(root, "button", n => text(n).trim() === label);
  return b ? b.getAttribute?.("aria-pressed") === "true" : null;
}

async function open(fixture: Fixture, ops = ALL_OPS, handlers: Parameters<typeof apiFor>[2] = {}, wrapRun = true) {
  const dom = installDom();
  const calls: Calls = { ops: [] };
  const api = apiFor(fixture, calls, handlers);
  await mount(dom, (
    <TaskContext.Provider value={{ state: stateFor(fixture, ops), api }}>
      {wrapRun ? <RunView runId={fixture.id} query={query} /> : <RunsPage query={query} runId={fixture.id} />}
    </TaskContext.Provider>
  ));
  await until(() => domText(dom.container).includes("Ship the board") || domText(dom.container).includes("Couldn't load"), 3000);
  // Flush passive effects of components that mounted after the async load (outside act).
  await act(async () => { await tick(); });
  // Preact flushes passive effects after paint (rAF raced against a 100 ms timeout); wait past it so a form's
  // mount-time reset effect cannot run after the test's first interaction.
  await new Promise(resolve => setTimeout(resolve, 130));
  return { dom, calls, api };
}
const done = async (dom: Awaited<ReturnType<typeof open>>["dom"]) => { await unmount(dom); dom.restore(); };

test("board 1: the strip marks the step that waits on you, the rail lists the decision with its reason and the message", async () => {
  const { dom, calls } = await open(plain);
  try {
    const t = domText(dom.container);
    expect(t).toContain("Ship the board");
    expect(t).toContain("Waits on you");
    // the finished step is not marked as waiting on you
    const strip = control(dom.container, "ol", n => n.getAttribute?.("aria-label") === "Run steps")!;
    const items = all(strip).filter(n => n.tagName === "li");
    expect(items.map(i => text(i).includes("Waits on you"))).toEqual([false, true]);
    expect(text(items[0]!)).toContain("Done");
    // the rail
    expect(t).toContain("Planner decided");
    expect(t).toContain("The brief asks for a new screen.");
    expect(t).toContain("Keep it small.");
    expect(t).toContain("To the planner");
    // run.seen once for this run
    expect(calls.ops.filter(c => c.op === "run.seen")).toEqual([{ op: "run.seen", params: { id: "run_1" } }]);
  } finally { await done(dom); }
});

test("opening the run from the Runs route renders the run view, not the list", async () => {
  const { dom } = await open(plain, ALL_OPS, {}, false);
  try {
    expect(domText(dom.container)).toContain("Waits on you");
    // the list is not drawn; the header offers the way back
    expect(control(dom.container, "section", n => n.getAttribute?.("aria-label") === "Runs")).toBeUndefined();
    expect(control(dom.container, "a", n => text(n).trim() === "All runs")).toBeDefined();
  } finally { await done(dom); }
});

test("the open question is drawn by the shared form and answering sends expect_rev, then refetches", async () => {
  const { dom, calls } = await open(plain);
  try {
    expect(domText(dom.container)).toContain("Approve the brainstormed spec?");
    expect(domText(dom.container)).toContain("Submit answer");
    // submit is disabled until a choice is made (no recommended option on this question)
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    fire(radio(dom.container, "approve"), "change");
    await tick();
    expect(isDisabled(dom.container, "Submit answer")).toBe(false);
    const getsBefore = calls.ops.filter(c => c.op === "run.get").length;
    submitForm(dom.container);
    await until(() => calls.ops.some(c => c.op === "question.answer"), 2000);
    expect(calls.ops.find(c => c.op === "question.answer")!.params).toEqual({ id: "q_spec", answer: "approve", expect_rev: 3 });
    await until(() => calls.ops.filter(c => c.op === "run.get").length > getsBefore, 2000);
    await until(() => domText(dom.container).includes("Answer submitted"), 2000);
    // focus returns to the run title instead of being dropped with the answered form
    await tick();
    expect((dom.doc as unknown as { activeElement: Node | null }).activeElement && text((dom.doc as unknown as { activeElement: Node }).activeElement)).toContain("Ship the board");
  } finally { await done(dom); }
});

test("a stale answer shows the conflict, and Reload refetches the run", async () => {
  const { dom, calls } = await open(plain, ALL_OPS, { "question.answer": () => { throw new ApiError("conflict", "stale"); } });
  try {
    fire(radio(dom.container, "approve"), "change");
    await tick();
    submitForm(dom.container);
    await until(() => domText(dom.container).includes("This question changed"), 2000);
    expect(isDisabled(dom.container, "Submit answer")).toBe(true);
    const before = calls.ops.filter(c => c.op === "run.get").length;
    clickText(dom.container, "Reload");
    await until(() => calls.ops.filter(c => c.op === "run.get").length > before, 2000);
  } finally { await done(dom); }
});

test("messages to the planner go to the orchestrator task; the form is absent without msg.send", async () => {
  const { dom, calls } = await open(plain);
  try {
    expect(domText(dom.container)).toContain("Message the planner");
    expect(isDisabled(dom.container, "Send to planner")).toBe(true);
    const box = control(dom.container, "textarea", () => true)!;
    box.value = "Please skip the docs."; fire(box, "input");
    await tick();
    expect(isDisabled(dom.container, "Send to planner")).toBe(false);
    formOf(box).submit();
    await until(() => calls.ops.some(c => c.op === "msg.send"), 2000);
    expect(calls.ops.find(c => c.op === "msg.send")!.params).toEqual({ to: "task:t_orch", body: "Please skip the docs." });
    await until(() => domText(dom.container).includes("Message sent to the planner"), 2000);
  } finally { await done(dom); }
  const second = await open(plain, ALL_OPS.filter(o => o !== "msg.send"));
  try {
    expect(domText(second.dom.container)).not.toContain("Message the planner");
    expect(second.calls.ops.some(c => c.op === "msg.send")).toBe(false);
  } finally { await done(second.dom); }
});

test("without question.answer the form offers no submit (gated on the op catalog)", async () => {
  const { dom } = await open(plain, ALL_OPS.filter(o => o !== "question.answer"));
  try {
    expect(domText(dom.container)).toContain("Approve the brainstormed spec?");
    expect(domText(dom.container)).not.toContain("Submit answer");
  } finally { await done(dom); }
});

test("board 2: brainstorm shows the planner lane beside the forming spec; questions use the shared form", async () => {
  const { dom } = await open(plain, ALL_OPS, {});
  try {
    expect(pressed(dom.container, "Brainstorm")).toBe(false);
    clickText(dom.container, "Brainstorm");
    await act(async () => { await tick(); });
    expect(pressed(dom.container, "Brainstorm")).toBe(true);
    const t = domText(dom.container);
    expect(t).toContain("Questions from the planner");
    expect(t).toContain("Approve the brainstormed spec?");
    expect(t).toContain("Submit answer");
    expect(control(dom.container, "section", n => n.getAttribute?.("aria-label") === "Planner conversation")).toBeDefined();
    expect(t).toContain("Latest version:");
    expect(t).toContain("Spec draft");
    // the overview-only strip is gone on this board
    expect(control(dom.container, "ol", n => n.getAttribute?.("aria-label") === "Run steps")).toBeUndefined();
  } finally { await done(dom); }
});

test("board 3: reviewer lanes show findings per reviewer, the join stays pending until reviewers finish", async () => {
  const { dom } = await open(fanout);
  try {
    clickText(dom.container, "Reviewers");
    await act(async () => { await tick(); });
    const t = domText(dom.container);
    expect(t).toContain("1 of 3 reviewers finished");
    const arch = control(dom.container, "li", n => n.getAttribute?.("data-reviewer") === "architecture")!;
    expect(text(arch)).toContain("Name the store module clearly");
    expect(text(arch)).toContain("minor: Add a loading state");
    expect(text(arch)).toContain("Pass");
    const ux = control(dom.container, "li", n => n.getAttribute?.("data-reviewer") === "ux")!;
    expect(text(ux)).toContain("Needs changes");
    expect(text(ux)).toContain("No findings reported.");
    const security = control(dom.container, "li", n => n.getAttribute?.("data-reviewer") === "security")!;
    expect(text(security)).toContain("Running");
    expect(text(security)).not.toContain("No findings reported.");
    expect(t).toContain("Waiting for reviewers");
    expect(t).toContain("You: Chose a path (revise).");
    expect(t).toContain("Take the UX note.");
  } finally { await done(dom); }
  const j = await open(joined);
  try {
    clickText(j.dom.container, "Reviewers");
    await act(async () => { await tick(); });
    expect(domText(j.dom.container)).toContain("Panel agrees.");
    expect(domText(j.dom.container)).not.toContain("Waiting for reviewers");
  } finally { await done(j.dom); }
});

test("board 4: waves come from the generated child run, with blocked steps and liveness", async () => {
  const { dom, calls } = await open(generated);
  try {
    expect(calls.ops.some(c => c.op === "run.get" && (c.params as { id: string }).id === "run_child")).toBe(true);
    clickText(dom.container, "Execution");
    await act(async () => { await tick(); });
    const t = domText(dom.container);
    expect(t).toContain("Waves from the generated plan.");
    const waves = all(dom.container as unknown as Node).filter(n => n.tagName === "li" && /^Wave \d$/.test(String(n.getAttribute?.("aria-label"))));
    expect(waves.map(w => w.getAttribute!("aria-label"))).toEqual(["Wave 1", "Wave 2", "Wave 3"]);
    expect(text(waves[0]!)).toContain("api");
    expect(["ui", "docs"].every(s => text(waves[1]!).includes(s))).toBe(true);
    expect(text(waves[2]!)).toContain("tests");
    expect(text(waves[2]!)).toContain("Blocked until ui, docs finish.");
    expect(text(waves[2]!)).toContain("Not started");
    expect(t).toMatch(/Stalled since/);
    expect(t).toContain("Waiting on the build");
  } finally { await done(dom); }
});

test("a failed step reads Failed in the strip and the run header", async () => {
  const { dom } = await open(failed);
  try {
    const strip = control(dom.container, "ol", n => n.getAttribute?.("aria-label") === "Run steps")!;
    expect(text(strip)).toContain("Failed");
    expect(domText(dom.container)).toContain("Failed");
    expect(domText(dom.container)).not.toContain("Waits on you");
  } finally { await done(dom); }
});

test("a paused run says why, in plain words", async () => {
  const { dom } = await open(paused);
  try {
    expect(domText(dom.container)).toContain("Paused by strict pacing");
    expect(domText(dom.container)).not.toContain("pacing: strict");
  } finally { await done(dom); }
});

test("planner at limit shows its wake time as the orchestrator block", async () => {
  const { dom } = await open(plannerAtLimit);
  try {
    // Wall-clock time in the machine's zone, computed the way the view model does, so the test holds in any TZ.
    const until = new Date(WAKE_AT_1800_VN * 1000).toLocaleTimeString("en-GB", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
    expect(domText(dom.container)).toContain(`Planner at limit until ${until}`);
    expect(domText(dom.container)).toContain("The planner is blocked");
    expect(domText(dom.container)).not.toContain("Planner: Planner");
  } finally { await done(dom); }
  const ok = await open(plain);
  try { expect(domText(ok.dom.container)).not.toContain("at limit"); } finally { await done(ok.dom); }
});

test("board 5: evidence with pass, fail and unverified, artifact links, branch, PR and the publish approval", async () => {
  const { dom, calls } = await open(evidence);
  try {
    clickText(dom.container, "Tests and PR");
    await act(async () => { await tick(); });
    const t = domText(dom.container);
    expect(t).toContain("1 passed");
    expect(t).toContain("1 failed");
    expect(t).toContain("1 unverified");
    const surfaces = Object.fromEntries(all(dom.container as unknown as Node).filter(n => n.getAttribute?.("data-surface")).map(n => [n.getAttribute!("data-surface")!, text(n)]));
    expect(surfaces["web runs page"]).toContain("Passed");
    expect(surfaces["web runs page"]).toContain("Runs page screenshot");
    expect(surfaces["desktop app"]).toContain("Failed");
    expect(surfaces["tui"]).toContain("Unverified");
    expect(surfaces["tui"]).toContain("Not checked: nothing was driven for this surface.");
    expect(surfaces["tui"]).toContain("1 attached file could not be found.");
    expect(t).toContain("pacer/run-1");
    const pr = control(dom.container, "a", n => text(n).trim() === "Open pull request")!;
    expect(pr.getAttribute!("href")).toBe("https://example.test/acme/web/pull/7");
    expect(pr.getAttribute!("rel")).toContain("noopener");
    const art = control(dom.container, "a", n => text(n).trim() === "Runs page screenshot")!;
    expect(art.getAttribute!("href")).toBe("/v3/runs/run_1/artifacts/art_bbbbbbbbbb");
    // the publish question
    expect(t).toContain("Publish approval");
    expect(t).toContain("Approve publishing this run?");
    fire(radio(dom.container, "approve"), "change");
    await tick();
    submitForm(dom.container);
    await until(() => calls.ops.some(c => c.op === "question.answer"), 2000);
    expect(calls.ops.find(c => c.op === "question.answer")!.params).toEqual({ id: "q_pub", answer: "approve", expect_rev: 1 });
  } finally { await done(dom); }
});

test("a PR url that is not a web link is shown as text, never as a link", async () => {
  const bad: Fixture = { ...evidence, get: { ...evidence.get, run: { ...evidence.get.run, prUrl: "javascript:alert(1)" } } };
  const { dom } = await open(bad);
  try {
    clickText(dom.container, "Tests and PR");
    await act(async () => { await tick(); });
    expect(control(dom.container, "a", n => text(n).trim() === "Open pull request")).toBeUndefined();
    expect(domText(dom.container)).toContain("javascript:alert(1)");
  } finally { await done(dom); }
});

test("boards the run has no data for are not offered", async () => {
  const bare: Fixture = { id: "run_1", get: { run: { ...plain.get.run, orchestratorTaskId: undefined }, steps: [{ runId: "run_1", stepId: "only", attempt: 1, status: "running", startedAt: 1 }] } };
  const { dom } = await open(bare);
  try {
    for (const label of ["Brainstorm", "Reviewers", "Execution", "Tests and PR"]) expect(pressed(dom.container, label)).toBeNull();
  } finally { await done(dom); }
});

test("an unreadable run shows a plain error with Try again, and no op names", async () => {
  const { dom } = await open(plain, ALL_OPS, { "run.get": () => { throw new ApiError("internal", "boom"); } });
  try {
    expect(domText(dom.container)).toContain("Couldn't load this run");
    expect(domText(dom.container)).toContain("Try again");
  } finally { await done(dom); }
});

// ---- review batch: races, stale data, runId change, keyboard order, planner states

const plainState = (f: Fixture, bump = 0) => { const st = stateFor(f, ALL_OPS); return { ...st, invalidations: { runs: bump } }; };
async function mountWith(fixture: Fixture, handlers: Parameters<typeof apiFor>[2]) {
  const dom = installDom();
  const calls: Calls = { ops: [] };
  const api = apiFor(fixture, calls, handlers);
  const render = (bump: number, id = fixture.id) => mount(dom, (
    <TaskContext.Provider value={{ state: plainState(fixture, bump), api }}><RunView runId={id} query={query} /></TaskContext.Provider>
  ));
  await render(0);
  await until(() => domText(dom.container).includes("Ship the board"), 3000);
  await act(async () => { await tick(); });
  await new Promise(resolve => setTimeout(resolve, 130)); // let mount-time effects flush (see open())
  return { dom, calls, render };
}

test("load race: a slow response for an older load never overwrites a newer one", async () => {
  let n = 0;
  let releaseSlow: () => void = () => {};
  const slowGate = new Promise<void>(r => { releaseSlow = r; });
  const { dom, render } = await mountWith(plain, {
    "run.get": async () => {
      n++;
      const title = n === 2 ? "Slow old title" : n >= 3 ? "Fresh new title" : "Ship the board";
      if (n === 2) await slowGate;
      return { ...plain.get, run: { ...plain.get.run, title } };
    },
    "msg.send": () => ({}),
  });
  try {
    // 1) a message send starts load #2 (held); 2) an invalidation starts load #3 (fast, newest)
    const box = control(dom.container, "textarea", () => true)!;
    box.value = "hi"; fire(box, "input"); await tick();
    formOf(box).submit();
    await until(() => n >= 2, 2000);
    await render(1);
    await until(() => domText(dom.container).includes("Fresh new title"), 3000);
    releaseSlow();
    await new Promise(r => setTimeout(r, 80));
    expect(domText(dom.container)).toContain("Fresh new title");
    expect(domText(dom.container)).not.toContain("Slow old title");
  } finally { await done(dom); }
});

test("a failed refresh after a good load flags the data as out of date and keeps it on screen", async () => {
  let fail = false;
  const { dom, render } = await mountWith(plain, { "run.get": () => { if (fail) throw new ApiError("internal", "boom"); return plain.get; } });
  try {
    expect(domText(dom.container)).not.toContain("may be out of date");
    fail = true;
    await render(1);
    await until(() => domText(dom.container).includes("This run may be out of date"), 3000);
    expect(domText(dom.container)).toContain("Ship the board");
    expect(domText(dom.container)).not.toContain("boom");
    expect(control(dom.container, "button", n => text(n).trim() === "Try again")).toBeDefined();
    fail = false;
    clickText(dom.container, "Try again");
    await until(() => !domText(dom.container).includes("may be out of date"), 3000);
  } finally { await done(dom); }
});

test("run.seen fires once per run: same-run reloads do not repeat it, a different run does", async () => {
  const other: Fixture = { ...plain, id: "run_2", get: { ...plain.get, run: { ...plain.get.run, id: "run_2", title: "Second run" } } };
  const { dom, calls, render } = await mountWith(plain, { "run.get": p => ((p as { id: string }).id === "run_2" ? other.get : plain.get) });
  try {
    const seen = () => calls.ops.filter(c => c.op === "run.seen").map(c => (c.params as { id: string }).id);
    const gets = () => calls.ops.filter(c => c.op === "run.get").length;
    expect(seen()).toEqual(["run_1"]);
    const g0 = gets();
    await render(1); await render(2);
    await until(() => gets() >= g0 + 2, 2000);
    expect(seen()).toEqual(["run_1"]);
    // board and announcement reset when the run changes in the same instance
    clickText(dom.container, "Brainstorm");
    await act(async () => { await tick(); });
    expect(pressed(dom.container, "Brainstorm")).toBe(true);
    await render(2, "run_2");
    await until(() => seen().length === 2, 2000);
    expect(seen()).toEqual(["run_1", "run_2"]);
    await until(() => domText(dom.container).includes("Second run"), 3000);
    expect(pressed(dom.container, "Brainstorm")).toBe(false);
    expect(pressed(dom.container, "Overview")).toBe(true);
    expect(domText(dom.container)).not.toContain("Brainstorm board shown");
  } finally { await done(dom); }
});

test("after a conflict and Reload the new question version replaces the old form and submits its rev", async () => {
  let version = 1;
  const q = () => [{ ...plain.questions![0]!, rev: version === 1 ? 3 : 4, text: version === 1 ? "Approve the brainstormed spec?" : "Approve the revised spec?" }];
  const answers: Array<Record<string, unknown>> = [];
  const { dom } = await mountWith(plain, {
    "question.list": () => q(),
    "question.answer": p => { answers.push(p as Record<string, unknown>); if ((p as { expect_rev: number }).expect_rev !== (version === 1 ? 3 : 4)) throw new ApiError("conflict", "stale"); return {}; },
  });
  try {
    version = 2; // the server moves on while the form is open
    fire(radio(dom.container, "approve"), "change"); await tick();
    submitForm(dom.container);
    await until(() => domText(dom.container).includes("This question changed"), 2000);
    expect(domText(dom.container)).toContain("review it again");
    clickText(dom.container, "Reload");
    await until(() => domText(dom.container).includes("Approve the revised spec?"), 3000);
    expect(domText(dom.container)).not.toContain("Approve the brainstormed spec?");
    expect(domText(dom.container)).not.toContain("review it again");
    await act(async () => { await new Promise(r => setTimeout(r, 130)); });
    fire(radio(dom.container, "approve"), "change"); await tick();
    submitForm(dom.container);
    await until(() => answers.length === 2, 2000);
    expect(answers[1]).toMatchObject({ id: "q_spec", expect_rev: 4 });
  } finally { await done(dom); }
});

test("board switch buttons are native buttons in order, stay in the tab order, and switching is announced", async () => {
  const { dom } = await open(fanout);
  try {
    const group = control(dom.container, "div", n => n.getAttribute?.("aria-label") === "Run boards")!;
    const buttons = all(group).filter(n => n.tagName === "button");
    expect(buttons.map(b => text(b).trim())).toEqual(["Overview", "Brainstorm", "Reviewers"]);
    // native <button type=button> with no negative tabindex: Tab reaches each, Enter and Space activate them
    for (const b of buttons) {
      expect(b.getAttribute!("type")).toBe("button");
      expect(b.getAttribute!("tabindex")).toBeNull();
      expect(b.getAttribute!("disabled")).toBeNull();
    }
    const live = control(dom.container, "p", n => n.getAttribute?.("role") === "status" && n.getAttribute?.("aria-live") === "polite")!;
    expect(text(live)).toBe("");
    clickText(dom.container, "Reviewers");
    await act(async () => { await tick(); });
    expect(text(control(dom.container, "p", n => n.getAttribute?.("role") === "status" && n.getAttribute?.("aria-live") === "polite")!)).toBe("Reviewers board shown");
  } finally { await done(dom); }
});

test("the planner banner follows the structured state, not the wording", async () => {
  for (const [orch, alert] of [
    [{ state: "blocked", reason: "planner at limit" }, true],
    [{ state: "blocked", reason: "turn budget spent" }, true],
    [{ state: "blocked", reason: "some reworded explanation" }, true],
    [{ state: "retrying", reason: "planner failed 1×, retrying" }, true],
    [{ state: "retrying", reason: "planner failed 3×" }, true],
    [{ state: "turn" }, false],
    [{ state: "idle" }, false],
  ] as const) {
    const f: Fixture = { ...plain, get: { ...plain.get, run: { ...plain.get.run, orchestrator: orch } } };
    const { dom } = await open(f);
    try {
      const t = domText(dom.container);
      expect(t.includes("The planner is blocked") || t.includes("The planner is retrying")).toBe(alert);
      expect(t).not.toContain("Planner: Planner");
    } finally { await done(dom); }
  }
});

test("ArtifactText reads the file again when the revision changes, even at the same length", async () => {
  const dom = installDom();
  try {
    let body = "AAAA";
    let reads = 0;
    const art = { id: "art_aaaaaaaaaa", label: "Spec", name: "spec.md", mime: "text/markdown", size: 4, stepId: "s" };
    const fetchText = async () => { reads++; return body; };
    const render = (rev: number) => mount(dom, <ArtifactText runId="run_1" artifact={art} revision={rev} fetchText={fetchText} />);
    await render(1);
    await until(() => domText(dom.container).includes("AAAA"), 2000);
    body = "BBBB";
    await render(1);
    await tick();
    expect(domText(dom.container)).toContain("AAAA");
    await render(2);
    await until(() => domText(dom.container).includes("BBBB"), 2000);
    expect(reads).toBe(2);
    // the spec text is a keyboard stop with a name
    const pre = control(dom.container, "pre", () => true)!;
    expect(String((pre as unknown as { attrs: Record<string, string> }).attrs.tabIndex ?? (pre as unknown as { attrs: Record<string, string> }).attrs.tabindex)).toBe("0");
    expect(pre.getAttribute!("aria-label")).toBe("Spec");
  } finally { await unmount(dom); dom.restore(); }
});

// ---- Phase 9b review findings

const focused = (dom: Awaited<ReturnType<typeof open>>["dom"]) => (dom.doc as unknown as { activeElement: Node | null }).activeElement;
const heading = (root: unknown) => text(control(root, "h1", () => true)!);
const occurrences = (s: string, part: string) => s.split(part).length - 1;
async function withWarnings(body: (warned: () => string) => Promise<void>) {
  const original = console.warn;
  const seen: unknown[][] = [];
  console.warn = (...args: unknown[]) => { seen.push(args); };
  try { await body(() => seen.map(a => a.map(v => v instanceof Error ? v.message : String(v)).join(" ")).join("\n")); }
  finally { console.warn = original; }
}
async function sendMessage(root: unknown, body: string) {
  const box = control(root, "textarea", () => true)!;
  box.value = body; fire(box, "input"); await tick();
  formOf(box).submit();
  return box;
}

test("a failed send shows plain words, logs the raw error and keeps focus in the message box", async () => {
  await withWarnings(async warned => {
    const { dom } = await open(plain, ALL_OPS, { "msg.send": () => { throw new ApiError("internal", "boom SQLITE_BUSY"); } });
    try {
      const box = await sendMessage(dom.container, "hi");
      await until(() => domText(dom.container).includes("Couldn't send your message"), 2000);
      expect(domText(dom.container)).not.toContain("SQLITE_BUSY");
      expect(warned()).toContain("boom SQLITE_BUSY");
      expect(focused(dom)).toBe(box);
    } finally { await done(dom); }
  });
});

test("a sent message is announced once and focus stays in the message box", async () => {
  const { dom } = await open(plain, ALL_OPS, { "msg.send": () => ({}) });
  try {
    const box = await sendMessage(dom.container, "hi");
    await until(() => domText(dom.container).includes("Message sent to the planner"), 2000);
    await act(async () => { await tick(); });
    expect(occurrences(domText(dom.container), "Message sent to the planner")).toBe(1);
    expect(focused(dom)).toBe(box);
  } finally { await done(dom); }
});

test("a failed artifact read shows plain words and logs the raw error", async () => {
  await withWarnings(async warned => {
    const dom = installDom();
    try {
      const art = { id: "art_aaaaaaaaaa", label: "Spec", name: "spec.md", mime: "text/markdown", size: 4, stepId: "s" };
      await mount(dom, <ArtifactText runId="run_1" artifact={art} fetchText={async () => { throw new TypeError("NetworkError ECONNRESET"); }} />);
      await until(() => domText(dom.container).includes("Couldn't open the file"), 2000);
      expect(domText(dom.container)).toContain("The file could not be read.");
      expect(domText(dom.container)).not.toContain("ECONNRESET");
      expect(warned()).toContain("NetworkError ECONNRESET");
    } finally { await unmount(dom); dom.restore(); }
  });
});

test("the title is never the raw run id: snapshot title when known, plain words otherwise", async () => {
  for (const [runs, want] of [[[{ id: "run_1", title: "Snapshot title", status: "running", letter: "Q" }], "Snapshot title"], [[], "Run"]] as const) {
    const dom = installDom();
    try {
      const calls: Calls = { ops: [] };
      let release: () => void = () => {};
      const gate = new Promise<void>(r => { release = r; });
      const api = apiFor(plain, calls, { "run.list": () => [], "run.get": async () => { await gate; throw new ApiError("internal", "boom"); } });
      const base = stateFor(plain, ALL_OPS);
      const state = { ...base, snapshot: { ...base.snapshot!, runs: runs as never } };
      await mount(dom, <TaskContext.Provider value={{ state, api }}><RunView runId="run_1" query={query} /></TaskContext.Provider>);
      expect(domText(dom.container)).toContain("Loading run");
      expect(heading(dom.container)).toStartWith(want);
      expect(heading(dom.container)).not.toContain("run_1");
      release();
      await until(() => domText(dom.container).includes("Couldn't load this run"), 3000);
      expect(heading(dom.container)).toStartWith(want);
      expect(heading(dom.container)).not.toContain("run_1");
    } finally { await done(dom); }
  }
});

test("a slow answer to a send on one run cannot supersede the load of the next run", async () => {
  const dom = installDom();
  try {
    const calls: Calls = { ops: [] };
    let releaseSend: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const sendGate = new Promise<void>(r => { releaseSend = r; });
    const secondGate = new Promise<void>(r => { releaseSecond = r; });
    const api = apiFor(plain, calls, {
      "run.get": async p => {
        if ((p as { id: string }).id !== "run_2") return plain.get;
        await secondGate;
        return { ...plain.get, run: { ...plain.get.run, id: "run_2", title: "Second run" } };
      },
      "msg.send": async () => { await sendGate; return {}; },
    });
    const state = stateFor(plain, ALL_OPS);
    const render = (id: string) => mount(dom, <TaskContext.Provider value={{ state, api }}><RunsPage query={query} runId={id} /></TaskContext.Provider>);
    await render("run_1");
    await until(() => domText(dom.container).includes("Ship the board"), 3000);
    await act(async () => { await new Promise(r => setTimeout(r, 130)); });
    await sendMessage(dom.container, "hi");
    await until(() => calls.ops.some(c => c.op === "msg.send"), 2000);
    await render("run_2");
    await until(() => calls.ops.some(c => c.op === "run.get" && (c.params as { id: string }).id === "run_2"), 2000);
    releaseSend();
    await new Promise(r => setTimeout(r, 80));
    releaseSecond();
    await until(() => domText(dom.container).includes("Second run"), 2000);
  } finally { await done(dom); }
});

test("invalidations faster than a load still update the view, and a later failure keeps the newer data", async () => {
  const gates: Array<{ ok: () => void; fail: () => void }> = [];
  let n = 0;
  const { dom, render } = await mountWith(plain, {
    "run.get": () => {
      const mine = ++n;
      if (mine === 1) return plain.get;
      return new Promise((resolve, reject) => {
        gates.push({ ok: () => resolve({ ...plain.get, run: { ...plain.get.run, title: `Title ${mine}` } }), fail: () => reject(new ApiError("internal", "boom")) });
      });
    },
  });
  try {
    await render(1);
    await until(() => gates.length === 1, 2000);
    await render(2);
    await until(() => gates.length === 2, 2000);
    gates[0]!.ok(); // superseded, but the newer load has not answered yet
    await until(() => domText(dom.container).includes("Title 2"), 2000);
    gates[1]!.fail(); // started before "Title 2" arrived
    await until(() => domText(dom.container).includes("may be out of date"), 2000);
    expect(domText(dom.container)).toContain("Title 2");
  } finally { await done(dom); }
});

test("Try again on a failed load moves focus to the run title", async () => {
  let fail = true;
  const { dom } = await open(plain, ALL_OPS, { "run.get": () => { if (fail) throw new ApiError("internal", "boom"); return plain.get; } });
  try {
    fail = false;
    clickText(dom.container, "Try again");
    await until(() => domText(dom.container).includes("Waits on you"), 3000);
    await act(async () => { await tick(); });
    expect(String(focused(dom)?.tagName).toLowerCase()).toBe("h1");
  } finally { await done(dom); }
});

test("a failed run.seen can be retried from its alert", async () => {
  await withWarnings(async () => {
    let fail = true;
    const { dom, calls } = await open(plain, ALL_OPS, { "run.seen": () => { if (fail) throw new ApiError("internal", "boom"); return {}; } });
    try {
      await until(() => domText(dom.container).includes("Couldn't mark this run as seen"), 2000);
      fail = false;
      clickText(dom.container, "Mark as seen");
      await until(() => !domText(dom.container).includes("Couldn't mark this run as seen"), 2000);
      expect(calls.ops.filter(c => c.op === "run.seen")).toHaveLength(2);
      expect(String(focused(dom)?.tagName).toLowerCase()).toBe("h1");
    } finally { await done(dom); }
  });
});

test("a failed message log is said plainly and earlier messages stay", async () => {
  await withWarnings(async () => {
    let fail = false;
    const { dom, render } = await mountWith(plain, { "msg.log": () => { if (fail) throw new ApiError("internal", "boom"); return { messages: plain.messages }; } });
    try {
      expect(domText(dom.container)).not.toContain("Couldn't load the latest messages");
      fail = true;
      await render(1);
      await until(() => domText(dom.container).includes("Couldn't load the latest messages"), 3000);
      expect(domText(dom.container)).toContain("Keep it small.");
      expect(domText(dom.container)).not.toContain("boom");
      fail = false;
      await render(2);
      await until(() => !domText(dom.container).includes("Couldn't load the latest messages"), 3000);
    } finally { await done(dom); }
  });
});

test("the heading never guesses a letter: list title first, then snapshot, else a plain heading", async () => {
  const listed = { id: "run_1", workflow: "w", title: "Listed title", status: "done", priority: "normal", letter: "D", createdAt: 1 };
  const snap = [{ id: "run_1", title: "Snapshot title", status: "running", letter: "D" }];
  for (const [list, runs, want] of [[[listed], [], "Listed title"], [[listed], snap, "Listed title"], [null, [], "Run"], [[], [], "Run"]] as const) {
    const dom = installDom();
    try {
      const boom = () => { throw new ApiError("internal", "boom"); };
      const api = apiFor(plain, { ops: [] }, { "run.get": boom, "run.list": () => list ?? boom() });
      const base = stateFor(plain, ALL_OPS);
      const state = { ...base, snapshot: { ...base.snapshot!, runs: runs as never } };
      await withWarnings(async () => {
        await mount(dom, <TaskContext.Provider value={{ state, api }}><RunView runId="run_1" query={query} /></TaskContext.Provider>);
        // while loading, a run that neither source knows has no letter
        if (!runs.length) expect(heading(dom.container)).toBe("Run");
        await until(() => domText(dom.container).includes("Couldn't load this run"), 3000);
      });
      expect(heading(dom.container)).toBe(want);
      if (want === "Run") expect(all(dom.container as unknown as Node).some(n => n.getAttribute?.("aria-label")?.match(/^Run [A-Z]/))).toBe(false);
    } finally { await done(dom); }
  }
});

test("a retry that fails again leaves focus on its button", async () => {
  for (const [op, shown, label] of [["run.get", "Couldn't load this run", "Try again"], ["run.seen", "Couldn't mark this run as seen", "Mark as seen"]] as const) {
    await withWarnings(async () => {
      let release: () => void = () => {};
      let n = 0;
      const { dom, calls } = await open(plain, ALL_OPS, { [op]: async () => {
        if (++n > 1) await new Promise<void>(r => { release = r; });
        throw new ApiError("internal", "boom");
      } });
      try {
        await until(() => domText(dom.container).includes(shown), 2000);
        const button = control(dom.container, "button", b => text(b).trim() === label)!;
        (dom.doc as unknown as { activeElement: Node }).activeElement = button;
        clickText(dom.container, label);
        await until(() => calls.ops.filter(c => c.op === op).length === 2, 2000);
        await act(async () => { await tick(); });
        // still on the page while the call is in flight
        expect(control(dom.container, "button", b => text(b).trim() === label)).toBe(button);
        expect(focused(dom)).toBe(button);
        release();
        await new Promise(r => setTimeout(r, 80));
        expect(control(dom.container, "button", b => text(b).trim() === label)).toBe(button);
        expect(focused(dom)).toBe(button);
      } finally { await done(dom); }
    });
  }
});
