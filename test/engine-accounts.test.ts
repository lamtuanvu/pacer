import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { migrateStrategy } from "../src/config/migrate";
import { validateStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import type { UsageReading } from "../src/types";
import { fakeCtx, tmpDir } from "./helpers";

const strategy = (accountsMode = "spread", policy = "priority") => validateStrategy({
  accounts: { plan: { kind: "claude" }, a: { kind: "endpoint", usage: "metered", budget: { weekly_tokens: 1000 } }, b: { kind: "endpoint", usage: "metered", budget: { weekly_tokens: 1000 } } },
  planner: { agent: "claude-code", account: "plan" },
  runners: { a1: { agent: "opencode", account: "a", model: "api/one" }, a2: { agent: "opencode", account: "a", model: "api/two" }, b: { agent: "opencode", account: "b", model: "api/three" } },
  pacing: { policy, accounts: accountsMode, order: ["a1", "a2", "b"] },
}, "strategy.yaml");
const now = 1_800_000_000;
function reading(used: number, short = 0): UsageReading {
  return { windows: [
    { name: "weekly", usedPct: used, resetsAt: now + 84 * 3600, lengthS: 168 * 3600, paced: true },
    { name: "session", usedPct: short, resetsAt: now + 3600, lengthS: 5 * 3600, paced: false },
  ], capturedAt: now, stale: false };
}
const status = (s = strategy(), a = 40, b = 30, short = 0) => computeStatus(fakeCtx({ now }), s, {
  profile: null, readings: new Map([["plan", reading(45)], ["a", reading(a, short)], ["b", reading(b)]]),
});

test("runners share one account evaluation and usage increases lower both runners' headroom", async () => {
  const first = await status(); const second = await status(strategy(), 80);
  const [one, two] = first.providers;
  expect(one.account).toBe("a"); expect(two.account).toBe("a");
  expect(one.windows).toEqual(two.windows); expect(one.binding?.usedPct).toBe(40);
  expect(second.providers[0].binding?.usedPct).toBe(80);
  expect(second.providers[1].verdict).toBe("AHEAD");
  expect(first.accounts.find(a => a.name === "a")).toMatchObject({ kind: "endpoint", usedPct: 40, pacePct: 50, window: "weekly", stale: false, runners: ["a1", "a2"] });
});

const claudeStrategy = (accountsMode = "spread", policy = "priority") => validateStrategy({
  accounts: { plan: { kind: "codex" }, a: { kind: "claude" }, b: { kind: "claude" } },
  planner: { agent: "codex", account: "plan" },
  runners: { a1: { agent: "claude-code", account: "a" }, a2: { agent: "claude-code", account: "a" }, b: { agent: "claude-code", account: "b" } },
  pacing: { policy, accounts: accountsMode, order: ["a1", "a2", "b"] },
}, "strategy.yaml");

for (const policy of ["priority", "even"]) {
  test(`spread orders Claude accounts by headroom under ${policy}`, async () => {
    const result = await status(claudeStrategy("spread", policy));
    expect(result.executors.ranked.map(r => r.id)).toEqual(["b", "a1", "a2"]);
    expect(result.executors.ranked[0].account).toBe("b");
  });

  test(`fill orders Claude accounts by preference and yields on pace or threshold under ${policy}`, async () => {
    const s = claudeStrategy("fill", policy);
    expect((await status(s)).executors.ranked.map(r => r.id)).toEqual(["a1", "a2", "b"]);
    expect((await status(s, 70, 40)).executors.ranked[0].id).toBe("b");
    expect((await status(s, 40, 40, 90)).executors.ranked[0].id).toBe("b");
    // The literal BEHIND verdict yields even though the account has spare budget.
    expect((await status(s, 10, 40)).executors.ranked[0].id).toBe("b");
    s.pacing.order = ["b", "a1", "a2"];
    expect((await status(s, 40, 40)).executors.ranked[0].id).toBe("b");
  });
}

test("planner reserve and mode apply to its account even without a matching runner name", async () => {
  const s = validateStrategy({
    accounts: { work: { kind: "claude" }, personal: { kind: "claude" } },
    planner: { agent: "claude-code", account: "work" },
    runners: { shared: { agent: "claude-code", account: "work" }, other: { agent: "claude-code", account: "personal" } },
    pacing: { planner_reserve: 20 },
  }, "strategy.yaml");
  const result = await computeStatus(fakeCtx({ now }), s, { profile: null, readings: new Map([["work", reading(55)], ["personal", reading(55)]]) });
  expect(result.providers[0].binding?.pace).toBe(40);
  expect(result.providers[1].binding?.pace).toBe(50);
  expect(result.mode).toBe("strict");
  expect(result.executors.excluded).toContainEqual({ id: "shared", reason: "planner", account: "work" });
  expect(result.executors.ranked.map(r => r.id)).toEqual(["other"]);
});

const starter = `planner: claude-code
providers:
  claude-code: {usage: quota}
  codex: {usage: quota}
  cursor: {usage: reactive, model: auto, cooldown: 6h}
  agy: {usage: reactive}
  byteplus: {via: opencode, model: coding-plan/dola-seed-2.0-code, usage: quota, quota_source: arkcli}
  local: {via: opencode, model: ollama/qwen3, usage: unmetered}
pacing: {policy: priority, order: [codex, cursor, agy, opencode]}
routing:
  - kinds: [docs, tests]
    executors: [codex, local]
  - default: [codex, cursor, agy, byteplus, local]
`;
test("starter route JSON retains its pre-accounts output, including after migration", async () => {
  const ctx = fakeCtx({ now }); mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "strategy.yaml"); writeFileSync(path, starter);
  const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "account").map(([k, v]) => [k, strip(v)])) : value;
  const before = JSON.parse((await main(["route", "--json"], ctx)).out);
  expect(strip(before)).toMatchSnapshot();
  migrateStrategy(path);
  expect(JSON.parse((await main(["route", "--json"], ctx)).out)).toEqual(before);
});

