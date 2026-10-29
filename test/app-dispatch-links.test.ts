import { expect, test } from "bun:test";
import { resolveRoute } from "../app/src/router";

test("Dispatch action paths reach the existing task workspace with their scope", () => {
  expect(resolveRoute("#/tasks/task%2Fone/failure?repo=repo&scope=all")).toEqual({ redirect: "#/tasks/task%2Fone?tab=work&repo=repo&scope=all" });
  for (const view of ["review", "trace"] as const) {
    expect(resolveRoute(`#/tasks/task%2Fone/${view}?repo=repo&scope=all`)).toEqual({ name: "sessions", id: "task/one", view, query: { repo: "repo", scope: "all" } });
  }
  expect(resolveRoute("#/needs-you?answer=task%2Fone&repo=repo")).toEqual({ redirect: "#/tasks/task%2Fone?repo=repo" });
  expect(resolveRoute("#/tasks/%zz/trace")).toMatchObject({ name: "dispatch" });
  expect(resolveRoute("#/needs-you")).toMatchObject({ name: "review" });
});
