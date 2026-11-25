/** DOM interaction tests for the run view boards 1-5. Each test can fail: it asserts on rendered text and on the calls made. */
import { expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { ApiError } from "../app/src/data/api";
import { TaskContext } from "../app/src/screens/task-shared";
import { RunsPage } from "../app/src/screens/runs/RunsPage";
import { RunView } from "../app/src/screens/runs/RunView";
import { clickText, domText, installDom, isDisabled, mount, submitForm, tick, until, unmount } from "./app-setup-health-dom";
import {
  ALL_OPS, apiFor, evidence, failed, fanout, generated, joined, paused, plain, plannerAtLimit, stateFor, type Calls, type Fixture,
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
  await until(() => domText(dom.container).includes("Planner") || domText(dom.container).includes("Couldn't load"), 3000);
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
    expect(domText(dom.container)).toContain("Paused to stay within your usage limits");
    expect(domText(dom.container)).not.toContain("pacing: strict");
  } finally { await done(dom); }
});

test("planner at limit shows its wake time as the orchestrator block", async () => {
  const { dom } = await open(plannerAtLimit);
  try {
    expect(domText(dom.container)).toContain("Planner at limit until 18:00");
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
