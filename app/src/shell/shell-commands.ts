import type { Command, CommandRegistry } from "../keys/commands";
import type { KeyRegistry } from "../keys/registry";
import { modShortcut } from "../keys/registry";
/** Fired when ⌘F runs, so the current view can open its own find. */
export const FIND_EVENT = "pacer:find";
export interface ShellCommandDeps {
  go: (hash: string) => void; back: () => void; forward: () => void;
  openNewTask: () => void; showHelp: () => void; apple: boolean; desktop: boolean;
}
/** The shell's shared commands and shortcuts: ⌘ on Apple, Ctrl elsewhere. One binding for task.new; the settings `,` is now ⌘,. */
export function registerShellCommands(commands: CommandRegistry, keys: KeyRegistry, deps: ShellCommandDeps): () => void {
  const mod = (key: string) => modShortcut(key, deps.apple);
  const find = () => { globalThis.dispatchEvent?.(new Event(FIND_EVENT)); };
  // ⌘1-4 / Ctrl-1-4 and ⌘F / Ctrl-F steal tab-switching and the browser's own find, so they only apply on desktop.
  const section = (run: () => void, command: Omit<Command, "run">, shortcut: string): (() => void)[] => [
    commands.register({ ...command, run }),
    ...(deps.desktop ? [keys.register({ keys: shortcut, label: command.title, scope: "global", allowInControl: deps.apple, run })] : []),
  ];
  const offs = [
    ...section(() => deps.go("#/"), { id: "go.dispatch", title: "Go to Dispatch", group: "Go to", icon: "command-nav", keys: "g o" }, mod("1")),
    ...section(() => deps.go("#/needs-you"), { id: "go.needs-you", title: "Go to Needs you", group: "Go to", icon: "command-nav", keys: "g r" }, mod("2")),
    ...section(() => deps.go("#/tasks"), { id: "go.tasks", title: "Go to Tasks", group: "Go to", icon: "command-nav", keys: "g t" }, mod("3")),
    ...section(() => deps.go("#/workspace"), { id: "go.terminal", title: "Go to Workspace", group: "Go to", icon: "command-terminal", keywords: "terminal sessions", keys: "g e" }, mod("4")),
    commands.register({ id: "go.settings", title: "Open Settings", group: "Go to", icon: "settings", keys: mod(","), allowInControl: deps.apple, run: () => deps.go("#/settings") }),
    commands.register({ id: "go.back", title: "Back", group: "Go to", keys: mod("["), allowInControl: deps.apple, run: () => deps.back() }),
    commands.register({ id: "go.forward", title: "Forward", group: "Go to", keys: mod("]"), allowInControl: deps.apple, run: () => deps.forward() }),
    ...(deps.desktop ? [commands.register({ id: "view.find", title: "Find", group: "View", keys: mod("f"), allowInControl: deps.apple, run: find })] : []),
    commands.register({ id: "help.shortcuts", title: "Show keyboard shortcuts", group: "Help", icon: "notes", opensDialog: true, keys: "?", run: () => deps.showHelp() }),
    commands.register({ id: "task.new", title: "New task", sub: "Describe it and pacer routes it", group: "Suggested", icon: "plus", keywords: "delegate start", opensDialog: true, keys: mod("n"), shortcutLabel: "New task", run: () => deps.openNewTask() }),
  ];
  return () => offs.forEach(off => off());
}
