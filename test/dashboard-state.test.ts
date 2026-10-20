import { expect, test } from "bun:test";
import { Keys } from "../src/dashboard/input";
import { initialState, reduceKey, type Act, type Item, type KeyContext, type UiState } from "../src/dashboard/state";

const act = (label: string, extra: Partial<Act> = {}): Act => ({ label, effect: { type: "action", action: { label, op: `op.${label}`, params: {} } }, ...extra });
const items: Item[] = [
  { id: "a", primary: act("first"), actions: [act("second")], keys: { x: act("dismiss") } },
  { id: "b", actions: [], keys: {} },
  { id: "c", primary: act("stop", { confirm: { title: "Stop?", yes: "Stop" } }), actions: [], keys: {} },
];
const ctx = (extra: Partial<KeyContext> = {}): KeyContext => ({ items, tabs: ["home", "review", "sessions", "settings"], page: 10, wide: true, hasDetail: false, repos: ["r1", "r2"], supports: () => true, ...extra });
const press = (state: UiState, keys: string[], c = ctx()) => keys.reduce((s, k) => reduceKey(s, k, c).state, state);

test("number keys, Tab and comma switch screens; unknown tabs are ignored", () => {
  expect(press(initialState(), ["2"]).screen).toBe("review");
  expect(press(initialState(), ["4"]).screen).toBe("settings");
  expect(press(initialState(), ["5"]).screen).toBe("home");
  expect(press(initialState(), ["5"], ctx({ tabs: ["home", "review", "sessions", "settings", "setup"] })).screen).toBe("setup");
  expect(press(initialState(), ["tab", "tab"]).screen).toBe("sessions");
  expect(press(initialState(), ["backtab"]).screen).toBe("settings");
  expect(press(initialState(), [","]).screen).toBe("settings");
});

test("selection moves by id within bounds and pages", () => {
  const state = press(initialState(), ["j", "j", "j", "down"]);
  expect(state.selected.home).toBe("c");
  expect(press(state, ["k", "up", "up"]).selected.home).toBe("a");
  expect(press(initialState(), ["pagedown"]).selected.home).toBe("c");
  expect(press(initialState(), ["end"]).selected.home).toBe("c");
});

test("Enter triggers the primary action; consequential actions confirm first", () => {
  const first = reduceKey(initialState(), "enter", ctx());
  expect(first.effect).toEqual(items[0]!.primary!.effect);
  const atStop = press(initialState(), ["j", "j"]);
  const asked = reduceKey(atStop, "enter", ctx());
  expect(asked.effect).toBeUndefined();
  expect(asked.state.overlay).toMatchObject({ kind: "confirm", title: "Stop?", yes: "Stop" });
  expect(reduceKey(asked.state, "n", ctx()).state.overlay).toBeNull();
  const confirmed = reduceKey(asked.state, "y", ctx());
  expect(confirmed.effect).toEqual(items[2]!.primary!.effect);
  expect(confirmed.state.overlay).toBeNull();
});

test("row keys and the actions menu reach every action; menu numbers choose", () => {
  expect(reduceKey(initialState(), "x", ctx()).effect).toEqual(items[0]!.keys.x!.effect);
  const menu = reduceKey(initialState(), ".", ctx()).state;
  expect(menu.overlay).toMatchObject({ kind: "menu", actions: [{ label: "first" }, { label: "second" }] });
  expect(reduceKey(menu, "2", ctx()).effect).toEqual(items[0]!.actions[0]!.effect);
  const moved = reduceKey(menu, "j", ctx()).state;
  expect(reduceKey(moved, "enter", ctx()).effect).toEqual(items[0]!.actions[0]!.effect);
  expect(reduceKey(menu, "escape", ctx()).state.overlay).toBeNull();
  expect(reduceKey(press(initialState(), ["j"]), ".", ctx()).state.overlay).toBeNull();
});

