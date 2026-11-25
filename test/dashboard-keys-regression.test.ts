/**
 * Table regression: every existing global / list key keeps its pre-Runs behaviour
 * after SCREEN_KEYS["6"] = "runs" is added (Phase 8 Task 1 review focus).
 */
import { expect, test } from "bun:test";
import { renderDashboard, screenItems } from "../src/dashboard/render";
import { PLAIN_THEME } from "../src/dashboard/theme";
import { runViewScreen } from "../src/dashboard/screens/run";
import { initialState, reduceKey, SCREEN_KEYS, type Act, type Item, type KeyContext, type UiState } from "../src/dashboard/state";
import type { DashData, RunDetail, ScreenCtx } from "../src/dashboard/screens/types";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import fixture from "./fixtures/ui/snapshot.json";

const act = (label: string, extra: Partial<Act> = {}): Act => ({
  label, effect: { type: "action", action: { label, op: `op.${label}`, params: {} } }, ...extra,
});
const items: Item[] = [
  { id: "a", primary: act("first"), actions: [act("second")], keys: { x: act("dismiss"), s: act("stop", { confirm: { title: "Stop?", yes: "Stop" } }) } },
  { id: "b", actions: [], keys: {} },
];
const baseTabs = ["home", "review", "sessions", "runs", "settings"] as const;
const ctx = (extra: Partial<KeyContext> = {}): KeyContext => ({
  items, tabs: [...baseTabs], page: 10, wide: true, hasDetail: false, repos: ["r1"], supports: () => true, ...extra,
});
const press = (state: UiState, keys: string[], c = ctx()) => keys.reduce((s, k) => reduceKey(s, k, c).state, state);

/** Keys that existed before Runs was added, and the observable outcome they must still produce. */
const EXISTING: { key: string; check: (r: ReturnType<typeof reduceKey>) => void; note: string }[] = [
  { key: "1", note: "Home", check: r => expect(r.state.screen).toBe("home") },
  { key: "2", note: "Needs you", check: r => expect(r.state.screen).toBe("review") },
  { key: "3", note: "Tasks", check: r => expect(r.state.screen).toBe("sessions") },
  { key: "4", note: "Settings", check: r => expect(r.state.screen).toBe("settings") },
  { key: "5", note: "Setup when offered", check: r => expect(r.state.screen).toBe("setup") },
  { key: "tab", note: "next tab", check: r => expect(r.state.screen).toBe("review") },
  { key: "backtab", note: "prev tab from home wraps to settings", check: r => expect(r.state.screen).toBe("settings") },
  { key: ",", note: "Settings shortcut", check: r => expect(r.state.screen).toBe("settings") },
  { key: "R", note: "Refresh", check: r => expect(r.refresh).toBe(true) },
  { key: "\x12", note: "Ctrl-R refresh", check: r => expect(r.refresh).toBe(true) },
  { key: "f", note: "Repo scope", check: r => expect(r.state.scope).toBe("r1") },
  { key: "q", note: "Quit", check: r => expect(r.quit).toBe(true) },
  { key: "?", note: "Help", check: r => expect(r.state.overlay).toEqual({ kind: "help" }) },
  { key: "j", note: "Select down", check: r => expect(r.state.selected.home).toBe("b") },
  { key: "k", note: "Select up from second", check: r => expect(r.state.selected.home).toBe("a") },
  { key: "enter", note: "Primary", check: r => expect(r.effect).toEqual(items[0]!.primary!.effect) },
  { key: ".", note: "Actions menu", check: r => expect(r.state.overlay).toMatchObject({ kind: "menu" }) },
  { key: "x", note: "Row key", check: r => expect(r.effect).toEqual(items[0]!.keys.x!.effect) },
];

test("SCREEN_KEYS keeps 1-5 and adds 6=runs; R is not a screen key", () => {
  expect(SCREEN_KEYS["1"]).toBe("home");
  expect(SCREEN_KEYS["2"]).toBe("review");
  expect(SCREEN_KEYS["3"]).toBe("sessions");
  expect(SCREEN_KEYS["4"]).toBe("settings");
  expect(SCREEN_KEYS["5"]).toBe("setup");
  expect(SCREEN_KEYS["6"]).toBe("runs");
  expect(SCREEN_KEYS["R"]).toBeUndefined();
});

test("existing keys keep their pre-Runs outcomes", () => {
  for (const row of EXISTING) {
    let state = initialState();
    let c = ctx();
    if (row.key === "5") c = ctx({ tabs: ["home", "review", "sessions", "runs", "settings", "setup"] });
    if (row.key === "k") state = press(initialState(), ["j"], c);
    const result = reduceKey(state, row.key, c);
    try {
      row.check(result);
    } catch (error) {
      throw new Error(`key ${JSON.stringify(row.key)} (${row.note}): ${error instanceof Error ? error.message : error}`);
    }
  }
});

test("Tab / Shift-Tab cycle includes runs", () => {
  const toRuns = reduceKey(initialState("sessions"), "tab", ctx());
  expect(toRuns.state.screen).toBe("runs");
  const toSettings = reduceKey(toRuns.state, "tab", ctx());
  expect(toSettings.state.screen).toBe("settings");
  const back = reduceKey(toSettings.state, "backtab", ctx());
  expect(back.state.screen).toBe("runs");
});

