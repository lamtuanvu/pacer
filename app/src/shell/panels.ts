import { useState } from "preact/hooks";
import type { Shortcut } from "../keys/registry";

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

/**
 * Frame shortcuts. Ctrl-` is allowed while the docked shell has control, so the dock can always be closed from inside it.
 * Ctrl-Shift-B (the key reads "B") toggles the right panel.
 */
export function panelShortcuts(toggleLeft?: () => void, toggleDock?: () => void, toggleRight?: () => void): Shortcut[] {
  return [
    ...(toggleLeft ? [{ keys: "Ctrl-b", label: "Side panel", scope: "global", run: toggleLeft }] : []),
    ...(toggleRight ? [{ keys: "Ctrl-B", label: "Details panel", scope: "global", run: toggleRight }] : []),
    ...(toggleDock ? [{ keys: "Ctrl-`", label: "Terminal panel", scope: "global", run: toggleDock, allowInControl: true }] : []),
  ];
}
