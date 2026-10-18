/** Hash routes for the redesigned shell. Old routes redirect for one minor release. */
export interface RouteQuery { repo: string | null; scope: string | null }
type RouteBase =
  | { name: "overview" | "add-executor" | "setup" | "loading" | "not-found" }
  | { name: "review" | "sessions"; id?: string }
  | { name: "settings"; section?: string }
  | { name: "hosts"; alias?: string }
  ;
export type Route = RouteBase & { query: RouteQuery };
export const SETTINGS_SECTIONS = ["planner", "accounts", "executors", "routing", "strategies", "updates", "notifications", "appearance"] as const;

const REDIRECTS: Record<string, string> = {
  "/tasks": "/sessions", "/executors": "/settings/executors", "/executors/add": "/settings/add-executor",
  "/accounts": "/settings/accounts", "/strategy": "/settings/strategies", "/hosts": "/settings/hosts", "/setup": "/",
};

export function withQuery(href: string, query: RouteQuery): string {
  const params = new URLSearchParams();
  if (query.repo) params.set("repo", query.repo);
  if (query.scope) params.set("scope", query.scope);
  const search = params.toString();
  return search ? `${href}?${search}` : href;
}
/** A setup check that has not answered, or failed, leaves setup unknown: screens wait rather than flash Setup. */
export const setupCompleteFrom = (check: { complete: boolean } | "error" | undefined): boolean | null => check === undefined || check === "error" ? null : check.complete;
function decode(part: string): string | null { try { return decodeURIComponent(part); } catch { return null; } }

/**
 * setupComplete: true, false, or null while the first setup check is still in flight (screens wait rather than flash Setup).
 * reviewTarget sends an old #/tasks/<id> link to Review when the task waits for review, else to Sessions; null means the snapshot
 * has not arrived yet, so the link waits rather than guessing.
 */
export function resolveRoute(hash: string, setupComplete: boolean | null = true, reviewTarget?: (id: string) => "review" | "sessions" | null): Route | { redirect: string } {
  const raw = hash.replace(/^#/, "") || "/";
  const [path = "/", search = ""] = raw.split("?");
  const params = new URLSearchParams(search);
  const query: RouteQuery = { repo: params.get("repo"), scope: params.get("scope") };
  const keep = (to: string) => ({ redirect: withQuery(`#${to}`, query) });
  if (Object.hasOwn(REDIRECTS, path)) return keep(REDIRECTS[path]!);
  const oldTask = /^\/tasks\/([^/]+)$/.exec(path);
  if (oldTask) {
    const id = decode(oldTask[1]!);
    if (id !== null) {
      const target = reviewTarget ? reviewTarget(id) : "sessions";
      if (target === null) return { name: "loading", query };
      return keep(`/${target}/${encodeURIComponent(id)}`);
    }
  }
  const route = match(path);
  const settingsArea = route.name === "settings" || route.name === "hosts" || route.name === "add-executor";
  if (!settingsArea && setupComplete === null) return { name: "loading", query };
  if (!settingsArea && setupComplete === false) return { name: "setup", query };
  return { ...route, query } as Route;
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
    return id === null ? { name: "not-found" } : { name: parts[1] as "review" | "sessions", id };
  }
  const host = /^\/settings\/hosts\/([^/]+)$/.exec(path);
  if (host) { const alias = decode(host[1]!); return alias === null ? { name: "not-found" } : { name: "hosts", alias }; }
  const section = /^\/settings\/([^/]+)$/.exec(path)?.[1];
  if (section && (SETTINGS_SECTIONS as readonly string[]).includes(section)) return { name: "settings", section };
  return { name: "not-found" };
}
