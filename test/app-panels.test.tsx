import { afterEach, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { SidePanel } from "../app/src/ds/SidePanel";
import { createCommandRegistry } from "../app/src/keys/commands";
import { panelCommands, usePanelState } from "../app/src/shell/panels";
/** The same registration path the shell uses: commands register their shortcut on the key registry. */
const register = (registry: ReturnType<typeof createKeyRegistry>, commands: ReturnType<typeof panelCommands>) => { const all = createCommandRegistry(registry); for (const command of commands) all.register(command); };
import { createKeyRegistry, type KeyInput } from "../app/src/keys/registry";
import { sessionControlActive } from "../app/src/keys/instance";
import { CommandHelp } from "../app/src/shell/CommandHelp";

const previous = (globalThis as any).localStorage;
afterEach(() => { (globalThis as any).localStorage = previous; });
function memoryStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return { store, getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
}
/** Runs the hook once outside a component tree: renderToString gives it a real hook context. */
function readPanel(id: string, defaultOpen: boolean, perWindow = false) {
  let result!: ReturnType<typeof usePanelState>;
  function Probe() { result = usePanelState(id, defaultOpen, perWindow); return null; }
  renderToString(<Probe />);
  return result;
}
const press = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key, ctrlKey: true, metaKey: false, altKey: false, target: null, preventDefault() {}, ...extra });

test("panel_toggle_has_aria_expanded_and_controls", () => {
  const changes: boolean[] = [];
  // SidePanel uses hooks, so capture its tree from inside a rendering component.
  let open!: ReturnType<typeof SidePanel>;
  function Probe() { open = SidePanel({ side: "left", label: "Settings", open: true, onToggle: next => changes.push(next), children: "links" }); return open; }
  const html = renderToString(<Probe />);
  expect(html).toContain('<aside aria-label="Settings" class="pc-side-panel pc-side-panel--left">');
  expect(html).toMatch(/aria-label="Hide Settings"[^>]*aria-expanded="true"[^>]*aria-controls="pc-side-panel-left"/);
  expect(html).toContain('id="pc-side-panel-left" class="pc-side-panel__content">links</div>');
  const closed = renderToString(<SidePanel side="right" label="Details" open={false} onToggle={next => changes.push(next)}>panel body</SidePanel>);
  expect(closed).not.toContain("<aside");
  expect(closed).not.toContain("panel body");
  expect(closed).toContain("pc-side-panel--closed");
  expect(closed).toMatch(/aria-label="Show Details"[^>]*aria-expanded="false"/);
  expect(closed).not.toContain("aria-controls");
  // The toggle reports the next state.
  const button = (open!.props.children as any[]).find(child => child?.props?.className === "pc-side-panel__bar").props.children;
  button.props.onClick();
  expect(changes).toEqual([false]);
});

test("panel_state_persists", () => {
  const storage = memoryStorage();
  (globalThis as any).localStorage = storage;
  const [open, setOpen] = readPanel("settings", true);
  expect(open).toBe(true);
  setOpen(false);
  expect(storage.store.get("pacer.panel.settings")).toBe("0");
  expect(readPanel("settings", true)[0]).toBe(false);
  readPanel("dock", false)[1](true);
  expect(storage.store.get("pacer.panel.dock")).toBe("1");
  expect(readPanel("dock", false)[0]).toBe(true);
});

test("panel_state_survives_storage_errors", () => {
  (globalThis as any).localStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } };
  const [open, setOpen] = readPanel("settings", true);
  expect(open).toBe(true);
  expect(() => setOpen(false)).not.toThrow();
  expect(readPanel("dock", false)[0]).toBe(false);
  (globalThis as any).localStorage = undefined;
  expect(readPanel("settings", true)[0]).toBe(true);
  expect(() => readPanel("settings", true)[1](false)).not.toThrow();
});

test("ctrl_backtick_toggles_dock", () => {
  let control = false, docks = 0;
  const registry = createKeyRegistry({ controlActive: () => control });
  register(registry, panelCommands(undefined, () => docks++));
  let prevented = false;
  expect(registry.handle(press("`", { preventDefault: () => { prevented = true; } }))).toBe(true);
  expect(prevented).toBe(true);
  expect(docks).toBe(1);
  // A terminal with control still lets the dock close; meta and alt combinations are ignored.
  control = true;
  expect(registry.handle(press("`"))).toBe(true);
  expect(docks).toBe(2);
  expect(registry.handle(press("`", { metaKey: true }))).toBe(false);
  expect(registry.handle(press("`", { ctrlKey: false }))).toBe(false);
  expect(docks).toBe(2);
});

