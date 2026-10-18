/** The Appearance setting (Settings › Appearance) is per device; every page on this origin follows it. */
export const THEME_KEY = "pacer.theme";
export type ThemeChoice = "system" | "light" | "dark";

export function savedTheme(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemeChoice {
  try { const v = storage?.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement) {
  if (choice === "system") delete root.dataset.theme; else root.dataset.theme = choice;
}
/** Apply now and follow changes made in another window (the tray popover and the main window share storage). */
export function followSavedTheme(): () => void {
  applyTheme(savedTheme());
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === THEME_KEY) applyTheme(savedTheme()); };
  const onFocus = () => applyTheme(savedTheme());
  addEventListener("storage", onStorage); addEventListener("focus", onFocus);
  return () => { removeEventListener("storage", onStorage); removeEventListener("focus", onFocus); };
}
function safeStorage(): Storage | null { try { return localStorage; } catch { return null; } }
