import { expect, test } from "bun:test";
import { resolveRoute, withQuery, type Route } from "../app/src/router";

const q = { repo: null, scope: null };
const route = (hash: string, setup: boolean | null = true) => resolveRoute(hash, setup) as Route;

test("new routes resolve with their ids and sections", () => {
  expect(route("#/")).toEqual({ name: "overview", query: q });
  expect(route("")).toEqual({ name: "overview", query: q });
  expect(route("#/review")).toEqual({ name: "review", query: q });
  expect(route("#/review/t-0412")).toEqual({ name: "review", id: "t-0412", query: q });
  expect(route("#/sessions")).toEqual({ name: "sessions", query: q });
  expect(route("#/sessions/a%20b")).toEqual({ name: "sessions", id: "a b", query: q });
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
  expect(route("#/?repo=github.com%2Facme%2Fapi")).toEqual({ name: "overview", query: { repo: "github.com/acme/api", scope: null } });
  expect(route("#/review/t1?scope=repo:github.com/acme/api").query).toEqual({ repo: null, scope: "repo:github.com/acme/api" });
  expect(withQuery("#/review/t1", { repo: "github.com/acme/api", scope: null })).toBe("#/review/t1?repo=github.com%2Facme%2Fapi");
  expect(withQuery("#/", q)).toBe("#/");
});

test("old routes fall back to Overview and keep the repo filter and scope", () => {
  for (const hash of ["#/tasks", "#/tasks/t1", "#/executors", "#/executors/add", "#/accounts", "#/strategy", "#/hosts"]) {
    expect(resolveRoute(hash)).toEqual({ name: "overview", query: q });
    expect(resolveRoute(`${hash}?repo=k&scope=all`)).toEqual({ name: "overview", query: { repo: "k", scope: "all" } });
  }
});

test("incomplete setup redirects to Setup except within settings", () => {
  for (const hash of ["#/", "#/review/one", "#/sessions", "#/missing", "#/tasks/t1"]) expect(resolveRoute(hash, false)).toEqual({ redirect: "#/setup" });
  expect(resolveRoute("#/review/one?repo=k&scope=all", false)).toEqual({ redirect: "#/setup?repo=k&scope=all" });
  expect(route("#/settings", false).name).toBe("settings");
  expect(route("#/settings/hosts", false).name).toBe("hosts");
  expect(route("#/settings/add-executor", false).name).toBe("add-executor");
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
