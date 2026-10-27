import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { defaultYaml, goldenPath, recordStrategySave } from "../scripts/golden/strategy-save";

test("strategy.save TypeScript byte, mode, event and refusal goldens remain fresh", async () => {
  expect(await recordStrategySave()).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
});

test("strategy.save retains the written file when activity append fails", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "state/activity.jsonl"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), defaultYaml);
  const target = join(ctx.pacerHome, "strategies/partial.yaml");
  await expect(callOp(ctx, "strategy.save", { name: "partial", draft: { from: "default" }, reason: "approved" })).rejects.toThrow(/EISDIR/);
  expect(existsSync(target)).toBe(true);
  expect(existsSync(join(ctx.pacerHome, "link/outbox.jsonl"))).toBe(false);
});

test("strategy.save rechecks the named target after waiting for the shared lock", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "orca"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), defaultYaml);
  const lock = join(ctx.pacerHome, "orca/strategy.lock");
  const target = join(ctx.pacerHome, "strategies/research.yaml");
  writeFileSync(lock, "held");
  const pending = callOp(ctx, "strategy.save", { name: "research", draft: { from: "default" }, reason: "approved" });
  try {
    await Bun.sleep(75);
    mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
    writeFileSync(target, "existing");
  } finally { rmSync(lock, { force: true }); }
  await expect(pending).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("already exists") });
  expect(readFileSync(target, "utf8")).toBe("existing");
});

test("strategy.save refuses an active overwrite selected while waiting for the lock", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "orca"), { recursive: true });
  mkdirSync(join(ctx.pacerHome, "strategies"));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), defaultYaml);
  const lock = join(ctx.pacerHome, "orca/strategy.lock"), target = join(ctx.pacerHome, "strategies/research.yaml");
  writeFileSync(target, defaultYaml); writeFileSync(lock, "held");
  const pending = callOp(ctx, "strategy.save", { name: "research", draft: { from: "default" }, reason: "approved", overwrite: true });
  try { await Bun.sleep(75); writeFileSync(join(ctx.pacerHome, "active"), "research\n"); }
  finally { rmSync(lock, { force: true }); }
  await expect(pending).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("activeOk") });
  expect(readFileSync(target, "utf8")).toBe(defaultYaml);
});

test("strategy.save overwrites through a completed replacement and removes its temporary link", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), defaultYaml);
  const target = join(ctx.pacerHome, "strategies/research.yaml");
  writeFileSync(target, "old bytes");
  const before = statSync(target).ino;
  await callOp(ctx, "strategy.save", { name: "research", draft: { from: "default" }, reason: "approved", overwrite: true });
  expect(statSync(target).ino).not.toBe(before);
  expect(readFileSync(target, "utf8")).toContain("# created by agent on ");
  expect(readdirSync(join(ctx.pacerHome, "strategies"))).toEqual(["research.yaml"]);
});
