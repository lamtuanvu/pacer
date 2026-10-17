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

export function createKeyRegistry(opts: { controlActive: () => boolean; timeoutMs?: number; now?: () => number }) {
  const timeout = opts.timeoutMs ?? 1000, now = opts.now ?? (() => Date.now());
  const shortcuts: Shortcut[] = [];
  let scope: string | null = null, pending: { keys: string; at: number } | null = null;
  const active = () => shortcuts.filter(s => (s.scope === "global" || s.scope === scope) && (!opts.controlActive() || s.allowInControl));
  return {
    register(shortcut: Shortcut): () => void {
      shortcuts.push(shortcut);
      return () => { const at = shortcuts.indexOf(shortcut); if (at >= 0) shortcuts.splice(at, 1); };
    },
    setScope(next: string | null) { scope = next; pending = null; },
    scope: (): string | null => scope,
    list: (): Shortcut[] => [...shortcuts],
    handle(e: KeyInput): boolean {
      if (e.defaultPrevented || e.metaKey || e.altKey) return false;
      const token = e.ctrlKey ? `Ctrl-${e.key}` : e.key;
      if (e.ctrlKey && e.key === "Control") return false;
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

/** The only DOM-touching export: one keydown listener for the whole app. */
export function attachKeyRegistry(registry: KeyRegistry, target: Window): () => void {
  const listener = (e: KeyboardEvent) => { registry.handle(e); };
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}