test("run-view keys stay inert on other screens with real screen items", () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  const now = s.at;
  const runKeys = ["a", "p", "s", "P", "A", "m"] as const;
  for (const screen of ["home", "review", "sessions", "settings"] as const) {
    const real = screenItems(s, now, { state: { screen }, ops: ["task.stop", "task.review", "task.attach", "attention.dismiss", "task.dismiss"] });
    for (const key of runKeys) {
      const result = reduceKey(initialState(screen), key, ctx({ items: real }));
      // Home/review/sessions may have their own s (stop) / a (accept) — assert run-only keys stay inert.
      if (key === "s" || (key === "a" && screen === "review")) continue;
      expect(result.effect, `${screen}/${key}`).toBeUndefined();
      expect(result.state.overlay, `${screen}/${key}`).toBeNull();
    }
  }
});

test("key 6 opens Runs when the tab is offered; ignored when not", () => {
  expect(reduceKey(initialState(), "6", ctx({ tabs: ["home", "review", "sessions", "settings"] })).state.screen).toBe("home");
  expect(reduceKey(initialState(), "6", ctx()).state.screen).toBe("runs");
});

const now = 1_800_000_000;
const runDetail = (): RunDetail => ({
  run: {
    id: "r-aaaaaaaaaa", workflow: "feature", version: 1, title: "Ship", status: "running", rev: 2,
    createdAt: now - 60, updatedAt: now, orchestratorTaskId: "t-20261123-160000-aaaa",
  },
  steps: [
    { runId: "r-aaaaaaaaaa", stepId: "ask", attempt: 1, status: "waiting", startedAt: now - 10 },
  ],
  graphs: [],
  definition: { entry: "ask", edges: [], steps: { ask: { type: "human" } } },
  questions: [],
});

function runCtx(ops: readonly string[], detail: RunDetail = runDetail()): ScreenCtx {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  const data: DashData = {
    details: new Map(),
    settings: {},
    runs: { value: [detail.run] },
    runDetails: new Map([[detail.run.id, { value: detail }]]),
  };
  return {
    s, now, theme: PLAIN_THEME,
    state: { ...initialState("runs"), runView: detail.run.id, selected: { runs: "step:ask:1:" } },
    width: 118, height: 34, wide: true,
    supports: op => ops.includes(op),
    data,
    timeZone: "UTC",
  };
}

test("ops gating through runViewScreen: p P A m appear only when catalogued", () => {
  const withOps = runViewScreen(runCtx(["run.pause", "run.set_priority", "run.set_auto", "msg.send", "run.stop", "run.answer"]), "r-aaaaaaaaaa");
  expect(withOps.items[0]?.keys.p).toBeDefined();
  expect(withOps.items[0]?.keys.P).toBeDefined();
  expect(withOps.items[0]?.keys.A).toBeDefined();
  expect(withOps.items[0]?.keys.m).toBeDefined();

  const without = runViewScreen(runCtx(["run.stop"]), "r-aaaaaaaaaa");
  expect(without.items[0]?.keys.p).toBeUndefined();
  expect(without.items[0]?.keys.P).toBeUndefined();
  expect(without.items[0]?.keys.A).toBeUndefined();
  expect(without.items[0]?.keys.m).toBeUndefined();
  expect(without.items[0]?.keys.s).toBeDefined();
});

test("stop-confirm uses runViewScreen's real s act", () => {
  const view = runViewScreen(runCtx(["run.stop", "run.answer"]), "r-aaaaaaaaaa");
  const item = view.items[0]!;
  expect(item.keys.s).toBeDefined();
  const asked = reduceKey(
    { ...initialState("runs"), runView: "r-aaaaaaaaaa", selected: { runs: item.id } },
    "s",
    ctx({ items: view.items, hasDetail: true }),
  );
  expect(asked.state.overlay).toMatchObject({ kind: "confirm", title: "Stop this run?" });
});

test("paused without run.resume offers neither Pause nor Resume", () => {
  const detail = runDetail();
  detail.run.status = "paused";
  detail.run.reason = "budget";
  const view = runViewScreen(runCtx(["run.pause", "run.stop"], detail), "r-aaaaaaaaaa");
  expect(view.items[0]?.keys.p).toBeUndefined();
});

test("hostile text is sanitized in titles, questions, results and errors", () => {
  const detail = runDetail();
  detail.run.title = "Ship\u202E\u200B it\x1b[31m";
  detail.steps[0]!.error = "boom\u202E\nline2";
  detail.steps[0]!.result = { note: "ok\u200B😀" };
  detail.questions = [{
    id: "q-1", runId: detail.run.id, stepId: "ask",
    text: "Go?\u202E\u200B", answerType: "text", blocks: "step", status: "open", answerer: "person", rev: 1,
  }];
  const text = renderDashboard(
    structuredClone(fixture) as unknown as ClientSnapshot,
    120, 40, now,
    {
      theme: PLAIN_THEME,
      state: { screen: "runs", runView: detail.run.id, selected: { runs: "step:ask:1:" } },
      data: {
        details: new Map(),
        settings: {},
        runs: { value: [detail.run] },
        runDetails: new Map([[detail.run.id, { value: detail }]]),
      },
      ops: ["run.stop", "question.answer"],
      timeZone: "UTC",
    },
  );
  expect(text).not.toContain("\u202E");
  expect(text).not.toContain("\u200B");
  expect(text).not.toContain("\x1b[31m");
  expect(text).toContain("Ship");
  expect(text).toContain("Go?");
});
