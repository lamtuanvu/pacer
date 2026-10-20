import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { migrateStrategy } from "../src/config/migrate";
import { validateStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import type { UsageReading } from "../src/types";
import { markExhausted } from "../src/usage/reactive";
import { fakeCtx, withLoginIndicators, tmpDir } from "./helpers";

const strategy = (accountsMode = "spread", policy = "priority") => validateStrategy({
  accounts: { plan: { kind: "claude" }, a: { kind: "endpoint", usage: "metered", budget: { weekly_tokens: 1000 } }, b: { kind: "endpoint", usage: "metered", budget: { weekly_tokens: 1000 } } },
  planner: { agent: "claude-code", account: "plan" },
  runners: { a1: { agent: "opencode", account: "a", model: "api/one" }, b: { agent: "opencode", account: "b", model: "api/three" } },
  pacing: { policy, accounts: accountsMode, order: ["opencode#a", "opencode#b"] },
}, "strategy.yaml");
const now = 1_800_000_000;
function reading(used: number, short = 0): UsageReading {
  return { windows: [
    { name: "weekly", usedPct: used, resetsAt: now + 84 * 3600, lengthS: 168 * 3600, paced: true },
    { name: "session", usedPct: short, resetsAt: now + 3600, lengthS: 5 * 3600, paced: false },
  ], capturedAt: now, stale: false };
}
const status = (s = strategy(), a = 40, b = 30, short = 0) => computeStatus(withLoginIndicators(fakeCtx({ now, env: { ANTHROPIC_API_KEY: "fixture" } })), s, {
  profile: null, readings: new Map([["plan", reading(45)], ["a", reading(a, short)], ["b", reading(b)]]),
});

test("runner aliases share one account identity and usage increases lower headroom", async () => {
  const first = await status(); const second = await status(strategy(), 80);
  const one = first.providers.find(p => p.id === "opencode#a")!;
  const two = second.providers.find(p => p.id === "opencode#a")!;
  expect(one.account).toBe("a"); expect(two.account).toBe("a");
  expect(one.binding?.usedPct).toBe(40); expect(two.binding?.usedPct).toBe(80);
  expect(second.providers.find(p => p.id === "opencode#a")!.binding?.usedPct).toBe(80);
  expect(second.providers.find(p => p.id === "opencode#a")!.verdict).toBe("AHEAD");
  expect(first.accounts.find(a => a.name === "a")).toMatchObject({ kind: "endpoint", usedPct: 40, pacePct: 50, window: "weekly", stale: false, runners: ["opencode#a"] });
});

const claudeStrategy = (accountsMode = "spread", policy = "priority") => validateStrategy({
  accounts: { plan: { kind: "codex" }, a: { kind: "claude", home: "~/.claude-a" }, b: { kind: "claude", home: "~/.claude-b" } },
  planner: { agent: "codex", account: "plan" },
  runners: { a1: { agent: "claude-code", account: "a" }, b: { agent: "claude-code", account: "b" } },
  pacing: { policy, accounts: accountsMode, order: ["claude-code#a", "claude-code#b"] },
}, "strategy.yaml");

for (const policy of ["priority", "even"]) {
  test(`spread orders Claude accounts by headroom under ${policy}`, async () => {
    const result = await status(claudeStrategy("spread", policy));
    expect(result.executors.ranked.map(r => r.id)).toEqual(["claude-code#b", "claude-code#a"]);
    expect(result.executors.ranked[0].account).toBe("b");
  });

  test(`fill orders Claude accounts by preference and yields on pace or threshold under ${policy}`, async () => {
    const s = claudeStrategy("fill", policy);
    expect((await status(s)).executors.ranked.map(r => r.id)).toEqual(["claude-code#a", "claude-code#b"]);
    expect((await status(s, 70, 40)).executors.ranked[0].id).toBe("claude-code#b");
    expect((await status(s, 40, 40, 90)).executors.ranked[0].id).toBe("claude-code#b");
    // The literal BEHIND verdict yields even though the account has spare budget.
    expect((await status(s, 10, 40)).executors.ranked[0].id).toBe("claude-code#b");
    s.pacing.order = ["claude-code#b", "claude-code#a"];
    expect((await status(s, 40, 40)).executors.ranked[0].id).toBe("claude-code#b");
  });
}

test("planner reserve and mode apply to its account even without a matching runner name", async () => {
  const s = validateStrategy({
    accounts: { work: { kind: "claude", home: "~/.claude-work" }, personal: { kind: "claude" } },
    planner: { agent: "claude-code", account: "work" },
    runners: { shared: { agent: "claude-code", account: "work" }, other: { agent: "claude-code", account: "personal" } },
    pacing: { planner_reserve: 20 },
  }, "strategy.yaml");
  const result = await computeStatus(withLoginIndicators(fakeCtx({ now, env: { ANTHROPIC_API_KEY: "fixture" } })), s, { profile: null, readings: new Map([["work", reading(55)], ["personal", reading(55)]]) });
  expect(result.providers[0].binding?.pace).toBe(40);
  expect(result.providers[1].binding?.pace).toBe(50);
  expect(result.mode).toBe("strict");
  expect(result.executors.excluded).toContainEqual(expect.objectContaining({ id: "claude-code#work", reason: "planner", account: "work" }));
  expect(result.executors.ranked.map(r => r.id)).toEqual(["claude-code"]);
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
test("starter route JSON exposes labelled fallbacks and remains stable through migration", async () => {
  const ctx = withLoginIndicators(fakeCtx({ now })); mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "strategy.yaml"); writeFileSync(path, starter);
  const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "account").map(([k, v]) => [k, strip(v)])) : value;
  const before = JSON.parse((await main(["route", "--json"], ctx)).out);
  const legacyIds = (value: unknown): unknown => typeof value === "string" && value.startsWith("opencode#") ? value.slice(9) : Array.isArray(value) ? value.map(legacyIds) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,legacyIds(v)])) : value;
  expect(legacyIds(strip(before))).toMatchSnapshot();
  migrateStrategy(path);
  expect(JSON.parse((await main(["route", "--json"], ctx)).out)).toEqual(before);
});

