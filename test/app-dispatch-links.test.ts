import { expect, test } from "bun:test";
import { resolveRoute } from "../app/src/router";

test("Dispatch legacy action paths redirect to the task page and preserve scope", () => {
  expect(resolveRoute("#/tasks/task%2Fone/failure?repo=repo&scope=all")).toEqual({redirect:"#/tasks/task%2Fone?repo=repo&scope=all"});
  expect(resolveRoute("#/tasks/task%2Fone/review?repo=repo&scope=all")).toEqual({redirect:"#/tasks/task%2Fone?repo=repo&scope=all"});
  expect(resolveRoute("#/tasks/task%2Fone/trace?repo=repo&scope=all")).toEqual({redirect:"#/tasks/task%2Fone?repo=repo&scope=all"});
  expect(resolveRoute("#/needs-you?answer=task%2Fone&repo=repo")).toEqual({ name: "review", query: { repo: "repo", scope: null } });
  expect(resolveRoute("#/tasks/%zz/trace")).toMatchObject({ name: "dispatch" });
  expect(resolveRoute("#/needs-you")).toMatchObject({ name: "review" });
});