test("prompts collect text, validate required values and chain", () => {
  const second = { type: "prompt" as const, prompt: { title: "Two", label: "Second", submit: (v: string) => ({ type: "action" as const, action: { label: "done", op: "op.done", params: { v } } }) } };
  const ask: Act = { label: "ask", effect: { type: "prompt", prompt: { title: "One", label: "First", required: "Add a note first.", submit: () => second } } };
  const c = ctx({ items: [{ id: "a", primary: ask, actions: [], keys: {} }] });
  let state = reduceKey(initialState(), "enter", c).state;
  state = reduceKey(state, "enter", c).state;
  expect(state.overlay).toMatchObject({ kind: "prompt", error: "Add a note first." });
  state = press(state, ["h", "i", "x", "backspace"], c);
  expect(state.overlay).toMatchObject({ kind: "prompt", value: "hi" });
  state = reduceKey(state, "enter", c).state;
  expect(state.overlay).toMatchObject({ kind: "prompt", spec: { title: "Two" } });
  state = press(state, ["o", "k"], c);
  const result = reduceKey(state, "enter", c);
  expect(result.effect).toEqual({ type: "action", action: { label: "done", op: "op.done", params: { v: "ok" } } });
  expect(reduceKey(reduceKey(initialState(), "enter", c).state, "escape", c).state.overlay).toBeNull();
});

test("q quits, ? toggles help, R refreshes and f cycles the repo scope", () => {
  expect(reduceKey(initialState(), "q", ctx()).quit).toBe(true);
  expect(reduceKey(initialState(), "interrupt", ctx()).quit).toBe(true);
  const help = reduceKey(initialState(), "?", ctx()).state;
  expect(help.overlay).toEqual({ kind: "help" });
  expect(reduceKey(help, "q", ctx()).quit).toBeUndefined();
  expect(reduceKey(help, "?", ctx()).state.overlay).toBeNull();
  expect(reduceKey(initialState(), "R", ctx()).refresh).toBe(true);
  expect(press(initialState(), ["f"]).scope).toBe("r1");
  expect(press(initialState(), ["f", "f", "f"]).scope).toBeNull();
});

test("settings: sections first, then rows; row keys win for left and right", () => {
  const adjust = act("adjust");
  const c = ctx({ sections: ["planner", "accounts"], items: [{ id: "row", actions: [], keys: { left: adjust, right: adjust } }] });
  let state = press(initialState("settings"), ["j"], c);
  expect(state.section).toBe("accounts");
  state = reduceKey(state, "enter", c).state;
  expect(state.focus).toBe("detail");
  expect(reduceKey(state, "right", c).effect).toEqual(adjust.effect);
  state = reduceKey(state, "escape", c).state;
  expect(state.focus).toBe("list");
  expect(reduceKey(state, "escape", c).state.screen).toBe("home");
});

test("narrow detail screens drill in and scroll; Escape returns", () => {
  const c = ctx({ wide: false, hasDetail: true, items: [{ id: "a", actions: [], keys: {} }] });
  let state = reduceKey(initialState("review"), "enter", c).state;
  expect(state.focus).toBe("detail");
  state = press(state, ["j", "j"], c);
  expect(state.scroll).toBe(2);
  expect(reduceKey(state, "escape", c).state).toMatchObject({ focus: "list", scroll: 0 });
});

test("terminal keys support split sequences, navigation keys, paste and control-C", () => {
  const keys = new Keys();
  expect(keys.feed("\x1b[")).toEqual([]);
  expect(keys.feed("Ajk\r\x7f\x03")).toEqual(["up", "j", "k", "enter", "backspace", "interrupt"]);
  expect(keys.feed("\t\x1b[Z\x1b[5~\x1b[6~\x1b[H\x1b[F")).toEqual(["tab", "backtab", "pageup", "pagedown", "home", "end"]);
  expect(keys.feed("\x1b")).toEqual([]);
  expect(keys.flush()).toEqual(["escape"]);
  expect(keys.feed("goal text")).toEqual(Array.from("goal text"));
  expect(keys.feed("\x1b[D\x1b[C")).toEqual(["left", "right"]);
});
