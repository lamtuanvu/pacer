import { expect, test } from "bun:test";
import { resolveRoute } from "../app/src/router";

test("hash routes are bookmarkable, with specific routes before detail routes", () => {
  for (const name of ["home", "setup", "tasks", "executors", "accounts", "strategy", "hosts", "settings"] as const) {
    expect(resolveRoute(name === "home" ? "#/" : `#/${name}`).name).toBe(name);
  }
  expect(resolveRoute("#/executors/add")).toEqual({ name: "add-executor" });
  expect(resolveRoute("#/tasks/a%20b")).toEqual({ name: "task", id: "a b" });
  for (const hash of ["#/missing", "#/tasks/a/b", "#/tasks/%ZZ"]) expect(resolveRoute(hash).name).toBe("not-found");
});

test("incomplete setup takes over all routes except settings", () => {
  for (const hash of ["#/", "#/tasks/one", "#/executors/add", "#/missing"]) expect(resolveRoute(hash, false)).toEqual({ name: "setup" });
  expect(resolveRoute("#/settings", false)).toEqual({ name: "settings" });
});
