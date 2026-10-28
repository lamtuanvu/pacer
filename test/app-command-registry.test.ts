import { expect, test } from "bun:test";
import { createCommandRegistry, keyCaps } from "../app/src/keys/commands";
import { createKeyRegistry } from "../app/src/keys/registry";

const press = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}, target: object = { tagName: "BODY" }) => {
  const event = { key, ctrlKey: false, metaKey: false, altKey: false, ...mods, target, prevented: false, preventDefault() { event.prevented = true; } };
  return event;
};
function setup(control = false) {
  const state = { control }, ran: string[] = [];
  const keys = createKeyRegistry({ controlActive: () => state.control });
  return { keys, commands: createCommandRegistry(keys), ran, state };
}

test("a command with keys is also the shortcut, and unregistering removes both", () => {
  const { keys, commands, ran } = setup();
  const off = commands.register({ id: "go.tasks", title: "Go to Tasks", shortcutLabel: "Tasks", group: "Go to", keys: "g t", run: () => ran.push("tasks") });
  commands.register({ id: "x", title: "No keys", group: "Go to", run: () => {} });
  expect(commands.list().map(command => command.id)).toEqual(["go.tasks", "x"]);
  expect(keys.list().map(shortcut => [shortcut.keys, shortcut.label, shortcut.scope])).toEqual([["g t", "Tasks", "global"]]);
  keys.handle(press("g")); keys.handle(press("t"));
  expect(ran).toEqual(["tasks"]);
  off();
  expect(commands.list().map(command => command.id)).toEqual(["x"]);
  expect(keys.list()).toEqual([]);
});

test("allowInControl and scope carry over to the shortcut", () => {
  const { keys, commands, ran, state } = setup(true);
  commands.register({ id: "a", title: "A", group: "View", keys: "Ctrl-`", allowInControl: true, run: () => ran.push("a") });
  commands.register({ id: "b", title: "B", group: "View", keys: "Ctrl-b", run: () => ran.push("b") });
  commands.register({ id: "c", title: "C", group: "View", keys: "x", scope: "review", run: () => ran.push("c") });
  expect(keys.handle(press("`", { ctrlKey: true }))).toBe(true);
  expect(keys.handle(press("b", { ctrlKey: true }))).toBe(false);
  state.control = false;
  expect(keys.handle(press("x"))).toBe(false);
  keys.setScope("review");
  expect(keys.handle(press("x"))).toBe(true);
  expect(ran).toEqual(["a", "c"]);
});

test("subscribers hear about registration changes", () => {
  const { commands } = setup();
  let calls = 0;
  const stop = commands.subscribe(() => calls++);
  const off = commands.register({ id: "a", title: "A", group: "G", run: () => {} });
  off(); off();
  stop();
  commands.register({ id: "b", title: "B", group: "G", run: () => {} });
  expect(calls).toBe(2);
});

test("Mod-k answers to Cmd-K and Ctrl-K, also from a text field, but not to Cmd with other keys", () => {
  const { keys, commands, ran, state } = setup();
  commands.register({ id: "search.open", title: "Search", group: "Go to", keys: "Mod-k", hidden: true, run: () => ran.push("open") });
  const e1 = press("k", { metaKey: true });
  expect(keys.handle(e1)).toBe(true);
  expect(e1.prevented).toBe(true);
  expect(keys.handle(press("k", { ctrlKey: true }, { tagName: "INPUT", type: "text" }))).toBe(true);
  expect(keys.handle(press("K", { metaKey: true }, { tagName: "TEXTAREA" }))).toBe(true);
  expect(keys.handle({ ...press("K", { ctrlKey: true }), shiftKey: true })).toBe(false);
  expect(keys.handle(press("k"))).toBe(false);
  expect(keys.handle(press("j", { metaKey: true }))).toBe(false);
  expect(keys.handle(press("k", { metaKey: true, altKey: true }))).toBe(false);
  // A terminal with control keeps Ctrl-K for the shell.
  state.control = true;
  expect(keys.handle(press("k", { ctrlKey: true }))).toBe(false);
  expect(ran).toEqual(["open", "open", "open"]);
});

test("key caps split modifiers and sequences", () => {
  expect(keyCaps("Ctrl-b", false)).toEqual(["Ctrl", "B"]);
  expect(keyCaps("Ctrl-`", false)).toEqual(["Ctrl", "`"]);
  expect(keyCaps("g o", false)).toEqual(["G", "O"]);
  expect(keyCaps(",", false)).toEqual([","]);
  expect(keyCaps("Mod-k", true)).toEqual(["⌘", "K"]);
  expect(keyCaps("Mod-k", false)).toEqual(["Ctrl", "K"]);
  expect(keyCaps("Escape", false)).toEqual(["Escape"]);
  expect(keyCaps("Mod-Enter", true)).toEqual(["⌘", "↵"]);
  // macOS draws modifiers as symbols.
  expect(keyCaps("Ctrl-b", true)).toEqual(["⌃", "B"]);
  expect(keyCaps("Ctrl-`", true)).toEqual(["⌃", "`"]);
});
