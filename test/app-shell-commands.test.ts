import { expect, test } from "bun:test";
import { createKeyRegistry } from "../app/src/keys/registry";
import { createCommandRegistry } from "../app/src/keys/commands";
import { registerShellCommands } from "../app/src/shell/shell-commands";

function press(key: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}, target: object = { tagName: "BODY" }) {
  const event = { key, ctrlKey: false, metaKey: false, altKey: false, ...mods, target, prevented: false, preventDefault() { (event as { prevented: boolean }).prevented = true; } };
  return event;
}
function setup({ apple = true, desktop = true }: { apple?: boolean; desktop?: boolean } = {}) {
  const keys = createKeyRegistry({ controlActive: () => false, mac: apple });
  const commands = createCommandRegistry(keys);
  const calls: string[] = [];
  const off = registerShellCommands(commands, keys, {
    go: hash => calls.push(`go:${hash}`),
    back: () => calls.push("back"),
    forward: () => calls.push("forward"),
    openNewTask: () => calls.push("new"),
    showHelp: () => calls.push("help"),
    apple,
    desktop,
  });
  return { keys, commands, calls, off };
}

test("settings is Meta-, and no command or shortcut keeps the bare , or Mod-n", () => {
  const { keys, commands } = setup({ apple: true });
  expect(commands.list().find(c => c.id === "go.settings")?.keys).toBe("Meta-,");
  for (const c of commands.list()) {
    expect(c.keys).not.toBe(",");
    expect(c.keys).not.toBe("Mod-n");
  }
  for (const s of keys.list()) {
    expect(s.keys).not.toBe(",");
    expect(s.keys).not.toBe("Mod-n");
  }
});

test("Meta-n opens the new-task composer exactly once", () => {
  const { keys, calls } = setup({ apple: true });
  expect(keys.handle(press("n", { metaKey: true }))).toBe(true);
  expect(calls).toEqual(["new"]);
});

test("Meta-[ goes back, Meta-] goes forward, Meta-3 opens Tasks", () => {
  const { keys, calls } = setup({ apple: true, desktop: true });
  expect(keys.handle(press("[", { metaKey: true }))).toBe(true);
  expect(keys.handle(press("]", { metaKey: true }))).toBe(true);
  expect(keys.handle(press("3", { metaKey: true }))).toBe(true);
  expect(calls).toEqual(["back", "forward", "go:#/tasks"]);
});

test("non-Apple: Ctrl-, opens settings and go.back is not allowed in control", () => {
  const { keys, commands, calls } = setup({ apple: false });
  const back = commands.list().find(c => c.id === "go.back")!;
  expect(back.allowInControl).toBe(false);
  expect(keys.handle(press(",", { ctrlKey: true }))).toBe(true);
  expect(calls).toEqual(["go:#/settings"]);
});

test("Meta-f with no listener returns true and does not throw", () => {
  const { keys } = setup({ apple: true, desktop: true });
  expect(() => keys.handle(press("f", { metaKey: true }))).not.toThrow();
  expect(keys.handle(press("f", { metaKey: true }))).toBe(true);
});

test("in a browser the section digits and find stay unregistered, but the rest still work", () => {
  const { keys, commands, calls } = setup({ apple: true, desktop: false });
  expect(commands.list().find(c => c.id === "view.find")).toBeUndefined();
  for (const k of ["1", "f"]) {
    const event = press(k, { metaKey: true });
    expect(keys.handle(event)).toBe(false);
    expect(event.prevented).toBe(false);
  }
  for (const key of ["n", "[", "]", ","]) expect(keys.handle(press(key, { metaKey: true }))).toBe(true);
  expect(calls).toEqual(["new", "back", "forward", "go:#/settings"]);
});

test("the returned disposer removes every command and shortcut", () => {
  const { keys, commands, off } = setup({ apple: true });
  expect(commands.list().length).toBeGreaterThan(0);
  expect(keys.list().length).toBeGreaterThan(0);
  off();
  expect(commands.list().length).toBe(0);
  expect(keys.list().length).toBe(0);
});
