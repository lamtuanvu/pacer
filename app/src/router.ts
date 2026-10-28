import { settingsPageTitle } from "./settings-pages";

/** Hash routes for the redesigned shell. Unknown hashes fall back to Overview. */
export interface RouteQuery { repo: string | null; scope: string | null }
type RouteBase =
  | { name: "start" | "overview" | "loading" | "setup" }
  | { name: "add-executor"; host?: string }
  | { name: "review" | "sessions" | "terminal"; id?: string }
  | { name: "settings"; section?: string }
  | { name: "hosts"; alias?: string }
  ;
export type Route = RouteBase & { query: RouteQuery };
export type RouteName = Route["name"];
export type PrimaryRoute = "start" | "overview" | "review" | "sessions" | "terminal" | "settings" | null;
type TargetQuery = Partial<RouteQuery>;
export type RouteTarget =
  | { name: "start" | "overview" | "review" | "setup"; query?: TargetQuery }
  | { name: "sessions" | "terminal"; id?: string; query?: TargetQuery }
  | { name: "settings"; section?: string; query?: TargetQuery }
  | { name: "hosts"; alias?: string; query?: TargetQuery }
  | { name: "add-executor"; host?: string; query?: TargetQuery };
export const SETTINGS_SECTIONS = ["planner", "accounts", "executors", "machine", "dispatcher", "app", "updates", "notifications", "appearance", "assistant", "diagnostics"] as const;
const EMPTY_QUERY: RouteQuery = { repo: null, scope: null };
const withTargetQuery = <T extends RouteTarget>(target: T, query?: TargetQuery): T => query ? { ...target, query } : target;
export const routes = {
  start: (query?: TargetQuery) => withTargetQuery({ name: "start" } as const, query),
  overview: (query?: TargetQuery) => withTargetQuery({ name: "overview" } as const, query),
  needsYou: (query?: TargetQuery) => withTargetQuery({ name: "review" } as const, query),
  tasks: (query?: TargetQuery) => withTargetQuery({ name: "sessions" } as const, query),
  task: (id: string, query?: TargetQuery) => withTargetQuery({ name: "sessions", id } as const, query),
  terminal: (id?: string | TargetQuery, query?: TargetQuery) => typeof id === "string"
    ? withTargetQuery({ name: "terminal", id } as const, query)
    : withTargetQuery({ name: "terminal" } as const, id),
  settings: (section?: string, query?: TargetQuery) => withTargetQuery({ name: "settings", ...(section ? { section } : {}) } as const, query),
  hosts: (query?: TargetQuery) => withTargetQuery({ name: "hosts" } as const, query),
  host: (alias: string, query?: TargetQuery) => withTargetQuery({ name: "hosts", alias } as const, query),
  addExecutor: (host?: string, query?: TargetQuery) => withTargetQuery({ name: "add-executor", ...(host ? { host } : {}) } as const, query),
  setup: (query?: TargetQuery) => withTargetQuery({ name: "setup" } as const, query),
};

function mergedQuery(target: RouteTarget, current: RouteQuery = EMPTY_QUERY): RouteQuery {
  return { repo: target.query?.repo === undefined ? current.repo : target.query.repo, scope: target.query?.scope === undefined ? current.scope : target.query.scope };
}
export function hrefFor(target: RouteTarget, current: RouteQuery = EMPTY_QUERY): string {
  let href: string;
  switch (target.name) {
    case "start": href = "#/"; break;
    case "overview": href = "#/overview"; break;
    case "review": href = "#/needs-you"; break;
    case "sessions": href = target.id ? `#/tasks/${encodeURIComponent(target.id)}` : "#/tasks"; break;
    case "terminal": href = target.id ? `#/terminal/${encodeURIComponent(target.id)}` : "#/terminal"; break;
    case "settings": href = target.section ? `#/settings/${encodeURIComponent(target.section)}` : "#/settings"; break;
    case "hosts": href = target.alias ? `#/settings/hosts/${encodeURIComponent(target.alias)}` : "#/settings/hosts"; break;
    case "add-executor": href = "#/settings/add-executor"; break;
    case "setup": href = "#/setup"; break;
  }
  const query = mergedQuery(target, current);
  if (target.name !== "add-executor" || !target.host) return withQuery(href, query);
  const params = new URLSearchParams({ host: target.host });
  if (query.repo !== null) params.set("repo", query.repo);
  if (query.scope) params.set("scope", query.scope);
  return `${href}?${params}`;
}
export function parentFor(route: Route): RouteTarget | null {
  if (route.name === "sessions" && route.id) return routes.tasks(route.query);
  if (route.name === "terminal" && route.id) return routes.terminal(route.query);
  if (route.name === "settings" && route.section) return routes.settings(undefined, route.query);
  if (route.name === "hosts") return route.alias ? routes.hosts(route.query) : routes.settings(undefined, route.query);
  if (route.name === "add-executor") return routes.settings(undefined, route.query);
  return null;
}
export function titleFor(route: Route): string {
  if (route.name === "start") return "Start work";
  if (route.name === "sessions" && route.id) return "Task";
  if (route.name === "terminal") return "Terminal";
  if (route.name === "hosts" && route.alias) return "Host";
  if (route.name === "settings") return settingsPageTitle(route.section);
  return route.name === "overview" ? "Overview" : route.name === "review" ? "Needs you" : route.name === "sessions" ? "Tasks" : route.name === "hosts" ? "Remote hosts" : route.name === "add-executor" ? "Add executor" : route.name === "setup" ? "Set up pacer" : "pacer";
}
export function primaryFor(route: Route): PrimaryRoute {
  if (route.name === "start") return "start";
  return route.name === "overview" || route.name === "review" || route.name === "sessions" || route.name === "terminal" ? route.name : route.name === "settings" || route.name === "hosts" || route.name === "add-executor" ? "settings" : null;
}

