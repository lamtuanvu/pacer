import { useState } from "preact/hooks";
import type { Command } from "../keys/commands";

/** Panel open state that survives reloads. Storage may be missing or refuse access, so the default always wins then. */
export function usePanelState(id: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const key = `pacer.panel.${id}`;
  const [open, setOpen] = useState(() => {
    try { const saved = localStorage.getItem(key); return saved === null ? defaultOpen : saved === "1"; }
    catch { return defaultOpen; }
  });
  return [open, next => {
    setOpen(next);
    try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* keep the in-memory state */ }
  }];
}

/** Frame commands. Ctrl-` is allowed while the docked shell has control, so the dock can always be closed from inside it. */
export function panelCommands(toggleLeft?: () => void, toggleDock?: () => void): Command[] {
  return [
    ...(toggleLeft ? [{ id: "view.panel.left", title: "Toggle left panel", shortcutLabel: "Side panel", group: "View", icon: "panel-left" as const, keywords: "sidebar left", keys: "Mod-b", run: toggleLeft }] : []),
    ...(toggleDock ? [{ id: "view.panel.terminal", title: "Toggle terminal panel", shortcutLabel: "Terminal panel", group: "View", icon: "terminal" as const, keywords: "dock shell", keys: "Ctrl-`", allowInControl: true, run: toggleDock }] : []),
  ];
}
