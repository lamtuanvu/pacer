import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MissingStrategyError, StrategyError, loadStrategy, parseDuration, parseSize,
  strategyPath, useStrategy, validateStrategy,
} from "../src/config/strategy";
import { fakeCtx } from "./helpers";

const VALID = {
  planner: "claude-code",
  providers: {
    "claude-code": {},
    codex: { allow_paid: false },
    cursor: { cooldown: "6h" },
    byteplus: { via: "opencode", model: "coding-plan/dola-seed-2.0-code", usage: "quota", quota_source: "arkcli" },
    "opencode-go": { via: "opencode", model: "opencode-go/kimi-k2", usage: "metered", budget: { weekly_tokens: "20M" } },
    local: { via: "opencode", model: "lmstudio/qwen3.6-35b-a3b", usage: "unmetered" },
  },
  pacing: { policy: "even", planner_reserve: 15 },
  routing: [
    { kinds: ["tests", "docs"], executors: ["opencode#byteplus", "opencode#local"] },
    { default: ["opencode#byteplus", "codex"] },
  ],
};

test("parseSize and parseDuration", () => {
  expect(parseSize("20M")).toBe(20_000_000);
  expect(parseSize("1.5k")).toBe(1500);
  expect(parseSize(42)).toBe(42);
  expect(parseSize("lots")).toBeNull();
  expect(parseDuration("6h")).toBe(21600);
  expect(parseDuration("30m")).toBe(1800);
  expect(parseDuration("2d")).toBe(172800);
  expect(parseDuration("soon")).toBeNull();
});

test("a valid strategy normalizes defaults", () => {
  const s = validateStrategy(VALID, "/x.yaml");
  expect(s.planner.agent).toBe("claude-code");
  expect(s.providers["claude-code"].usage).toBe("quota");
  expect(s.providers.cursor.usage).toBe("reactive");
  expect(s.providers.cursor.cooldownS).toBe(21600);
  expect(s.providers.codex.allowPaid).toBe(false);
  expect(s.providers["opencode#opencode-go"].weeklyTokens).toBe(20_000_000);
  expect(s.providers["opencode#byteplus"].quotaSource).toBe("arkcli");
  expect(s.pacing).toEqual({ policy: "even", order: ["codex", "cursor", "opencode"], plannerReserve: 15, aheadThreshold: 10, behindThreshold: -10, accounts: "spread", fillThreshold: 90 });
  expect(s.routing).toEqual([
    { kinds: ["tests", "docs"], executors: ["opencode#byteplus", "opencode#local"] },
    { kinds: null, executors: ["opencode#byteplus", "codex"] },
  ]);
});

test("collects every problem in one error with the file path", () => {
  const bad = {
    planner: "gemini",
    providers: {
      cursor: { usage: "quota" },
      ollama: { model: "llama" },
      meter: { via: "opencode", model: "x/y", usage: "metered" },
    },
    pacing: { policy: "fastest" },
    routing: [{ kinds: ["tests", "dance"], executors: ["nobody"] }],
  };
  try {
    validateStrategy(bad, "/home/u/.pacer/strategy.yaml");
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(StrategyError);
    const err = e as StrategyError;
    expect(err.path).toBe("/home/u/.pacer/strategy.yaml");
    const all = err.problems.join("\n");
    expect(all).toContain('planner must be one of');
    expect(all).toContain("providers.cursor: quota usage is not available");
    expect(all).toContain("providers.ollama: non-native providers need via: opencode");
    expect(all).toContain("providers.meter: metered usage needs budget.weekly_tokens");
    expect(all).toContain('pacing.policy must be one of');
    expect(all).toContain('unknown kind "dance"');
    expect(all).toContain('unknown provider "nobody"');
    expect(err.message).toContain("/home/u/.pacer/strategy.yaml");
  }
});

test("routing defaults to all providers when omitted", () => {
  const s = validateStrategy({ planner: "codex", providers: { codex: {}, "claude-code": {} } }, "/x");
  expect(s.routing).toEqual([{ kinds: null, executors: ["codex", "claude-code"] }]);
});

