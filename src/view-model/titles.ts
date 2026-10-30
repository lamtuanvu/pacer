import { generatedGoalTitle, goalTitle } from "../core/goal-title";
import { shortTitle } from "../core/short-title";

/** Complete text from current services; older services retain their title/goal fallback. */
export function displayTitle(item: { fullTitle?: string; title?: string; goal?: string }): string {
  const title = item.fullTitle?.trim() || item.title?.trim();
  const generated = title && generatedGoalTitle(title, item.goal ?? "");
  return title && !generated ? title : goalTitle(item.goal ?? "");
}

/** Compact task heading for rows and accessible names; retain the complete brief in title attributes. */
export function taskHeading(title: string): string {
  return shortTitle(title);
}