test("migration omits redundant runners without trailing whitespace", () => {
  const path = join(tmpDir(), "strategy.yaml"); writeFileSync(path, starter);
  migrateStrategy(path); const text = readFileSync(path, "utf8");
  expect(text).not.toContain("runners:");
  expect(text.split(/\r?\n/).some(line => /[ \t]+$/.test(line))).toBe(false);
});

test("live metered readings count the runner model once per account", async () => {
  const s = strategy();
  const ctx = fakeCtx({ now, run: async argv => argv[0] === "opencode" ? { code: 0, stderr: "", stdout: JSON.stringify({ models: [
    { model: { providerID: "api", id: "one" }, tokens: { input: 100, output: 50 } },
    { model: { providerID: "api", id: "two" }, tokens: { input: 200, output: 50 } },
    { model: { providerID: "api", id: "three" }, tokens: { input: 50, output: 50 } },
  ] }) } : { code: 127, stdout: "", stderr: "missing" } });
  const result = await computeStatus(ctx, s, { profile: null });
  expect(result.providers.find(p => p.id === "opencode#a")?.binding?.usedPct).toBe(15);
  expect(result.providers.find(p => p.id === "opencode#b")?.binding?.usedPct).toBe(10);
});

test("exhausting a runner exhausts its account", async () => {
  const { markExhausted } = await import("../src/usage/reactive");
  const ctx = fakeCtx({ now }); markExhausted(ctx, "opencode#a", now + 3600, {manual:true});
  const result = await computeStatus(ctx, strategy(), { profile: null, readings: new Map([["a", reading(40)], ["b", reading(40)], ["plan", reading(40)]]) });
  expect(result.providers.find(p => p.id === "opencode#a")?.verdict).toBe("EXHAUSTED");
  expect(result.executors.ranked.map(r => r.id)).toEqual(["opencode#b"]);
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
      expect(before.executors.ranked.map(r => r.id)).toEqual(policy === "priority" ? ["opencode#first", "opencode#second"] : ["opencode#second", "opencode#first"]);
      migrateStrategy(path);
      const after = await computeStatus(ctx, validateStrategy(Bun.YAML.parse(readFileSync(path, "utf8")), path), inputs);
      expect(after.executors).toEqual(before.executors);
    });
  }
}

test("paid overflow is controlled by the shared account", async () => {
  const s = strategy(); s.accounts.a.allowPaid = true;
  const result = await status(s, 100, 40);
  expect(result.executors.ranked.map(r => r.id)).toContain("opencode#a");
});

test("an expired exhausted short window leaves eligibility uncertain despite a fresh weekly window", async () => {
  const now = 2_000_000, ctx = fakeCtx({ now });
  const r: UsageReading = { windows: [
    { name: "weekly", usedPct: 40, resetsAt: now + 3 * 86400, lengthS: 7 * 86400, paced: true },
    { name: "5h", usedPct: 100, resetsAt: now + 3600, lengthS: 5 * 3600, paced: false },
  ], capturedAt: now - 3 * 3600, stale: false, source: "status-line" };
  const st = await computeStatus(ctx, strategy(), { profile: null, readings: new Map([["plan", r]]) });
  const acct = st.accounts.find(a => a.name === "plan")!;
  expect(acct.eligibility?.state).toBe("uncertain");
  expect(acct).toMatchObject({ source: "status-line", capturedAt: now - 3 * 3600, stale: true });
  const provider = st.providers.find(p => p.account === "plan")!;
  expect(provider.stale).toBe(true);
  expect(provider.eligibility?.state).toBe("uncertain");
  expect(provider.windows.map(w => [w.name, w.stale])).toEqual([["weekly", false], ["5h", true]]);
});

