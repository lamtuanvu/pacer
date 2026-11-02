import { useWorkspaceKey, useWorkspaceState } from "../workspace/state";
import type { Command } from "../keys/commands";

/** Panel preferences keep their existing storage outside workspace drafts. */
export function usePanelState(id: string, defaultOpen: boolean, perWindow = false): [boolean, (open: boolean) => void] {
 const key = useWorkspaceKey(undefined, "shell-panels");
 const storageKey = `pacer.panel.${id}`;
 let initial = defaultOpen;
 try { const saved = (perWindow ? sessionStorage : localStorage).getItem(storageKey); if (saved !== null) initial = saved === '1'; } catch {}
 const [open, setOpen] = useWorkspaceState(key, `panel:${id}`, initial);
 return [open, next => { setOpen(next); try { (perWindow ? sessionStorage : localStorage).setItem(storageKey, next ? '1' : '0'); } catch {} }];
}

/**
 * Frame commands. Ctrl-` is allowed while the docked shell has control, so the dock can always be closed from inside it.
 * Alt-Mod-b toggles the right panel, so it stays clear of a shell's Ctrl-b prefix.
 */
export function panelCommands(toggleLeft?: () => void, toggleDock?: () => void, toggleRight?: () => void): Command[] {
  return [
    ...(toggleLeft ? [{ id: "view.panel.left", title: "Toggle left panel", shortcutLabel: "Side panel", group: "View", icon: "panel-left" as const, keywords: "sidebar left", keys: "Mod-b", run: toggleLeft }] : []),
    ...(toggleDock ? [{ id: "view.panel.terminal", title: "Toggle terminal panel", shortcutLabel: "Terminal panel", group: "View", icon: "command-terminal" as const, keywords: "dock shell", keys: "Ctrl-`", allowInControl: true, run: toggleDock }] : []),
    ...(toggleRight ? [{ id: "view.panel.right", title: "Toggle right panel", shortcutLabel: "Right panel", group: "View", icon: "panel-right" as const, keywords: "session details changes", keys: "Alt-Mod-b", run: toggleRight }] : []),
  ];
}
