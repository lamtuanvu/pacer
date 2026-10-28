import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import * as config from "../src/core/config";
import { fakeCtx } from "./helpers";

// Minimal valid legacy strategy: planner + providers block
function minimal(yamlExtra: string = "") {
  const raw = Bun.YAML.parse(`planner: claude-code\nproviders:\n  claude-code: {}\n${yamlExtra}`);
  return validateStrategy(raw, "strategy.yaml");
}

test("pacing defaults", () => {
  const s = minimal("");
  expect(s.pacing.plannerReserveHeadroom).toBe(25);
  expect(s.pacing.plannerProbe).toBe("ask");
});

test("planner_reserve stays a separate pace multiplier", () => {
  const s = minimal("pacing: {planner_reserve: 15, planner_reserve_headroom: 40}");
  expect(s.pacing.plannerReserve).toBe(15);
  expect(s.pacing.plannerReserveHeadroom).toBe(40);
});

test("rejects out-of-range headroom", () => {
  expect(() => minimal("pacing: {planner_reserve_headroom: 100}"))
    .toThrow(/planner_reserve_headroom must be between 0 and 99/);
});

test("rejects an unknown probe mode", () => {
  expect(() => minimal("pacing: {planner_probe: sometimes}"))
    .toThrow(/planner_probe must be ask, auto or off/);
});

// The config surface (config.get / config.set, the app and `pacer config`), not
// only the strategy parser above.
function configured() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nrouting: [{default: [claude-code]}]\n");
  return ctx;
}
async function rejection(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof Error ? e.message : String(e); }
  throw Error("expected config.set to reject");
}

test("both certification keys are allow-listed config keys", () => {
  expect(config.CONFIG_KEYS).toContain("pacing.planner_reserve_headroom");
  expect(config.CONFIG_KEYS).toContain("pacing.planner_probe");
});

test("config.get reads both keys with their defaults", () => {
  expect(config.get(configured()).keys).toMatchObject({
    "pacing.planner_reserve_headroom": { value: 25, source: "default" },
    "pacing.planner_probe": { value: "ask", source: "default" },
  });
});

test("config.set round-trips planner_reserve_headroom through config.get", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml");
  expect(await config.set(ctx, "pacing.planner_reserve_headroom", "40")).toMatchObject({
    key: "pacing.planner_reserve_headroom", previous: 25, value: 40,
    undo: "pacer config set pacing.planner_reserve_headroom 25",
  });
  expect(config.get(ctx).keys["pacing.planner_reserve_headroom"]).toEqual({ value: 40, source: path });
});

test("config.set round-trips planner_probe through config.get", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml");
  for (const mode of ["auto", "off", "ask"]) {
    expect(await config.set(ctx, "pacing.planner_probe", mode)).toMatchObject({ key: "pacing.planner_probe", value: mode });
    expect(config.get(ctx).keys["pacing.planner_probe"]).toEqual({ value: mode, source: path });
  }
});

test("config.set rejects an out-of-range headroom with the documented message and writes nothing", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml"), before = readFileSync(path, "utf8");
  for (const value of ["100", "250"]) {
    expect(await rejection(config.set(ctx, "pacing.planner_reserve_headroom", value)))
      .toContain("pacing.planner_reserve_headroom must be between 0 and 99");
  }
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("config.set rejects an unknown probe mode with the documented message and writes nothing", async () => {
  const ctx = configured(), path = join(ctx.pacerHome, "strategy.yaml"), before = readFileSync(path, "utf8");
  expect(await rejection(config.set(ctx, "pacing.planner_probe", "sometimes")))
    .toContain("pacing.planner_probe must be ask, auto or off");
  expect(readFileSync(path, "utf8")).toBe(before);
});