test("ctrl_b_toggles_left_panel", () => {
  let control = false, lefts = 0;
  const registry = createKeyRegistry({ controlActive: () => control, mac: false });
  register(registry, panelCommands(() => lefts++));
  // Ctrl combinations work in text fields.
  expect(registry.handle(press("b", { target: { tagName: "INPUT", type: "text" } }))).toBe(true);
  expect(lefts).toBe(1);
  // A terminal with control keeps Ctrl-b for the shell.
  control = true;
  expect(registry.handle(press("b"))).toBe(false);
  expect(lefts).toBe(1);
  expect(panelCommands()).toEqual([]);
});

test("cmd_b_toggles_left_panel_on_macos_and_leaves_ctrl_b_to_the_shell", () => {
  let control = false, lefts = 0;
  const registry = createKeyRegistry({ controlActive: () => control, mac: true });
  register(registry, panelCommands(() => lefts++));
  expect(registry.handle(press("b", { metaKey: true, ctrlKey: false }))).toBe(true);
  expect(registry.handle(press("b", { metaKey: true, ctrlKey: false, target: { tagName: "INPUT", type: "text" } }))).toBe(true);
  expect(lefts).toBe(2);
  // Ctrl-b is not bound on macOS, with or without a shell in control, so the shell gets it.
  expect(registry.handle(press("b"))).toBe(false);
  control = true;
  expect(registry.handle(press("b"))).toBe(false);
  expect(registry.handle(press("b", { metaKey: true, ctrlKey: false }))).toBe(false);
  expect(lefts).toBe(2);
  // Elsewhere Cmd-b is not a binding.
  const other = createKeyRegistry({ controlActive: () => false, mac: false });
  register(other, panelCommands(() => lefts++));
  expect(other.handle(press("b", { metaKey: true, ctrlKey: false }))).toBe(false);
  expect(lefts).toBe(2);
});

test("shortcuts_listed_in_command_help", () => {
  const registry = createKeyRegistry({ controlActive: () => false });
  register(registry, panelCommands(() => {}, () => {}));
  const words = renderToString(<CommandHelp registry={registry} close={() => {}} mac={false} />);
  expect(words).toMatch(/<kbd[^>]*>Ctrl `<\/kbd><\/dt><dd>Terminal panel<\/dd>/);
  expect(words).toMatch(/<kbd[^>]*>Ctrl B<\/kbd><\/dt><dd>Side panel<\/dd>/);
  const symbols = renderToString(<CommandHelp registry={registry} close={() => {}} mac />);
  expect(symbols).toMatch(/<kbd[^>]*>⌃ `<\/kbd><\/dt><dd>Terminal panel<\/dd>/);
  expect(symbols).toMatch(/<kbd[^>]*>⌘ B<\/kbd><\/dt><dd>Side panel<\/dd>/);
  expect(registry.list().find(shortcut => shortcut.keys === "Ctrl-`")?.allowInControl).toBe(true);
  expect(registry.list().find(shortcut => shortcut.keys === "Mod-b")?.allowInControl).toBeUndefined();
});

test("a docked terminal holds keyboard control only while focus is inside the dock", () => {
  const doc = (closest: unknown) => ({ querySelector: (s: string) => s === '[data-session-control="true"]' ? { closest: () => closest } : null });
  expect(sessionControlActive(doc(null))).toBe(true);
  expect(sessionControlActive(doc({}))).toBe(false);
});

test("Dispatch panel choices belong to a window and ignore legacy global choices", () => {
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const windowStorage = memoryStorage();
  (globalThis as any).localStorage = memoryStorage({ "pacer.panel.dispatch.scope": "1" });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: windowStorage });
  try {
    expect(readPanel("dispatch.scope", false, true)[0]).toBe(false);
    readPanel("dispatch.scope", false, true)[1](true);
    expect(readPanel("dispatch.scope", false, true)[0]).toBe(true);
    expect(readPanel("dispatch.inspector", false, true)[0]).toBe(false);
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
    expect(readPanel("dispatch.scope", false, true)[0]).toBe(false);
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw Error("denied"); } });
    expect(readPanel("dispatch.scope", false, true)[0]).toBe(false);
    expect(() => readPanel("dispatch.scope", false, true)[1](true)).not.toThrow();
  } finally {
    if (previousSession) Object.defineProperty(globalThis, "sessionStorage", previousSession);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