/** Map service settings sections to Settings; setup item ids open Overview. */
export function settingsPath(section: unknown): string {
  if (typeof section !== "string") return "/settings";
  if (section === "routing" || section === "strategies") return "/settings/dispatcher";
  return (SETTINGS_SECTIONS as readonly string[]).includes(section) ? `/settings/${section}` : "/";
}

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
export function resolveRoute(hash: string, setupComplete: boolean | null = true, interactiveEntry = false): Route | { redirect: string } {
  const raw = hash.replace(/^#/, "") || "/";
  const [path = "/", search = ""] = raw.split("?");
  const params = new URLSearchParams(search);
  const query: RouteQuery = { repo: params.get("repo"), scope: params.get("scope") };
  if (path === "/settings/routing" || path === "/settings/strategies") return {redirect:withQuery("#/settings/dispatcher",query)};
  const route = match(path);
  const settingsArea = route.name === "settings" || route.name === "hosts" || route.name === "add-executor";
  const interactiveArea = interactiveEntry && (route.name === "start" || route.name === "sessions");
  if (!settingsArea && !interactiveArea && setupComplete === null) return { name: "loading", query };
  if (!settingsArea && !interactiveArea && route.name !== "setup" && setupComplete === false) return { redirect: withQuery("#/setup", query) };
  const legacy = /^\/(review|sessions)(?:\/(.*))?$/.exec(path);
  if (legacy) {
    const destination = legacy[2] !== undefined ? `/tasks/${legacy[2]}` : legacy[1] === "review" ? "/needs-you" : "/tasks";
    if (legacy[2] === undefined || (!legacy[2].includes("/") && decode(legacy[2]) !== null)) return {redirect:withQuery(`#${destination}`,query)};
  }
  return { ...route, ...(route.name === "add-executor" && params.has("host") ? { host: params.get("host")! } : {}), query } as Route;
}
function match(path: string): RouteBase {
  if (path === "/setup") return { name: "setup" };
  if (path === "/") return { name: "start" };
  if (path === "/overview") return { name: "overview" };
  if (path === "/settings") return { name: "settings" };
  if (path === "/settings/hosts") return { name: "hosts" };
  if (path === "/settings/add-executor") return { name: "add-executor" };
  if (path === "/needs-you") return {name:"review"};
  if (path === "/tasks") return {name:"sessions"};
  if (path === "/terminal") return {name:"terminal"};
  const terminal = /^\/terminal\/([^/]+)$/.exec(path);
  if (terminal) { const id = decode(terminal[1]!); return id === null ? { name: "overview" } : { name: "terminal", id }; }
  const parts = /^\/(review|sessions|tasks)(?:\/([^/]+))?$/.exec(path);
  if (parts) {
    if (parts[2] === undefined) return { name: parts[1] as "review" | "sessions" };
    const id = decode(parts[2]);
    return id === null ? { name: "overview" } : { name: parts[1] === "tasks" ? "sessions" : parts[1] as "review" | "sessions", id };
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
