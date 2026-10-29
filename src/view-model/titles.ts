import { shortTitle } from "../core/short-title";

/** Complete text from current services; older services retain their title/goal fallback. */
export function displayTitle(item: { fullTitle?: string; title?: string; goal?: string }): string {
  return item.fullTitle?.trim() || item.title?.trim() || item.goal?.trim() || "Task";
}

/** Compact task heading for rows and accessible names; retain the complete brief in title attributes. */
export function taskHeading(title: string): string {
  return shortTitle(title);
}
