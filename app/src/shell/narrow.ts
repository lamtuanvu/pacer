import { useEffect, useState } from "preact/hooks";
import type { RouteQuery } from "../router";

export { NarrowContext } from "../ds/Density";
export const NARROW_MEDIA = "(width < 560px)";
export function scopeRepo(query: RouteQuery): string | null {
  return query.scope?.startsWith("repo:") ? query.scope.slice(5) || null : null;
}
/** An empty repo is an explicit All repos selection within a persistent repo scope. */
export function activeRepo(query: RouteQuery): string | null {
  return (query.repo === "" ? null : scopeRepo(query) ?? query.repo);
}
/** Side panels show from this width; below it the shell hides them, as it hid the settings panel before. */
export const PANEL_MEDIA = "(width >= 768px)";
/** `fallback` applies where media queries are unavailable, such as server rendering. */
export function useMedia(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : fallback);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
export function useNarrow(query: RouteQuery): boolean {
  return useMedia(NARROW_MEDIA) || scopeRepo(query) !== null;
}
