import type { IconName } from "../ds/icons";
import type { KeyRegistry } from "./registry";

/** One thing the user can do. Menus list it; when it has `keys`, the same entry is also the keyboard shortcut. */
export interface Command {
  id: string; title: string;
  /** Group heading in the command menu, such as "Go to" or "View". */
  group: string;
  sub?: string; icon?: IconName;
  /** Extra search words that are not in the title. */
  keywords?: string;
  /** Registered as a shortcut but left out of the command menu, such as the shortcut that opens the menu itself. */
  hidden?: boolean;
  /** Opens a dialog of its own. The command menu closes first, since a modal menu would leave that dialog inert. */
  opensDialog?: boolean;
  keys?: string; scope?: "global" | string; allowInControl?: boolean;
  /** Label in the shortcuts overlay and status bar when it differs from the title. */
  shortcutLabel?: string;
  run: () => void;
}

/** The one command registry. Shortcuts are registered on the key registry, never on a parallel system. */
export function createCommandRegistry(keyRegistry: KeyRegistry) {
  const commands: Command[] = [];
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    register(command: Command): () => void {
      const offKey = command.keys
        ? keyRegistry.register({ keys: command.keys, label: command.shortcutLabel ?? command.title, scope: command.scope ?? "global", run: command.run, allowInControl: command.allowInControl })
        : undefined;
      commands.push(command);
      notify();
      return () => { const at = commands.indexOf(command); if (at >= 0) { commands.splice(at, 1); notify(); } offKey?.(); };
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    list: (): Command[] => [...commands],
  };
}
export type CommandRegistry = ReturnType<typeof createCommandRegistry>;

export const isMacPlatform = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MAC_MODS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
/** Registry keys as separate key caps: "Ctrl-b" → ⌃ B on macOS and Ctrl B elsewhere, "g o" → G O, "Mod-k" → ⌘ K (Ctrl K elsewhere). */
export function keyCaps(keys: string, mac = isMacPlatform()): string[] {
  return keys.split(" ").flatMap(step => {
    const at = step.length > 1 && !step.endsWith("-") ? step.indexOf("-") : -1;
    const [mod, key] = at > 0 ? [step.slice(0, at), step.slice(at + 1)] : [null, step];
    const cap = key === "Enter" ? "↵" : key.length === 1 ? key.toUpperCase() : key;
    if (mod === null) return [cap];
    return [mac ? MAC_MODS[mod] ?? mod : mod === "Mod" ? "Ctrl" : mod, cap];
  });
}
