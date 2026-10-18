import { expect, test } from "bun:test";
import { createKeyRegistry } from "../app/src/keys/registry";

type Target = { tagName?: string; isContentEditable?: boolean; type?: string };
let now = 0;
const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}, target: Target = { tagName: "BODY" }) => {
  const event = { key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods, target, prevented: false, preventDefault() { event.prevented = true; } };
  return event;
};
function setup(control = false) {
  const ran: string[] = [];
  let inControl = control;
  const registry = createKeyRegistry({ controlActive: () => inControl, timeoutMs: 1000, now: () => now });
  const add = (keys: string, scope = "global", allowInControl = false) => registry.register({ keys, label: keys, scope, run: () => ran.push(keys), allowInControl });
  return { registry, ran, add, setControl: (v: boolean) => { inControl = v; } };
}

test("g then o runs a sequence shortcut and prevents the default", () => {
  now = 0;
  const { registry, ran, add } = setup();
  add("g o");
  expect(registry.handle(key("g"))).toBe(false);
  const o = key("o");
  expect(registry.handle(o)).toBe(true);
  expect(o.prevented).toBe(true);
  expect(ran).toEqual(["g o"]);
});

test("a pause longer than the timeout drops the sequence", () => {
  now = 0;
  const { registry, ran, add } = setup();
  add("g o");
  registry.handle(key("g"));
  now = 1500;
  registry.handle(key("o"));
  expect(ran).toEqual([]);
});

test("single keys do nothing while focus is in a text field, select or contenteditable", () => {
  const { registry, ran, add } = setup();
  add("a", "global");
  for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
    expect(registry.handle(key("a", {}, target))).toBe(false);
  }
  expect(ran).toEqual([]);
  registry.handle(key("a", {}, { tagName: "BUTTON" }));
  expect(ran).toEqual(["a"]);
});

test("Escape still works from inside an input", () => {
  const { registry, ran, add } = setup();
  add("Escape");
  expect(registry.handle(key("Escape", {}, { tagName: "INPUT" }))).toBe(true);
  expect(ran).toEqual(["Escape"]);
});

test("only Ctrl-] works while a terminal is in control", () => {
  const { registry, ran, add, setControl } = setup(true);
  add("a"); add("Escape"); add("Ctrl-]", "global", true);
  registry.handle(key("a"));
  registry.handle(key("Escape"));
  registry.handle(key("]", { ctrlKey: true }));
  expect(ran).toEqual(["Ctrl-]"]);
  setControl(false);
  registry.handle(key("a"));
  expect(ran).toEqual(["Ctrl-]", "a"]);
});

test("scoped shortcuts run only in their scope", () => {
  const { registry, ran, add } = setup();
  add("a", "review");
  registry.setScope("overview");
  registry.handle(key("a"));
  expect(ran).toEqual([]);
  registry.setScope("review");
  registry.handle(key("a"));
  expect(ran).toEqual(["a"]);
});

test("Cmd and Alt combinations are left to the browser", () => {
  const { registry, ran, add } = setup();
  add("d");
  expect(registry.handle(key("d", { metaKey: true }))).toBe(false);
  expect(registry.handle(key("d", { altKey: true }))).toBe(false);
  expect(registry.handle(key("d", { ctrlKey: true }))).toBe(false);
  expect(ran).toEqual([]);
});

test("question mark and shifted keys match by their character", () => {
  const { registry, ran, add } = setup();
  add("?");
  registry.handle(key("?"));
  expect(ran).toEqual(["?"]);
});

test("unregister removes a shortcut from the list", () => {
  const { registry, add } = setup();
  const off = add("g r");
  add("?");
  expect(registry.list().map(s => s.keys)).toEqual(["g r", "?"]);
  off();
  expect(registry.list().map(s => s.keys)).toEqual(["?"]);
});

test("a key a dialog already handled does not also run a global shortcut", () => {
  const { registry, ran, add } = setup();
  add("Escape");
  const e = { ...key("Escape"), defaultPrevented: true };
  expect(registry.handle(e)).toBe(false);
  expect(ran).toEqual([]);
});

test("while a dialog is open no shortcut runs or swallows the key, so the dialog's own Escape works", () => {
  let dialog = true;
  const ran: string[] = [];
  const registry = createKeyRegistry({ controlActive: () => false, blocked: () => dialog });
  for (const keys of ["a", "Escape", "?"]) registry.register({ keys, label: keys, scope: "global", run: () => ran.push(keys) });
  for (const k of ["a", "Escape", "?"]) { const e = key(k); expect(registry.handle(e)).toBe(false); expect(e.prevented).toBe(false); }
  expect(ran).toEqual([]);
  dialog = false;
  registry.handle(key("a"));
  expect(ran).toEqual(["a"]);
});

test("dialogOpen finds an open modal dialog", async () => {
  const { dialogOpen } = await import("../app/src/keys/instance");
  expect(dialogOpen({ querySelector: (s: string) => (s === "dialog[open]" ? {} : null) })).toBe(true);
  expect(dialogOpen({ querySelector: () => null })).toBe(false);
  expect(dialogOpen(undefined)).toBe(false);
});
