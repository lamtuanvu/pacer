import { isMacPlatform } from "./commands";
/** The app's one shortcut registry. Pure apart from attachKeyRegistry, so tests need no DOM. */
export interface Shortcut { keys: string; label: string; scope: "global" | string; run: () => void; allowInControl?: boolean }
export interface KeyInput {
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean;
  target: unknown; preventDefault(): void; defaultPrevented?: boolean;
}
const NOT_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]);
/** Single keys must not fire while someone is typing. Duck-typed so it works on DOM elements and test doubles alike. */
function isTextTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string };
  const tag = el.tagName?.toUpperCase();
  return el.isContentEditable === true || tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && !NOT_TEXT_INPUTS.has((el.type ?? "text").toLowerCase()));
}

/** controlActive: a terminal has control (only allowInControl keys run). blocked: a modal dialog owns the keyboard (nothing runs). */
export function createKeyRegistry(opts: { controlActive: () => boolean; blocked?: () => boolean; timeoutMs?: number; now?: () => number; mac?: boolean }) {
  const timeout = opts.timeoutMs ?? 1000, now = opts.now ?? (() => Date.now());
  const mac = opts.mac ?? isMacPlatform();
  const shortcuts: Shortcut[] = [];
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  let scope: string | null = null, pending: { keys: string; at: number } | null = null;
  const active = () => shortcuts.filter(s => (s.scope === "global" || s.scope === scope) && (!opts.controlActive() || s.allowInControl));
  return {
    register(shortcut: Shortcut): () => void {
      shortcuts.push(shortcut);
      notify();
      return () => { const at = shortcuts.indexOf(shortcut); if (at >= 0) { shortcuts.splice(at, 1); notify(); } };
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setScope(next: string | null) { scope = next; pending = null; },
    scope: (): string | null => scope,
    list: (): Shortcut[] => [...shortcuts],
    handle(e: KeyInput): boolean {
      if (e.defaultPrevented || e.altKey || opts.blocked?.()) return false;
      // Mod-k also answers to Cmd, so ⌘K and Ctrl-K are one binding. Mod-b is ⌘B on macOS and Ctrl-b elsewhere, which leaves
      // Ctrl-b (a terminal multiplexer prefix) free for a shell on macOS.
      const letter = e.key.toLowerCase();
      const modK = (e.metaKey || e.ctrlKey) && !e.shiftKey && letter === "k";
      const modB = letter === "b" && !e.shiftKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
      if (e.metaKey && !modK && !modB) return false;
      const token = modK ? "Mod-k" : modB ? "Mod-b" : e.ctrlKey ? `Ctrl-${e.key}` : e.key;
      if (e.ctrlKey && e.key === "Control") return false;
      // Escape, Mod-k, Mod-b and Ctrl combinations stay available in text fields; plain keys do not.
      if (!e.ctrlKey && token !== "Escape" && token !== "Mod-k" && token !== "Mod-b" && isTextTarget(e.target)) { pending = null; return false; }
      if (pending && now() - pending.at > timeout) pending = null;
      const candidates = active();
      for (const keys of pending ? [`${pending.keys} ${token}`, token] : [token]) {
        const match = candidates.find(s => s.keys === keys);
        if (match) { pending = null; e.preventDefault(); match.run(); return true; }
        if (candidates.some(s => s.keys.startsWith(`${keys} `))) { pending = { keys, at: now() }; return false; }
      }
      pending = null;
      return false;
    },
  };
}
export type KeyRegistry = ReturnType<typeof createKeyRegistry>;

/** The only DOM-touching export: one keydown listener for the whole app. */
export function attachKeyRegistry(registry: KeyRegistry, target: Window): () => void {
  const listener = (e: KeyboardEvent) => { registry.handle(e); };
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}

/** Overview bindings and their compact footer vocabulary share one registry definition. */
export const overviewHints = [
  { keys: "j k", label: "select" }, { keys: "Enter", label: "act" }, { keys: "v", label: "review" },
  { keys: "d", label: "delegate" }, { keys: "1–4", label: "repo filter" }, { keys: "x", label: "dismiss" },
];
