/** Hash routes for the redesigned shell. Unknown hashes fall back to Overview. */
export interface RouteQuery { repo: string | null; scope: string | null }
type RouteBase =
  | { name: "overview" | "loading" }
  | { name: "add-executor"; host?: string }
  | { name: "review" | "sessions"; id?: string }
  | { name: "settings"; section?: string }
  | { name: "hosts"; alias?: string }
  ;
export type Route = RouteBase & { query: RouteQuery };
export const SETTINGS_SECTIONS = ["planner", "accounts", "executors", "routing", "strategies", "updates", "notifications", "appearance"] as const;

export function withQuery(href: string, query: RouteQuery): string {
  const params = new URLSearchParams();
  if (query.repo !== null) params.set("repo", query.repo);
  if (query.scope) params.set("scope", query.scope);
  const search = params.toString();
  return search ? `${href}?${search}` : href;
}
/** A setup check that has not answered, or failed, leaves setup unknown: screens wait rather than flash Setup. */
export const setupCompleteFrom = (check: { complete: boolean } | "error" | undefined): boolean | null => check === undefined || check === "error" ? null : check.complete;
function decode(part: string): string | null { try { return decodeURIComponent(part); } catch { return null; } }

/**
 * setupComplete: true, false, or null while the first setup check is still in flight (screens wait rather than flash Setup).
 */
export function resolveRoute(hash: string, setupComplete: boolean | null = true): Route | { redirect: string } {
  const raw = hash.replace(/^#/, "") || "/";
  const [path = "/", search = ""] = raw.split("?");
  const params = new URLSearchParams(search);
  const query: RouteQuery = { repo: params.get("repo"), scope: params.get("scope") };
  const route = match(path);
  const settingsArea = route.name === "settings" || route.name === "hosts" || route.name === "add-executor";
  if (!settingsArea && setupComplete === null) return { name: "loading", query };
  if (!settingsArea && setupComplete === false) return { redirect: withQuery("#/settings", query) };
  return { ...route, ...(route.name === "add-executor" && params.has("host") ? { host: params.get("host")! } : {}), query } as Route;
}
function match(path: string): RouteBase {
  if (path === "/") return { name: "overview" };
  if (path === "/settings") return { name: "settings" };
  if (path === "/settings/hosts") return { name: "hosts" };
  if (path === "/settings/add-executor") return { name: "add-executor" };
  const parts = /^\/(review|sessions)(?:\/([^/]+))?$/.exec(path);
  if (parts) {
    if (parts[2] === undefined) return { name: parts[1] as "review" | "sessions" };
    const id = decode(parts[2]);
    return id === null ? { name: "overview" } : { name: parts[1] as "review" | "sessions", id };
  }
  const host = /^\/settings\/hosts\/([^/]+)$/.exec(path);
  if (host) { const alias = decode(host[1]!); return alias === null ? { name: "overview" } : { name: "hosts", alias }; }
  const section = /^\/settings\/([^/]+)$/.exec(path)?.[1];
  if (section && (SETTINGS_SECTIONS as readonly string[]).includes(section)) return { name: "settings", section };
  return { name: "overview" };
}

/** Preserve work scope on internal navigation, while allowing an explicit filter change. */
export function inheritQuery(href: string, current: string): string {
  if (!href.startsWith("#/")) return href;
  const [path, search = ""] = href.split("?");
  const params = new URLSearchParams(search), before = new URLSearchParams(current.split("?")[1] ?? "");
  for (const key of ["repo", "scope"]) if (!params.has(key) && before.has(key)) params.set(key, before.get(key)!);
  return `${path}${params.size ? `?${params}` : ""}`;
}
