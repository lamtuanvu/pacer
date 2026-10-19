import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { fakeCtx, withLoginIndicators } from "./helpers";

function setup() {
  const ctx = withLoginIndicators(fakeCtx()); ctx.env.PACER_API = "inprocess";
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\n");
  return ctx;
}
test("CLI list/show/set/remove uses API policies and prints ordered identities", async () => {
  const ctx = setup();
  const set = await main(["project", "strategy", "set", "--repo", ctx.home, "--executors", "cursor,codex", "--json"], ctx);
  expect(set.code).toBe(0); expect(JSON.parse(set.out)).toMatchObject({ rev: 1, executors: ["cursor#cursor@local", "codex#codex@local"] });
  expect((await main(["project", "strategy", "show", "--repo", ctx.home], ctx)).out).toContain("1. cursor#cursor@local");
  expect(JSON.parse((await main(["project", "strategy", "list", "--json"], ctx)).out)).toHaveLength(1);
  expect((await main(["project", "strategy", "remove", "--repo", ctx.home], ctx)).out).toContain("global strategy");
});
test("CLI rejects unknown/duplicate/empty executors and missing values", async () => {
  const ctx = setup();
  for (const ids of ["missing", "codex,codex#codex@local", ""]) expect((await main(["project", "strategy", "set", "--repo", ctx.home, "--executors", ids], ctx)).code).toBe(2);
  expect((await main(["project", "strategy", "show", "--repo"], ctx)).code).toBe(2);
});
test("route --repo explains the override; bare route has no project metadata", async () => {
  const ctx = setup();
  await main(["project", "strategy", "set", "--repo", ctx.home, "--executors", "cursor"], ctx);
  const route = await main(["route", "--repo", ctx.home, "--json"], ctx);
  expect(route.code).toBe(0); expect(JSON.parse(route.out).policy).toMatchObject({ source: "project", rev: 1 });
  expect((await main(["route", "--repo", ctx.home], ctx)).out).toContain("Project order");
  expect(JSON.parse((await main(["route", "--json"], ctx)).out)).not.toHaveProperty("policy");
});

test("CLI reports a racing edit without retrying the mutation", async () => {
  const { projectStrategyCmd } = await import("../src/commands/project-strategy");
  const { ApiError } = await import("../src/api/client-types");
  const calls: string[] = []; let closed = false;
  const result = await projectStrategyCmd(["strategy", "set", "--repo", "/repo with spaces", "--executors", "codex#team@worker"], setup(), async () => ({
    kind: "inprocess", hello: async () => ({protocol:"3",pacer:"0",ops:[],events:[]}), snapshot: async () => { throw Error("unused"); }, subscribe: () => () => {}, close: () => { closed = true; },
    call: async <T,>(op: string) => { calls.push(op); if (op.endsWith("get")) return {repo:{key:"github.com/acme/repo",label:"repo"},rev:2,executors:null,available:[]} as T; throw new ApiError("conflict", "Project strategy changed", "Reload before retrying"); },
  }));
  expect(result.code).toBe(2); expect(result.err).toContain("Reload before retrying");
  expect(calls).toEqual(["project.strategy.get", "project.strategy.set"]); expect(closed).toBe(true);
});
