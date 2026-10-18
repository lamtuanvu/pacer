import { createKeyRegistry } from "./registry";
/** True while a modal dialog is open: it owns the keyboard, including Escape to close it. */
export const dialogOpen = (doc: { querySelector: (s: string) => unknown } | undefined): boolean => !!doc?.querySelector("dialog[open]");
/** Terminals explicitly mark control ownership, even when focus has left the terminal. */
export const sessionControlActive = (doc: { querySelector: (s: string) => unknown } | undefined): boolean => !!doc?.querySelector('[data-session-control="true"]');
/** The app's one registry instance; screens register their shortcuts on it. */
export const keys = createKeyRegistry({ controlActive: () => sessionControlActive(typeof document === "undefined" ? undefined : document), blocked: () => dialogOpen(typeof document === "undefined" ? undefined : document) });
