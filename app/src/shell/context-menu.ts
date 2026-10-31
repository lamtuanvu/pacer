import { CHROME_SELECTOR } from "../ds/chrome";
/** The browser's own context menu stays on chrome only where a user might want copy or the webview's menu is noise. */
const NOT_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]);
/** A text input/textarea/contentEditable passes the caret's right-click through. Duck-typed like keys/registry.ts:isTextTarget. */
function isTextTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string }): boolean {
  const tag = el.tagName?.toUpperCase();
  return el.isContentEditable === true || tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && !NOT_TEXT_INPUTS.has((el.type ?? "text").toLowerCase()));
}
/** Allow: text fields, editable content, code/pre, the terminal, an active selection, or plain content; suppress only on app chrome. */
export function allowsNativeContextMenu(target: unknown, selectionText?: string): boolean {
  if (typeof target !== "object" || target === null) return true;
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string; closest?: (sel: string) => unknown };
  if (isTextTarget(el) || !!selectionText) return true;
  if (el.closest?.("code, pre, .xterm")) return true;
  return !el.closest?.(CHROME_SELECTOR);
}
/** One contextmenu listener for the whole surface. Passes the current selection so copy onto selected chrome still works. */
export function attachContextMenuPolicy(target: Window): () => void {
  const onContextMenu = (event: Event) => {
    const payload = event as { target?: unknown };
    const selection = typeof globalThis.getSelection === "function" ? String(globalThis.getSelection?.() ?? "") : "";
    if (!allowsNativeContextMenu(payload.target, selection)) event.preventDefault();
  };
  target.addEventListener("contextmenu", onContextMenu);
  return () => target.removeEventListener("contextmenu", onContextMenu);
}
