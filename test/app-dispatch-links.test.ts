import { expect, test } from "bun:test";
import { resolveRoute } from "../app/src/router";

test("Dispatch action paths reach the dedicated result pages and trace with their scope", () => {
  expect(resolveRoute("#/tasks/task%2Fone/failure?repo=repo&scope=all")).toEqual({ name: "task-failure", id: "task/one", query: { repo: "repo", scope: "all" } });
  expect(resolveRoute("#/tasks/task%2Fone/review?repo=repo&scope=all")).toEqual({ name: "task-review", id: "task/one", query: { repo: "repo", scope: "all" } });
  expect(resolveRoute("#/tasks/task%2Fone/trace?repo=repo&scope=all")).toEqual({ name: "sessions", id: "task/one", view: "trace", query: { repo: "repo", scope: "all" } });
  expect(resolveRoute("#/needs-you?answer=task%2Fone&repo=repo")).toEqual({ name: "review", query: { repo: "repo", scope: null } });
  expect(resolveRoute("#/tasks/%zz/trace")).toMatchObject({ name: "dispatch" });
  expect(resolveRoute("#/needs-you")).toMatchObject({ name: "review" });
});
