import { useState } from "preact/hooks";
import type { Command } from "../keys/commands";

/** Panel open state that survives reloads; per-window choices use session storage. Storage may be missing or refuse access, so the default always wins then. */
export function usePanelState(id: string, defaultOpen: boolean, perWindow = false): [boolean, (open: boolean) => void] {
  const key = `pacer.panel.${id}`;
  const read = () => {
    try { const saved = (perWindow ? sessionStorage : localStorage).getItem(key); return saved === null ? defaultOpen : saved === "1"; }
    catch { return defaultOpen; }
  };
  const [saved, setSaved] = useState<Record<string, boolean>>(() => ({ [key]: read() }));
  const open = saved[key] ?? read();
  return [open, next => {
    setSaved(previous => ({ ...previous, [key]: next }));
    try { (perWindow ? sessionStorage : localStorage).setItem(key, next ? "1" : "0"); } catch { /* keep the in-memory state */ }
  }];
}

/**
 * Frame commands. Ctrl-` is allowed while the docked shell has control, so the dock can always be closed from inside it.
 * Ctrl-Shift-B (the key reads "B") toggles the right panel, so it stays clear of a shell's Ctrl-b prefix.
 */
export function panelCommands(toggleLeft?: () => void, toggleDock?: () => void, toggleRight?: () => void): Command[] {
  return [
    ...(toggleLeft ? [{ id: "view.panel.left", title: "Toggle left panel", shortcutLabel: "Side panel", group: "View", icon: "panel-left" as const, keywords: "sidebar left", keys: "Mod-b", run: toggleLeft }] : []),
    ...(toggleRight ? [{ id: "view.panel.right", title: "Toggle details panel", shortcutLabel: "Details panel", group: "View", icon: "panel-right" as const, keywords: "session details changes", keys: "Ctrl-B", run: toggleRight }] : []),
    ...(toggleDock ? [{ id: "view.panel.terminal", title: "Toggle terminal panel", shortcutLabel: "Terminal panel", group: "View", icon: "command-terminal" as const, keywords: "dock shell", keys: "Ctrl-`", allowInControl: true, run: toggleDock }] : []),
  ];
}