test("migration inserts runners immediately after accounts without trailing whitespace", () => {
  const path = join(tmpDir(), "strategy.yaml"); writeFileSync(path, starter);
  migrateStrategy(path); const text = readFileSync(path, "utf8");
  expect(text.indexOf("runners:")).toBeLessThan(text.indexOf("pacing:"));
  expect(text.slice(text.indexOf("accounts:"), text.indexOf("runners:"))).not.toContain("pacing:");
  expect(text.split(/\r?\n/).some(line => /[ \t]+$/.test(line))).toBe(false);
});

test("live metered readings sum distinct models once per shared account", async () => {
  const s = strategy();
  const ctx = fakeCtx({ now, run: async argv => argv[0] === "opencode" ? { code: 0, stderr: "", stdout: JSON.stringify({ models: [
    { model: { providerID: "api", id: "one" }, tokens: { input: 100, output: 50 } },
    { model: { providerID: "api", id: "two" }, tokens: { input: 200, output: 50 } },
    { model: { providerID: "api", id: "three" }, tokens: { input: 50, output: 50 } },
  ] }) } : { code: 127, stdout: "", stderr: "missing" } });
  const result = await computeStatus(ctx, s, { profile: null });
  expect(result.providers[0].binding?.usedPct).toBe(40);
  expect(result.providers[1].binding?.usedPct).toBe(40);
  expect(result.providers[2].binding?.usedPct).toBe(10);
});

test("exhausting one runner exhausts every runner on its account", async () => {
  const { markExhausted } = await import("../src/usage/reactive");
  const ctx = fakeCtx({ now }); markExhausted(ctx, "a1", now + 3600);
  const result = await computeStatus(ctx, strategy(), { profile: null, readings: new Map([["a", reading(40)], ["b", reading(40)], ["plan", reading(40)]]) });
  expect(result.providers[0].verdict).toBe("EXHAUSTED");
  expect(result.providers[1].verdict).toBe("EXHAUSTED");
  expect(result.executors.ranked.map(r => r.id)).toEqual(["b"]);
});

for (const policy of ["priority", "even"]) {
  for (const accounts of ["spread", "fill"]) {
    test(`measured endpoint runners retain ${policy} ranking after migration with ${accounts}`, async () => {
      const path = join(tmpDir(), "strategy.yaml");
      writeFileSync(path, Bun.YAML.stringify({ planner: "claude-code", providers: {
        first: { via: "opencode", model: "api/a", usage: "metered", budget: { weekly_tokens: 1000 } },
        second: { via: "opencode", model: "api/b", usage: "metered", budget: { weekly_tokens: 1000 } },
      }, pacing: { policy, accounts, order: ["first", "second"] } }));
      const ctx = fakeCtx({ now });
      const inputs = { profile: null, readings: new Map([["first", reading(40)], ["second", reading(30)]]) };
      const before = await computeStatus(ctx, validateStrategy(Bun.YAML.parse(readFileSync(path, "utf8")), path), inputs);
      expect(before.executors.ranked.map(r => r.id)).toEqual(policy === "priority" ? ["first", "second"] : ["second", "first"]);
      migrateStrategy(path);
      const after = await computeStatus(ctx, validateStrategy(Bun.YAML.parse(readFileSync(path, "utf8")), path), inputs);
      expect(after.executors).toEqual(before.executors);
    });
  }
}

test("paid overflow is controlled by the shared account", async () => {
  const s = strategy(); s.accounts.a.allowPaid = true;
  const result = await status(s, 100, 40);
  expect(result.executors.ranked.map(r => r.id)).toContain("a1");
  expect(result.executors.ranked.map(r => r.id)).toContain("a2");
});
