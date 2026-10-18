import { expect, test } from "bun:test";
import { resolveRoute, withQuery, type Route } from "../app/src/router";

const q = { repo: null, scope: null };
const route = (hash: string, setup: boolean | null = true, state?: (id: string) => "review" | "sessions" | null) => resolveRoute(hash, setup, state) as Route;

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

test("unknown or malformed routes are not found", () => {
  for (const hash of ["#/missing", "#/review/a/b", "#/sessions/%ZZ", "#/settings/nope"]) expect(route(hash).name).toBe("not-found");
});

test("the repo filter and scope come from the query and survive", () => {
  expect(route("#/?repo=github.com%2Facme%2Fapi")).toEqual({ name: "overview", query: { repo: "github.com/acme/api", scope: null } });
  expect(route("#/review/t1?scope=repo:github.com/acme/api").query).toEqual({ repo: null, scope: "repo:github.com/acme/api" });
  expect(withQuery("#/review/t1", { repo: "github.com/acme/api", scope: null })).toBe("#/review/t1?repo=github.com%2Facme%2Fapi");
  expect(withQuery("#/", q)).toBe("#/");
});

test("old routes redirect to their new homes and keep the repo filter", () => {
  const cases: [string, string][] = [
    ["#/tasks", "#/sessions"], ["#/executors", "#/settings/executors"], ["#/executors/add", "#/settings/add-executor"],
    ["#/accounts", "#/settings/accounts"], ["#/strategy", "#/settings/strategies"], ["#/hosts", "#/settings/hosts"], ["#/setup", "#/"],
  ];
  for (const [from, to] of cases) expect(resolveRoute(from)).toEqual({ redirect: to });
  expect(resolveRoute("#/accounts?repo=k")).toEqual({ redirect: "#/settings/accounts?repo=k" });
});

test("an old task link goes to Review when it is waiting for review, otherwise to Sessions", () => {
  const where = (id: string) => (id === "t1" ? "review" : "sessions") as "review" | "sessions";
  expect(resolveRoute("#/tasks/t1", true, where)).toEqual({ redirect: "#/review/t1" });
  expect(resolveRoute("#/tasks/t2", true, where)).toEqual({ redirect: "#/sessions/t2" });
});

test("an old task link waits for the snapshot before choosing", () => {
  expect(resolveRoute("#/tasks/t1", true, () => null)).toMatchObject({ name: "loading" });
  expect(resolveRoute("#/tasks/t1")).toEqual({ redirect: "#/sessions/t1" });
});

test("incomplete setup takes over every screen except settings", () => {
  for (const hash of ["#/", "#/review/one", "#/sessions", "#/missing"]) expect(route(hash, false).name).toBe("setup");
  expect(route("#/settings", false).name).toBe("settings");
  expect(route("#/settings/hosts", false).name).toBe("hosts");
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
