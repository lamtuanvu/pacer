import { afterEach as afterUsageFixture } from "bun:test";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
afterUsageFixture(cleanupUsageFixtures);
import { expect, test } from "bun:test";
import { readAccountUsage } from "../src/usage/index";
import type { AccountCfg, RunnerCfg } from "../src/config/accounts";
import type { RunFn } from "../src/types";

const STATS = JSON.stringify({
  models: [
    { model: { id: "kimi-k2", providerID: "opencode-go" }, tokens: { input: 1_500_000, output: 400_000, reasoning: 100_000, cache: { read: 9_000_000, write: 0 } } },
    { model: { id: "other", providerID: "opencode-go" }, tokens: { input: 5_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  ],
});

const account = (over: Partial<AccountCfg> = {}): AccountCfg => ({
  name: "opencode-go", model: "opencode-go/kimi-k2", kind: "endpoint", source: "opencode", home: null, orcaAccount: null,
  usage: "metered", usageSource: "metered", quotaSource: null, provider: null, weeklyUsd: null, weeklyTokens: 20_000_000,
  cooldownS: 21600, allowPaid: false, ...over,
});
const runner = (model: string | null): RunnerCfg => ({ id: "opencode#go", name: "opencode#go", agent: "opencode", account: "opencode-go", host: null, model });

test("metered: counts input+output+reasoning for the configured model only, against the weekly budget", async () => {
  const run: RunFn = async (argv) => {
    expect(argv).toEqual(["opencode", "stats", "--models", "--cost", "--json", "--days", "7"]);
    return { code: 0, stdout: STATS, stderr: "" };
  };
  const r = await readAccountUsage(fakeCtx({ run }), account(), [runner("opencode-go/kimi-k2")]);
  expect(r.windows).toEqual([{ name: "7d", usedPct: 10, resetsAt: null, lengthS: 604800, paced: false }]);
});

test("unmetered and reactive have no windows; quota dispatches by provider", async () => {
  const ctx = fakeCtx();
  expect((await readAccountUsage(ctx, account({ usage: "unmetered", usageSource: "unmetered" }), [runner(null)])).windows).toEqual([]);
  expect((await readAccountUsage(ctx, account({ usage: "reactive", usageSource: "reactive" }), [runner("auto")])).windows).toEqual([]);
  expect(await readAccountUsage(ctx, { ...account({ kind: "claude", source: "default" }), name: "claude", usage: "quota", usageSource: "native", model: null, weeklyTokens: null }, [runner(null)])).toMatchObject({ error: expect.stringContaining("no Claude rate-limit data") });
});
