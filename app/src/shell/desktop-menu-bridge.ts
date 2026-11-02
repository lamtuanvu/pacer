import type { CommandRegistry } from "../keys/commands";
import { menuChannel, type MenuHost } from "../platform/menu";
export type { MenuHost } from "../platform/menu";

export const MENU_COMMANDS = ["go.dispatch", "go.needs-you", "go.tasks", "go.terminal", "go.settings", "go.back", "go.forward", "task.new", "view.close", "view.find", "help.shortcuts", "view.panel.left", "view.panel.terminal", "view.panel.right"] as const;
/** Native events dispatch the same current registry entries as the palette. No browser IPC. */
export function attachDesktopMenuBridge(commands: CommandRegistry, route: (hash: string) => void, host: MenuHost = globalThis as MenuHost): () => void {
  const { listen, invoke } = menuChannel(host);
  if (!listen || !invoke) return () => {};
  let stopped = false, revision = 0, sent = 0;
  const offs: (() => void)[] = [];
  // Serialize reports: a slow old invoke must never overwrite a newer availability snapshot.
  const report = async () => {
    revision++;
    if (sent) return;
    sent = 1;
    try {
      let current: number;
      do {
        current = revision;
        const ids = new Set(commands.list().map(command => command.id));
        const pending = await invoke("menu_set_enabled", { items: MENU_COMMANDS.map(id => ({ id, enabled: ids.has(id) })) });
        if (!stopped) receiveRoute(pending);
        if (stopped) break;
      } while (current !== revision);
    } catch { /* Older shells may not expose the menu command. */ }
    finally { sent = 0; }
  };
  const receiveRoute = (payload: unknown) => { if (payload && typeof payload === "object" && "hash" in payload && typeof payload.hash === "string" && payload.hash.startsWith("#/")) route(payload.hash); };
  const subscribe = async (name: string, callback: (payload: Record<string, unknown>) => void) => {
    const off = await listen(name, event => {
      if (!stopped && event.payload && typeof event.payload === "object") callback(event.payload as Record<string, unknown>);
    });
    if (stopped) off(); else offs.push(off);
  };
  void Promise.all([
    subscribe("pacer://command", payload => { if (!MENU_COMMANDS.some(id => id === payload.id)) return; const command = commands.list().find(item => item.id === payload.id); if (command) command.run(); }),
    subscribe("pacer://route", receiveRoute),
  ]).then(() => { if (!stopped) { offs.push(commands.subscribe(() => { void report(); })); void report(); } }).catch(() => { offs.splice(0).forEach(off => off()); });
  return () => { stopped = true; offs.splice(0).forEach(off => off()); };
}
