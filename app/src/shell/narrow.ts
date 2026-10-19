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
export function useNarrow(query: RouteQuery): boolean {
  const [small, setSmall] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(NARROW_MEDIA).matches);
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_MEDIA);
    if (!media) return;
    const update = () => setSmall(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return small || scopeRepo(query) !== null;
}