test("an expired exhausted weekly snapshot is historical and uncertain", async () => {
  const now = 2_000_000, ctx = fakeCtx({ now });
  const r: UsageReading = { windows: [
    { name: "weekly", usedPct: 99, resetsAt: now + 3 * 86400, lengthS: 7 * 86400, paced: true },
  ], capturedAt: now - 25 * 3600, stale: false, source: "session-log" };
  const st = await computeStatus(ctx, strategy(), { profile: null, readings: new Map([["plan", r]]) });
  expect(st.accounts.find(a => a.name === "plan")!).toMatchObject({ verdict: "UNKNOWN", stale: true, usedPct: 99 });
  expect(st.providers.find(p => p.account === "plan")!).toMatchObject({ verdict: "UNKNOWN", stale: true });
});

test("a limit mark beats staleness", async () => {
  const now = 2_000_000, ctx = fakeCtx({ now });
  markExhausted(ctx, "plan", now + 3600, {manual:true});
  const r: UsageReading = { windows: [
    { name: "weekly", usedPct: 10, resetsAt: now + 2 * 86400, lengthS: 7 * 86400, paced: true },
  ], capturedAt: now - 3 * 86400, stale: false, source: "session-log" };
  const st = await computeStatus(ctx, strategy(), { profile: null, readings: new Map([["plan", r]]) });
  expect(st.accounts.find(a => a.name === "plan")!.verdict).toBe("EXHAUSTED");
});

for (const usageSource of [undefined, "orca"] as const) {
  test(`Orca-linked native accounts read their own data with usage_source ${usageSource ?? "default"}`, async () => {
    const calls: string[][] = [];
    const ctx = fakeCtx({ now, run: async argv => {
      calls.push([...argv]);
      return { code: 0, stderr: "", stdout: JSON.stringify({ rateLimits: {} }) };
    } });
    ctx.env.PACER_ORCA_USER_DATA = join(ctx.home, "orca-data");
    const logs = join(ctx.env.PACER_ORCA_USER_DATA, "codex-accounts", "cx-team", "home", "sessions");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "rollout-test.jsonl"), JSON.stringify({
      rate_limits: { primary: { used_percent: 27, window_minutes: 10080, resets_at: now + 86400 } },
    }) + "\n");
    mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true });
    writeFileSync(join(ctx.pacerHome, "cache", "claude-rate-limits.work.json"), JSON.stringify({
      seven_day: { used_percentage: 42, resets_at: now + 86400 }, captured_at: now,
    }));
    const s = validateStrategy({
      accounts: {
        work: { kind: "claude", orca_account: "cl-team", usage_source: usageSource },
        team: { kind: "codex", orca_account: "cx-team", usage_source: usageSource },
      }, planner: "claude-code#work", routing: [{ default: ["codex#team"] }],
    }, "test");
    const st = await computeStatus(ctx, s, { profile: null });
    expect(st.accounts.find(a => a.name === "work")).toMatchObject({ source: "status-line", usedPct: 42 });
    expect(st.accounts.find(a => a.name === "team")).toMatchObject({ source: "session-log", usedPct: 27 });
    expect(calls).toEqual([]);
    expect(st.warnings).toEqual(usageSource ? [
      "account work: usage_source orca is no longer read; using native",
      "account team: usage_source orca is no longer read; using native",
    ] : undefined);
  });
}

test("reactive and metered accounts never query Orca for usage", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ now, run: async argv => {
    calls.push([...argv]);
    return { code: 0, stderr: "", stdout: JSON.stringify({ models: [
      { model: { providerID: "api", id: "one" }, tokens: { input: 100, output: 50 } },
    ] }) };
  } });
  const s = validateStrategy({
    accounts: {
      plan: { kind: "claude" }, cursor: { kind: "cursor" }, agy: { kind: "agy" },
      metered: { kind: "endpoint", model: "api/one", usage: "metered", budget: { weekly_tokens: 1000 } },
      legacy: { kind: "endpoint", model: "api/one", usage: "quota", usage_source: "orca" },
    }, planner: "claude-code", routing: [{ default: ["cursor", "agy", "opencode#metered", "opencode#legacy"] }],
  }, "test");
  const st = await computeStatus(ctx, s, { profile: null });
  for (const name of ["cursor", "agy", "legacy"]) {
    expect(st.accounts.find(a => a.name === name)).toMatchObject({ source: "reactive", usedPct: null });
  }
  expect(st.accounts.find(a => a.name === "metered")).toMatchObject({ source: "metered", usedPct: 15 });
  expect(calls.map(argv => argv[0])).toEqual(["opencode"]);
  expect(st.warnings).toEqual(["account legacy: usage_source orca is no longer read; using reactive"]);
});
