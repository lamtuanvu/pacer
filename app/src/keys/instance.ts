import { createKeyRegistry } from "./registry";
/** True while a modal dialog is open: it owns the keyboard, including Escape to close it. */
export const dialogOpen = (doc: { querySelector: (s: string) => unknown } | undefined): boolean => !!doc?.querySelector("dialog[open]");
/** The app's one registry instance; screens register their shortcuts on it. */
export const keys = createKeyRegistry({ controlActive: () => false, blocked: () => dialogOpen(typeof document === "undefined" ? undefined : document) });
