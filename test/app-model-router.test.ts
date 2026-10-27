import { expect, test } from "bun:test";
import { hrefFor, parentFor, primaryFor, resolveRoute, routes, titleFor, withQuery, type Route } from "../app/src/router";

const q = { repo: null, scope: null };
const route = (hash: string, setup: boolean | null = true) => resolveRoute(hash, setup) as Route;

test("new routes resolve with their ids and sections", () => {
  expect(route("#/")).toEqual({ name: "start", query: q });
  expect(route("")).toEqual({ name: "start", query: q });
  expect(route("#/overview")).toEqual({ name: "overview", query: q });
  expect(route("#/needs-you")).toEqual({ name: "review", query: q });
  expect(route("#/tasks/t-0412")).toEqual({ name: "sessions", id: "t-0412", query: q });
  expect(route("#/tasks")).toEqual({ name: "sessions", query: q });
  expect(route("#/tasks/a%20b")).toEqual({ name: "sessions", id: "a b", query: q });
  expect(route("#/settings")).toEqual({ name: "settings", query: q });
  expect(route("#/settings/executors")).toEqual({ name: "settings", section: "executors", query: q });
  expect(route("#/settings/hosts")).toEqual({ name: "hosts", query: q });
  expect(route("#/settings/hosts/devbox")).toEqual({ name: "hosts", alias: "devbox", query: q });
  expect(route("#/settings/add-executor")).toEqual({ name: "add-executor", query: q });
});

test("unknown or malformed routes fall back to Overview", () => {
  for (const hash of ["#/missing", "#/review/a/b", "#/sessions/%ZZ", "#/settings/hosts/%ZZ", "#/settings/nope"]) expect(route(hash)).toEqual({ name: "overview", query: q });
});

test("the repo filter and scope come from the query and survive", () => {
  expect(route("#/?repo=github.com%2Facme%2Fapi")).toEqual({ name: "start", query: { repo: "github.com/acme/api", scope: null } });
  expect(route("#/tasks/t1?scope=repo:github.com/acme/api").query).toEqual({ repo: null, scope: "repo:github.com/acme/api" });
  expect(withQuery("#/review/t1", { repo: "github.com/acme/api", scope: null })).toBe("#/review/t1?repo=github.com%2Facme%2Fapi");
  expect(withQuery("#/", q)).toBe("#/");
});

test("old routes fall back to Overview and keep the repo filter and scope", () => {
  for (const hash of ["#/executors", "#/executors/add", "#/accounts", "#/strategy", "#/hosts"]) {
    expect(resolveRoute(hash)).toEqual({ name: "overview", query: q });
    expect(resolveRoute(`${hash}?repo=k&scope=all`)).toEqual({ name: "overview", query: { repo: "k", scope: "all" } });
  }
});

test("former routing and strategies settings links lead to Dispatcher with work scope", () => {
  for (const section of ["routing", "strategies"]) {
    expect(resolveRoute(`#/settings/${section}`)).toEqual({redirect:"#/settings/dispatcher"});
    expect(resolveRoute(`#/settings/${section}?repo=k&scope=all`)).toEqual({redirect:"#/settings/dispatcher?repo=k&scope=all"});
    expect(resolveRoute(`#/settings/${section}?repo=k&scope=all`,false)).toEqual({redirect:"#/settings/dispatcher?repo=k&scope=all"});
    expect(resolveRoute(`#/settings/${section}?repo=k&scope=all`,null)).toEqual({redirect:"#/settings/dispatcher?repo=k&scope=all"});
  }
});

test("incomplete setup redirects to Setup except within settings", () => {
  for (const hash of ["#/", "#/review/one", "#/sessions", "#/missing", "#/tasks/t1"]) expect(resolveRoute(hash, false)).toEqual({ redirect: "#/setup" });
  expect(resolveRoute("#/review/one?repo=k&scope=all", false)).toEqual({ redirect: "#/setup?repo=k&scope=all" });
  expect(route("#/settings", false).name).toBe("settings");
  expect(route("#/settings/hosts", false).name).toBe("hosts");
  expect(route("#/settings/add-executor", false).name).toBe("add-executor");
});

test("interactive entry and its sessions do not require planner integration setup", () => {
  expect(resolveRoute("#/", false, true)).toEqual({name:"start",query:q});
  expect(resolveRoute("#/tasks/one", false, true)).toEqual({name:"sessions",id:"one",query:q});
  expect(resolveRoute("#/overview", false, true)).toEqual({redirect:"#/setup"});
});

