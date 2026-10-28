import { createKeyRegistry } from "./registry";
/** True while a modal dialog is open: it owns the keyboard, including Escape to close it. */
export const dialogOpen = (doc: { querySelector: (s: string) => unknown } | undefined): boolean => !!doc?.querySelector("dialog[open]");
/** Terminals explicitly mark control ownership, even when focus has left the terminal. The terminal dock owns the keyboard only while focus is inside it. */
export const sessionControlActive = (doc: { querySelector: (s: string) => unknown } | undefined): boolean => {
  const control = doc?.querySelector('[data-session-control="true"]') as { closest?: (s: string) => unknown } | null | undefined;
  return !!control && !control.closest?.(".pc-dock:not(:focus-within)");
};
/** The app's one registry instance; screens register their shortcuts on it. */
export const keys = createKeyRegistry({ controlActive: () => sessionControlActive(typeof document === "undefined" ? undefined : document), blocked: () => dialogOpen(typeof document === "undefined" ? undefined : document) });
