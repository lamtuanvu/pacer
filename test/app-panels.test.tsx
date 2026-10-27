import { afterEach, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { SidePanel } from "../app/src/ds/SidePanel";
import { panelShortcuts, usePanelState } from "../app/src/shell/panels";
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
function readPanel(id: string, defaultOpen: boolean) {
  let result!: ReturnType<typeof usePanelState>;
  function Probe() { result = usePanelState(id, defaultOpen); return null; }
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
  const button = (open!.props.children as any[])[0].props.children;
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
  for (const shortcut of panelShortcuts(undefined, () => docks++)) registry.register(shortcut);
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
  const registry = createKeyRegistry({ controlActive: () => control });
  for (const shortcut of panelShortcuts(() => lefts++)) registry.register(shortcut);
  // Ctrl combinations work in text fields.
  expect(registry.handle(press("b", { target: { tagName: "INPUT", type: "text" } }))).toBe(true);
  expect(lefts).toBe(1);
  // A terminal with control keeps Ctrl-b for the shell.
  control = true;
  expect(registry.handle(press("b"))).toBe(false);
  expect(lefts).toBe(1);
  expect(panelShortcuts()).toEqual([]);
});

test("shortcuts_listed_in_command_help", () => {
  const registry = createKeyRegistry({ controlActive: () => false });
  for (const shortcut of panelShortcuts(() => {}, () => {})) registry.register(shortcut);
  const html = renderToString(<CommandHelp registry={registry} close={() => {}} />);
  expect(html).toMatch(/<kbd[^>]*>Ctrl-`<\/kbd><\/dt><dd>Terminal panel<\/dd>/);
  expect(html).toMatch(/<kbd[^>]*>Ctrl-b<\/kbd><\/dt><dd>Side panel<\/dd>/);
  expect(registry.list().find(shortcut => shortcut.keys === "Ctrl-`")?.allowInControl).toBe(true);
  expect(registry.list().find(shortcut => shortcut.keys === "Ctrl-b")?.allowInControl).toBeUndefined();
});

test("a docked terminal holds keyboard control only while focus is inside the dock", () => {
  const doc = (closest: unknown) => ({ querySelector: (s: string) => s === '[data-session-control="true"]' ? { closest: () => closest } : null });
  expect(sessionControlActive(doc(null))).toBe(true);
  expect(sessionControlActive(doc({}))).toBe(false);
});