test("while the first setup check is in flight, screens wait instead of flashing Setup", () => {
  expect(route("#/", null).name).toBe("loading");
  expect(route("#/review/t1", null).name).toBe("loading");
  expect(route("#/settings", null).name).toBe("settings");
});

test("setup is unknown until a setup check answers; a failed check keeps waiting instead of showing Setup", async () => {
  const { setupCompleteFrom } = await import("../app/src/router");
  expect(setupCompleteFrom(undefined)).toBeNull();
  expect(setupCompleteFrom("error")).toBeNull();
  expect(setupCompleteFrom({ complete: false })).toBe(false);
  expect(setupCompleteFrom({ complete: true })).toBe(true);
});

test("Setup is reachable after required completion and Settings remains available before it", () => {
  expect(route("#/setup", false).name).toBe("setup");
  expect(route("#/setup", true).name).toBe("setup");
  expect(route("#/setup", null).name).toBe("loading");
  expect(route("#/settings", false).name).toBe("settings");
});

test("new destinations and legacy bookmarks preserve task IDs and repository scope", () => {
 expect(resolveRoute("#/needs-you?repo=acme")).toMatchObject({name:"review",query:{repo:"acme"}});
 expect(resolveRoute("#/tasks/old-task?repo=acme")).toMatchObject({name:"sessions",id:"old-task",query:{repo:"acme"}});
 expect(resolveRoute("#/review/old-task?repo=acme")).toEqual({redirect:"#/tasks/old-task?repo=acme"});
 expect(resolveRoute("#/review")).toEqual({redirect:"#/needs-you"});
 expect(resolveRoute("#/sessions")).toEqual({redirect:"#/tasks"});
});

test("canonical route targets generate URLs that round-trip with metadata", () => {
 const cases = [
  [routes.start(), "#/", "Start work", "start", null],
  [routes.overview(), "#/overview", "Overview", "overview", null],
  [routes.needsYou(), "#/needs-you", "Needs you", "review", null],
  [routes.tasks(), "#/tasks", "Tasks", "sessions", null],
  [routes.task("a b/c"), "#/tasks/a%20b%2Fc", "Task", "sessions", routes.tasks()],
  [routes.settings("executors"), "#/settings/executors", "Agents", "settings", routes.settings()],
  [routes.hosts(), "#/settings/hosts", "Machines", "settings", routes.settings()],
  [routes.host("dev box/a"), "#/settings/hosts/dev%20box%2Fa", "Host", "settings", routes.hosts()],
  [routes.addExecutor(), "#/settings/add-executor", "Add an agent", "settings", routes.settings()],
  [routes.setup(), "#/setup", "Set up pacer", null, null],
 ] as const;
 for (const [target, href, title, primary, parent] of cases) {
  expect(hrefFor(target)).toBe(href);
  const resolved = route(href);
  expect(titleFor(resolved)).toBe(title);
  expect(primaryFor(resolved)).toBe(primary);
  expect(parentFor(resolved)).toEqual(parent && {...parent, query:q});
 }
});

test("add executor targets preserve the selected host parameter", () => {
 expect(hrefFor(routes.addExecutor("dev box"),{repo:"acme",scope:null})).toBe("#/settings/add-executor?host=dev+box&repo=acme");
 expect(route("#/settings/add-executor?host=dev+box&repo=acme")).toEqual({name:"add-executor",host:"dev box",query:{repo:"acme",scope:null}});
});

test("canonical hrefs inherit work scope and allow explicit overrides", () => {
 const current = {repo:"acme/api",scope:"repo:acme/api"};
 expect(hrefFor(routes.task("one"),current)).toBe("#/tasks/one?repo=acme%2Fapi&scope=repo%3Aacme%2Fapi");
 expect(hrefFor(routes.settings("planner"),current)).toBe("#/settings/planner?repo=acme%2Fapi&scope=repo%3Aacme%2Fapi");
 expect(hrefFor(routes.overview({repo:null,scope:"all"}),current)).toBe("#/overview?scope=all");
 expect(parentFor(route("#/tasks/one?repo=acme&scope=all"))).toEqual(routes.tasks({repo:"acme",scope:"all"}));
});
