import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createKeyRegistry } from "../app/src/keys/registry";
import { createCommandRegistry } from "../app/src/keys/commands";
import { attachDesktopMenuBridge, MENU_COMMANDS, type MenuHost } from "../app/src/shell/desktop-menu-bridge";
import { closeLayoutView, closeOpenDialog } from "../app/src/shell/Layout";
import { registerViewClose } from "../app/src/shell/shell-commands";

function setup() {
  const keys = createKeyRegistry({ controlActive: () => false, mac: true }), commands = createCommandRegistry(keys);
  const listeners = new Map<string, (event: { payload: unknown }) => void>(), calls: { command: string; args?: Record<string, unknown> }[] = [];
  const host: MenuHost = { __TAURI__: { core: { invoke: async (command, args) => { calls.push({ command, args }); } }, event: { listen: async (name, callback) => { listeners.set(name, callback); return () => { listeners.delete(name); }; } } } };
  const hashes: string[] = [];
  return { keys, commands, listeners, calls, host, hashes, attach: () => attachDesktopMenuBridge(commands, hash => hashes.push(hash), host) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("native commands run the current registry entry and routes change in place", async () => {
  const s = setup(); let runs = 0;
  const offCommand = s.commands.register({ id: "go.tasks", title: "Tasks", group: "Go", run: () => runs++ });
  const off = s.attach(); await flush();
  s.listeners.get("pacer://command")!({ payload: { id: "go.tasks" } });
  s.listeners.get("pacer://command")!({ payload: { id: "unknown" } });
  s.listeners.get("pacer://route")!({ payload: { hash: "#/tasks" } });
  s.listeners.get("pacer://route")!({ payload: { hash: "https://example.com" } });
  expect(runs).toBe(1); expect(s.hashes).toEqual(["#/tasks"]);
  offCommand(); s.listeners.get("pacer://command")!({ payload: { id: "go.tasks" } }); expect(runs).toBe(1);
  off(); expect(s.listeners.size).toBe(0);
});

test("enabled state follows registration and removal, with all menu ids reported", async () => {
  const s = setup(), off = s.attach(); await flush();
  const states = () => s.calls.filter(c => c.command === "menu_set_enabled").at(-1)!.args!.items as { id: string; enabled: boolean }[];
  expect(states()).toEqual(MENU_COMMANDS.map(id => ({ id, enabled: false })));
  const unregister = s.commands.register({ id: "view.panel.left", title: "Panel", group: "View", run() {} }); await flush();
  expect(states().find(x => x.id === "view.panel.left")?.enabled).toBe(true);
  unregister(); await flush(); expect(states().find(x => x.id === "view.panel.left")?.enabled).toBe(false); off();
});

test("cleanup before asynchronous subscription resolves detaches every listener", async () => {
  const s = setup(), off = s.attach(); off(); await flush(); expect(s.listeners.size).toBe(0);
  expect(s.calls).toHaveLength(0);
});

test("browser bridge does nothing", () => { const s = setup(); attachDesktopMenuBridge(s.commands, () => {}, {})(); expect(s.calls).toHaveLength(0); });

test("Close uses the registered view action and hides only when no panel can close", () => {
  const s = setup(); let panel = true, closed = 0, hidden = 0;
  const off = registerViewClose(s.commands, { apple: true, close: () => { if (!panel) return false; panel = false; closed++; return true; }, hide: () => { hidden++; } });
  s.commands.list().find(c => c.id === "view.close")!.run();
  s.keys.handle({ key: "w", metaKey: true, ctrlKey: false, altKey: false, target: { tagName: "BODY" }, preventDefault() {} });
  expect(closed).toBe(1); expect(hidden).toBe(1); off(); expect(s.commands.list()).toHaveLength(0);
});

test("native channel cannot run registered commands outside the menu allowlist", async () => {
  const s = setup(); let runs = 0;
  s.commands.register({ id: "task.delete", title: "Delete", group: "Task", run: () => runs++ });
  const off = s.attach(); await flush();
  s.listeners.get("pacer://command")!({ payload: { id: "task.delete" } });
  expect(runs).toBe(0); off();
});

test("bridge drains the full pending route only after listeners attach", async () => {
  const s = setup();
  s.host.__TAURI__!.core!.invoke = async (command, args) => {
    s.calls.push({ command, args });
    expect(s.listeners.has("pacer://route")).toBe(true);
    return { hash: "#/needs-you?answer=t-20261102-092025-d545" };
  };
  const off = s.attach(); await flush();
  expect(s.hashes).toEqual(["#/needs-you?answer=t-20261102-092025-d545"]); off();
});


test("Rust menu ids match the page menu allowlist", () => {
  const source = readFileSync("desktop/src-tauri/src/app_menu.rs", "utf8").split("pub fn model()")[1]!.split("pub struct NativeMenu")[0]!;
  const ids = [...source.matchAll(/"((?:go|task|view|help)\.[a-z.-]+)"/g)].map(match => match[1]);
  expect([...new Set(ids)].sort()).toEqual([...MENU_COMMANDS].sort());
});

test("native menus install only on macOS, app-wide, and route commands only to main", () => {
  const source = readFileSync("desktop/src-tauri/src/app_menu.rs", "utf8");
  expect(source).toContain('#[cfg(target_os = "macos")]\npub fn install');
  // WebviewWindow::set_menu is a no-op on macOS; the menu must be set on the app.
  expect(source).toContain("app.set_menu(menu)?;");
  expect(source).not.toMatch(/window\.set_menu\(/);
  expect(source).toContain('tauri::EventTarget::webview_window("main")');
  expect(readFileSync("desktop/src-tauri/src/main.rs", "utf8")).toContain(".enable_macos_default_menu(false)");
  expect(source).toContain('#[cfg(not(target_os = "macos"))]\npub fn install<R: tauri::Runtime>');
  const nonMac = source.split('#[cfg(not(target_os = "macos"))]')[1]!.split('#[cfg(target_os = "macos")]')[0]!;
  expect(nonMac).not.toMatch(/set_menu|\bMenu::|\bSubmenu::|\bMenuItem::/);
});

test("no static or runtime capability grants dialog or filesystem permissions", () => {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
  }
  const sources = files("desktop/src-tauri/src").filter(path => path.endsWith(".rs"));
  const permissions = sources.flatMap(path => [...readFileSync(path, "utf8").matchAll(/\.permissions?\s*\(([\s\S]*?)\)/g)].map(match => match[1]!));
  const capabilities = files("desktop/src-tauri/capabilities").filter(path => /\.(json|toml)$/.test(path));
  const config = JSON.parse(readFileSync("desktop/src-tauri/tauri.conf.json", "utf8"));
  permissions.push(JSON.stringify(config.app.security.capabilities), ...capabilities.map(path => readFileSync(path, "utf8")));
  expect(permissions.filter(value => /["'](?:dialog|fs):/.test(value))).toEqual([]);
});

function layoutCloseState() {
  const closed: string[] = [];
  return { closed, dockAvailable: false, dockOpen: false, workPanels: false, newTaskPanels: false, tasksPanels: false, inspectorOpen: false, taskPanels: false, detailsOpen: false, scopeOpen: false, tasksOpen: false, hasLeft: false, leftOpen: false,
    setDockOpen: () => { closed.push("dock"); }, setInspectorOpen: () => { closed.push("inspector"); }, setDetailsOpen: () => { closed.push("details"); }, setScopeOpen: () => { closed.push("scope"); }, setTasksOpen: () => { closed.push("tasks"); }, setLeftOpen: () => { closed.push("left"); } };
}

test("Layout Close invokes the selected workspace tab's close button before panels", () => {
  const state = { ...layoutCloseState(), dockAvailable: true, dockOpen: true }; let clicked = 0;
  const doc = { querySelector: (selector: string) => {
    expect(selector).toBe('[id^="workspace-panels-"][role="tab"][aria-selected="true"]');
    return { parentElement: { querySelector: (selector: string) => { expect(selector).toBe('button[aria-label^="Close "]'); return { disabled: false, click: () => { clicked++; } }; } } };
  } };
  const s = setup(), off = registerViewClose(s.commands, { apple: true, close: () => closeLayoutView(state, doc), hide: () => { throw new Error("A closable tab must not hide the window"); } });
  s.commands.list().find(c => c.id === "view.close")!.run();
  expect(clicked).toBe(1); expect(state.closed).toEqual([]); off();
});

test("Layout Close skips disabled tab buttons and closes only the first available panel", () => {
  for (const tab of [null, { parentElement: null }, { parentElement: { querySelector: () => null } }, { parentElement: { querySelector: () => ({ disabled: true, click: () => { throw new Error("Disabled tab closed"); } }) } }]) {
    for (const [flags, expected] of [
      [{ dockAvailable: true, dockOpen: true, workPanels: true, inspectorOpen: true, scopeOpen: true }, "dock"],
      [{ workPanels: true, inspectorOpen: true, scopeOpen: true }, "inspector"],
      [{ newTaskPanels: true, inspectorOpen: true }, "inspector"],
      [{ tasksPanels: true, inspectorOpen: true }, "inspector"],
      [{ taskPanels: true, detailsOpen: true, tasksOpen: true }, "details"],
      [{ workPanels: true, scopeOpen: true }, "scope"],
      [{ taskPanels: true, tasksOpen: true }, "tasks"],
      [{ hasLeft: true, leftOpen: true }, "left"],
    ] as const) {
      const state = { ...layoutCloseState(), ...flags };
      expect(closeLayoutView(state, { querySelector: () => tab })).toBe(true);
      expect(state.closed).toEqual([expected]);
    }
  }
});

test("Layout Close reports no closable view for absent, closed or unavailable panels", async () => {
  const s = setup(), bridgeOff = s.attach(); await flush();
  for (const flags of [{}, { dockOpen: true, inspectorOpen: true, detailsOpen: true, scopeOpen: true, tasksOpen: true, leftOpen: true }, { dockAvailable: true, workPanels: true, newTaskPanels: true, tasksPanels: true, taskPanels: true, hasLeft: true }]) {
    const state = { ...layoutCloseState(), ...flags };
    expect(closeLayoutView(state, { querySelector: () => null })).toBe(false); expect(state.closed).toEqual([]);
  }
  // Desktop Close retains the existing window-hide fallback; removing its registration reports disabled.
  let hidden = 0;
  const off = registerViewClose(s.commands, { apple: true, close: () => closeLayoutView(layoutCloseState(), { querySelector: () => null }), hide: () => { hidden++; } });
  await flush(); s.listeners.get("pacer://command")!({ payload: { id: "view.close" } }); expect(hidden).toBe(1);
  off(); await flush();
  const items = s.calls.at(-1)!.args!.items as { id: string; enabled: boolean }[];
  expect(items.find(item => item.id === "view.close")?.enabled).toBe(false); bridgeOff();
});

test("Layout Close cancels the topmost open dialog before panels or hiding", () => {
  const events: string[] = [];
  const dialog = (name: string, tagName = "DIALOG", button = true) => ({ tagName,
    dispatchEvent: (event: Event) => { events.push(`${name}:${event.type}:${event.cancelable}`); return true; },
    querySelector: (selector: string) => { expect(selector).toBe('button[aria-label="Close"]'); return button ? { click: () => { events.push(`${name}:click`); } } : null; } });
  const doc = (...open: ReturnType<typeof dialog>[]) => ({ querySelectorAll: (selector: string) => { expect(selector).toBe('dialog[open], [role="dialog"][aria-modal="true"]'); return open; } });
  expect(closeOpenDialog(doc(dialog("palette"), dialog("help")))).toBe(true);
  expect(events).toEqual(["help:cancel:true"]);
  events.length = 0;
  expect(closeOpenDialog(doc(dialog("help"), dialog("dispatcher", "DIV")))).toBe(true);
  expect(events).toEqual(["dispatcher:click"]);
  events.length = 0;
  expect(closeOpenDialog(doc(dialog("dispatcher", "DIV", false)))).toBe(false);
  expect(closeOpenDialog(doc())).toBe(false);
  expect(events).toEqual([]);
});
