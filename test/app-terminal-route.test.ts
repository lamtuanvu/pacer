import { expect, test } from "bun:test";
import { hrefFor, parentFor, primaryFor, resolveRoute, routes, titleFor } from "../app/src/router";

test("Workspace has a stable route and keeps the repository scope", () => {
  const query = { repo: "repo-key", scope: null };
  expect(hrefFor(routes.terminal("tab-1"), query)).toBe("#/workspace?task=tab-1&repo=repo-key");
  const route = resolveRoute("#/workspace?task=tab-1&repo=repo-key", true);
  expect(route).toMatchObject({ name: "terminal", id: "tab-1", query });
  if ("redirect" in route) throw Error("Unexpected redirect");
  expect(titleFor(route)).toBe("Workspace");
  expect(primaryFor(route)).toBe("terminal");
  expect(parentFor(route)).toEqual(routes.terminal(query));
});
