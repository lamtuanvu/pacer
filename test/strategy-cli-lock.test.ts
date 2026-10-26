import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

const yaml = "planner: codex\naccounts: {personal: {kind: codex}}\nrouting: [{default: [codex]}]\n";

test("direct CLI save and API save both wait for the same strategy lock", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "orca"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), yaml);
  const lock = join(ctx.pacerHome, "orca/strategy.lock"), target = join(ctx.pacerHome, "strategies/shared.yaml");
  writeFileSync(lock, "held");
  const cli = main(["strategy", "save", "shared", "--reason", "CLI approved"], ctx);
  const api = callOp(ctx, "strategy.save", { name: "shared", draft: { from: "default" }, reason: "API approved" });
  try { await Bun.sleep(75); expect(existsSync(target)).toBe(false); }
  finally { rmSync(lock, { force: true }); }
  const results = await Promise.allSettled([cli, api]);
  const cliOk = results[0].status === "fulfilled" && results[0].value.code === 0;
  const apiOk = results[1].status === "fulfilled";
  expect(Number(cliOk) + Number(apiOk)).toBe(1);
  expect(readFileSync(target, "utf8")).toMatch(/created by (user|agent) on/);
});

test("direct CLI save keeps its JSON output and user header", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), yaml);
  const result = await main(["strategy", "save", "new-plan", "--reason", "approved"], ctx);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ name: "new-plan", active: false });
  expect(readFileSync(join(ctx.pacerHome, "strategies/new-plan.yaml"), "utf8")).toContain("# created by user on ");
});

test("direct CLI use waits for the strategy lock before switching active", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "orca"), { recursive: true });
  mkdirSync(join(ctx.pacerHome, "strategies"));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), yaml);
  writeFileSync(join(ctx.pacerHome, "strategies/research.yaml"), yaml);
  const lock = join(ctx.pacerHome, "orca/strategy.lock"), active = join(ctx.pacerHome, "active");
  writeFileSync(lock, "held");
  const pending = main(["strategy", "use", "research"], ctx);
  try { await Bun.sleep(75); expect(existsSync(active)).toBe(false); }
  finally { rmSync(lock, { force: true }); }
  const result = await pending;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ name: "research" });
  expect(readFileSync(active, "utf8")).toBe("research\n");
});

test("direct CLI rm waits for the strategy lock before deleting a named file", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "orca"), { recursive: true });
  mkdirSync(join(ctx.pacerHome, "strategies"));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), yaml);
  const target = join(ctx.pacerHome, "strategies/research.yaml"), lock = join(ctx.pacerHome, "orca/strategy.lock");
  writeFileSync(target, yaml); writeFileSync(lock, "held");
  const pending = main(["strategy", "rm", "research"], ctx);
  try { await Bun.sleep(75); expect(existsSync(target)).toBe(true); }
  finally { rmSync(lock, { force: true }); }
  const result = await pending;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ name: "research", deleted: true });
  expect(existsSync(target)).toBe(false);
});
