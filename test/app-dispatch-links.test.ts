import { expect, test } from "bun:test";
import { resolveRoute } from "../app/src/router";

test("Dispatch action paths reach the existing task workspace with their scope", () => {
  for (const [view, tab] of [["failure", "work"], ["review", "changes"], ["trace", "work"]]) {
    expect(resolveRoute(`#/tasks/task%2Fone/${view}?repo=repo&scope=all`)).toEqual({ redirect: `#/tasks/task%2Fone?tab=${tab}&repo=repo&scope=all` });
  }
  expect(resolveRoute("#/needs-you?answer=task%2Fone&repo=repo")).toEqual({ redirect: "#/tasks/task%2Fone?repo=repo" });
  expect(resolveRoute("#/tasks/%zz/trace")).toMatchObject({ name: "dispatch" });
  expect(resolveRoute("#/needs-you")).toMatchObject({ name: "review" });
});
