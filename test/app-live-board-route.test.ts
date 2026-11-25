/** The Live board family's routes: #/live, #/live/<run>, #/live/<run>/journey. */
import { expect, test } from "bun:test";
import { hrefFor, parentFor, primaryFor, resolveRoute, routes, titleFor, type Route } from "../app/src/router";
import { liveHref, runViewHref, sessionHref } from "../app/src/screens/runs/live-links";

const q = { repo: null, scope: null };
const route = (hash: string) => resolveRoute(hash) as Route;

test("hashes resolve to the several-runs board, a run's Live board and its journey", () => {
  expect(route("#/live")).toEqual({ name: "live", query: q });
  expect(route("#/live/run_1")).toEqual({ name: "live", id: "run_1", query: q });
  expect(route("#/live/run_1/journey")).toEqual({ name: "live", id: "run_1", view: "journey", query: q });
  expect(route("#/live/run%2F1?repo=r")).toEqual({ name: "live", id: "run/1", query: { repo: "r", scope: null } });
});

test("an undecodable id or an extra path segment does not open a board", () => {
  expect(route("#/live/%E0%A4%A").name).toBe("dispatch");
  expect(route("#/live/run_1/journey/extra").name).not.toBe("live");
  expect(route("#/live/run_1/other").name).not.toBe("live");
});

test("the existing Runs routes are untouched", () => {
  expect(route("#/runs")).toEqual({ name: "runs", query: q });
  expect(route("#/runs/live")).toEqual({ name: "runs", id: "live", query: q });
});

test("links built by the router and by the screens agree", () => {
  for (const [id, view] of [[undefined, undefined], ["run_1", undefined], ["run_1", "journey"], ["run/1", "journey"]] as const) {
    expect(hrefFor(routes.live(id, view))).toBe(liveHref(id, view, q));
  }
  expect(hrefFor(routes.live("run_1", undefined, { repo: "r" }))).toBe(liveHref("run_1", undefined, { repo: "r", scope: null }));
  // a journey needs a run; without one the view is dropped
  expect(routes.live(undefined, "journey")).toEqual({ name: "live" });
  expect(runViewHref("run_1", q)).toBe(hrefFor(routes.runs("run_1")));
  expect(sessionHref("t_1", q)).toBe("#/workspace?task=t_1&panel=session");
});

test("titles, parents and the highlighted rail entry", () => {
  expect(titleFor(route("#/live"))).toBe("Several runs");
  expect(titleFor(route("#/live/run_1"))).toBe("Live board");
  expect(titleFor(route("#/live/run_1/journey"))).toBe("Journey replay");
  expect(parentFor(route("#/live/run_1/journey"))).toEqual({ name: "live", id: "run_1", query: q });
  expect(parentFor(route("#/live/run_1"))).toEqual({ name: "live", query: q });
  expect(parentFor(route("#/live"))).toMatchObject({ name: "runs" });
  for (const hash of ["#/live", "#/live/run_1", "#/live/run_1/journey"]) expect(primaryFor(route(hash))).toBe("runs");
});