test("loadStrategy reads ~/.pacer/strategy.yaml; YAML errors become StrategyError; missing file is MissingStrategyError", async () => {
  const ctx = fakeCtx();
  expect(() => loadStrategy(ctx)).toThrow(MissingStrategyError);
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders:\n  codex: {}\n");
  expect(loadStrategy(ctx).planner.agent).toBe("codex");
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: [unclosed\n");
  expect(() => loadStrategy(ctx)).toThrow(StrategyError);
});

test("useStrategy validates, switches the active strategy, and 'default' switches back", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders:\n  codex: {}\n");
  await Bun.write(join(ctx.pacerHome, "strategies", "offline.yaml"),
    "planner: opencode\nproviders:\n  local: { via: opencode, model: lmstudio/q, usage: unmetered }\n");
  expect(() => useStrategy(ctx, "nope")).toThrow(MissingStrategyError);
  useStrategy(ctx, "offline");
  expect(readFileSync(join(ctx.pacerHome, "active"), "utf8").trim()).toBe("offline");
  expect(strategyPath(ctx)).toBe(join(ctx.pacerHome, "strategies", "offline.yaml"));
  expect(loadStrategy(ctx)).toMatchObject({ name: "offline", planner: { agent: "opencode", account: "opencode" } });
  useStrategy(ctx, "default");
  expect(existsSync(join(ctx.pacerHome, "active"))).toBe(false);
  expect(loadStrategy(ctx).planner.agent).toBe("codex");
});

test("useStrategy replaces an active symlink without writing its target", () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  writeFileSync(join(ctx.pacerHome, "strategies/offline.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  const protectedFile = join(ctx.home, "protected.txt");
  writeFileSync(protectedFile, "keep this text");
  symlinkSync(protectedFile, join(ctx.pacerHome, "active"));
  chmodSync(ctx.pacerHome, 0o755);

  useStrategy(ctx, "offline");

  expect(readFileSync(protectedFile, "utf8")).toBe("keep this text");
  expect(readFileSync(join(ctx.pacerHome, "active"), "utf8")).toBe("offline\n");
  expect(lstatSync(join(ctx.pacerHome, "active")).isSymbolicLink()).toBe(false);
  expect(lstatSync(join(ctx.pacerHome, "active")).mode & 0o777).toBe(0o600);
  expect(lstatSync(ctx.pacerHome).mode & 0o777).toBe(0o700);
  expect(readdirSync(ctx.pacerHome).filter(name => name.startsWith("active.")).length).toBe(0);
});

test("examples/strategy.yaml is valid", async () => {
  const path = join(import.meta.dir, "..", "examples", "strategy.yaml");
  const s = validateStrategy(Bun.YAML.parse(await Bun.file(path).text()), path);
  expect(Object.keys(s.providers)).toEqual(["claude-code", "codex", "cursor", "agy", "opencode#byteplus", "opencode#local"]);
});

test("omitted pacing defaults to priority with only configured native preferences", () => {
  const s = validateStrategy({ planner: "claude-code", providers: { codex: {}, "claude-code": {} } }, "/x");
  expect(s.pacing.policy).toBe("priority");
  expect(s.pacing.order).toEqual(["codex"]);
});

test("explicit pacing order rejects unknown providers", () => {
  try {
    validateStrategy({ ...VALID, pacing: { order: ["codex", "gemini"] } }, "/x");
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(StrategyError);
    expect((e as StrategyError).problems).toContain('pacing.order: unknown provider "gemini"');
  }
});

test("pacing order must be a list", () => {
  expect(() => validateStrategy({ ...VALID, pacing: { order: "codex" } }, "/x"))
    .toThrow("pacing.order must be a list");
});

test("agy defaults to reactive usage and rejects quota usage", () => {
  const s = validateStrategy({ planner: "codex", providers: { agy: {} } }, "/x");
  expect(s.providers.agy.usage).toBe("reactive");
  expect(() => validateStrategy({ planner: "codex", providers: { agy: { usage: "quota" } } }, "/x"))
    .toThrow("providers.agy: quota usage is not available for agy; use reactive");
});

test("agy is not a planner", () => {
  expect(() => validateStrategy({ planner: "agy", providers: { agy: {} } }, "/x"))
    .toThrow("planner must be one of claude-code, codex, cursor, opencode");
});

test("explicit order accepts opencode without configured OpenCode providers for every policy", () => {
  for (const policy of ["priority", "even", "burn-before-reset", "cheapest-first"]) {
    const s = validateStrategy({
      planner: "claude-code", providers: { codex: {}, "claude-code": {} },
      pacing: { policy, order: ["opencode", "codex"] },
    }, "/x");
    expect(s.pacing.order).toEqual(["opencode", "codex"]);
  }
});
