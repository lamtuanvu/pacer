import { expect, test } from "bun:test";
import { parentFor, resolveRoute, routes, setupCompleteFrom, type Route } from "./router";

const q = { repo: null, scope: null };
const route = (hash: string, setup: boolean | null = true) => resolveRoute(hash, setup) as Route;

test("bare workspace and terminal hashes redirect to Tasks", () => {
  expect(resolveRoute("#/workspace")).toEqual({ redirect: "#/tasks" });
  expect(resolveRoute("#/workspace?repo=acme&scope=all")).toEqual({ redirect: "#/tasks?repo=acme&scope=all" });
  expect(resolveRoute("#/terminal")).toEqual({ redirect: "#/tasks" });
  expect(resolveRoute("#/workspace?task=one&panel=notes")).toMatchObject({ name: "terminal", id: "one", panel: "notes" });
  expect(parentFor(route("#/workspace?task=one&repo=acme"))).toEqual(routes.tasks({ repo: "acme", scope: null }));
});

test("onboarded keeps Insights when complete regresses; first run still gates Setup", () => {
  expect(setupCompleteFrom({ complete: false, onboarded: true })).toBe(true);
  expect(setupCompleteFrom({ complete: false })).toBe(false);
  expect(resolveRoute("#/insights", setupCompleteFrom({ complete: false, onboarded: true }))).toEqual({ name: "insights", query: q });
  expect(resolveRoute("#/insights", setupCompleteFrom({ complete: false }))).toEqual({ redirect: "#/setup" });
  expect(resolveRoute("#/insights", false, true)).toEqual({ redirect: "#/setup" });
});
