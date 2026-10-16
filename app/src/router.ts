export type RouteName = "home" | "setup" | "tasks" | "task" | "executors" | "add-executor" | "accounts" | "strategy" | "hosts" | "settings" | "not-found";
export type Route = { name: Exclude<RouteName, "task"> } | { name: "task"; id: string };
export function resolveRoute(hash: string, setupComplete = true): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (!setupComplete && path !== "/settings") return { name: "setup" };
  const routes: Record<string, RouteName> = { "/": "home", "/setup": "setup", "/tasks": "tasks", "/executors": "executors", "/executors/add": "add-executor", "/accounts": "accounts", "/strategy": "strategy", "/hosts": "hosts", "/settings": "settings" };
  const name = routes[path];
  if (name && name !== "task") return { name };
  const task = /^\/tasks\/([^/]+)$/.exec(path);
  if (task) { try { return { name: "task", id: decodeURIComponent(task[1]!) }; } catch { /* invalid URL encoding */ } }
  return { name: "not-found" };
}
