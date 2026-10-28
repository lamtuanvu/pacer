/** The app's one shortcut registry. Pure apart from attachKeyRegistry, so tests need no DOM. */
export interface Shortcut { keys: string; label: string; scope: "global" | string; run: () => void; allowInControl?: boolean }
export interface KeyInput {
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean;
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
export function createKeyRegistry(opts: { controlActive: () => boolean; blocked?: () => boolean; timeoutMs?: number; now?: () => number }) {
  const timeout = opts.timeoutMs ?? 1000, now = opts.now ?? (() => Date.now());
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
      if (e.defaultPrevented || e.altKey || (e.metaKey && e.ctrlKey) || opts.blocked?.()) return false;
      const token = e.metaKey ? `Meta-${e.key}` : e.ctrlKey ? `Ctrl-${e.key}` : e.key;
      if ((e.ctrlKey && e.key === "Control") || (e.metaKey && e.key === "Meta")) return false;
      // ⌘ belongs to the browser and the OS: only an exact registered ⌘ shortcut runs, and it never starts a sequence.
      if (e.metaKey) {
        const match = active().find(s => s.keys === token);
        if (!match) return false;
        pending = null; e.preventDefault(); match.run(); return true;
      }
      // Escape and Ctrl combinations stay available in text fields; plain keys do not.
      if (!e.ctrlKey && token !== "Escape" && isTextTarget(e.target)) { pending = null; return false; }
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

/** Apple platforms use ⌘ where others use Ctrl. */
export const isApplePlatform = (platform: string = globalThis.navigator?.platform ?? ""): boolean => /mac|iphone|ipad/i.test(platform);
/** A registry key for the platform's command modifier: `Meta-n` on Apple platforms, `Ctrl-n` elsewhere. */
export const modShortcut = (key: string, apple = isApplePlatform()): string => `${apple ? "Meta" : "Ctrl"}-${key}`;
/** How a modifier shortcut is written for people: ⌘N, Ctrl+N. */
export const shortcutLabel = (keys: string): string => keys.replace(/^Meta-(.)$/, (_, k: string) => `⌘${k.toUpperCase()}`).replace(/^Ctrl-(.)$/, (_, k: string) => `Ctrl+${k.toUpperCase()}`);
/**
 * ⌘N (Ctrl+N elsewhere) opens the New task composer. The shell registers it once; the title-bar and Dispatch
 * "New task" buttons show `shortcutLabel(newTaskShortcut(...).keys)` and call the same `run`.
 */
export function newTaskShortcut(run: () => void, apple = isApplePlatform()): Shortcut {
  return { keys: modShortcut("n", apple), label: "New task", scope: "global", run };
}

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
