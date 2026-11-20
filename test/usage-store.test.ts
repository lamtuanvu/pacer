import { afterEach } from "bun:test";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
afterEach(cleanupUsageFixtures);
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAccountUsage, clearUsageMemo } from "../src/usage";
import { accountEvidenceScope } from "../src/core/evidence";
import { deleteUsageStore, writeUsageEntry } from "../src/usage/store";
import type { AccountCfg } from "../src/config/accounts";
import type { Ctx, UsageReading } from "../src/types";

const account = (over: Partial<AccountCfg> = {}): AccountCfg => ({
  name: "claude-code", model: null, kind: "claude", source: "default", home: null, orcaAccount: null,
  usage: "quota", usageSource: "native", quotaSource: null, provider: null, weeklyUsd: null, weeklyTokens: null,
  cooldownS: 21600, allowPaid: false, ...over,
});
const cache = (ctx: Ctx, pct: number) => {
  mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"),
    JSON.stringify({ captured_at: ctx.now, five_hour: { used_percentage: pct, resets_at: ctx.now + 3600 }, seven_day: { used_percentage: 10 } }));
};
const identity = (a: AccountCfg) => accountEvidenceScope(a, {}).identity;
const storePath = (ctx: Ctx, id: string) => join(ctx.pacerHome, "state", "usage", `${id}.json`);

test("a saved reading survives a cold process: cacheOnly reads the persisted store", async () => {
  const ctx = fakeCtx({ now: 1_800_000_000 });
  cache(ctx, 25);
  const fresh = await readAccountUsage(ctx, account(), []);
  expect(fresh.windows.map(w => w.usedPct)).toContain(25);
  clearUsageMemo(); // A second process has no in-process memo and no pending reads.
  const cold = await readAccountUsage({ ...ctx, now: ctx.now + 120 }, account(), [], false, true);
  expect(cold.windows.map(w => w.usedPct)).toEqual(expect.arrayContaining([25, 10]));
  expect(cold.capturedAt).toBe(1_800_000_000);
  expect(cold.stale).toBe(false);
  // Past the short-window cap the stored reading is correctly marked stale, not dropped.
  const aged = await readAccountUsage({ ...ctx, now: ctx.now + 3 * 3600 }, account(), [], false, true);
  expect(aged.stale).toBe(true);
  expect(aged.windows.map(w => w.usedPct)).toEqual(expect.arrayContaining([25, 10]));
});

test("the write rule: same shape and still fresh is not rewritten, a changed window is", async () => {
  const ctx = fakeCtx({ now: 1_800_000_000 });
  cache(ctx, 25);
  const id = identity(account()), path = storePath(ctx, id);
  await readAccountUsage(ctx, account(), []);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.pacerHome, "state", "usage")).mode & 0o777).toBe(0o700);
  const first = await Bun.file(path).json();
  // A fresh read with identical windows, error, availability and source writes nothing,
  // even though capturedAt moved.
  await readAccountUsage(ctx, account(), [], true);
  expect(await Bun.file(path).json()).toEqual(first);
  cache(ctx, 60);
  await readAccountUsage(ctx, account(), [], true);
  const changed = await Bun.file(path).json() as { schemaVersion: number; identity: string; entries: Record<string, { reading: { windows: { usedPct: number | null }[] } }> };
  expect(changed.entries["claude-code"].reading.windows.some(w => w.usedPct === 60)).toBe(true);
  expect(changed.schemaVersion).toBe(1);
  expect(changed.identity).toBe(id);
});

test("the store is keyed by the evidence identity: a removed account starts empty", async () => {
  const ctx = fakeCtx({ now: 1_800_000_000 });
  cache(ctx, 25);
  const a = account();
  await readAccountUsage(ctx, a, []);
  const id = identity(a);
  expect(existsSync(storePath(ctx, id))).toBe(true);
  deleteUsageStore(ctx, id);
  clearUsageMemo();
  expect(await readAccountUsage({ ...ctx, now: ctx.now + 10 }, a, [], false, true)).toEqual({ windows: [], capturedAt: null, stale: true });
  // A different identity (a recreated account with another home) never inherits the file.
  const reading: UsageReading = { windows: [{ name: "5h", usedPct: 25, resetsAt: ctx.now + 3600, lengthS: 18000, paced: false }], capturedAt: ctx.now, stale: false };
  writeUsageEntry(ctx, id, "claude-code", reading);
  const recreated = { ...a, source: "pacer" as const, home: join(ctx.home, ".claude-reborn") };
  expect(existsSync(storePath(ctx, identity(recreated)))).toBe(false);
  expect(await readAccountUsage(ctx, recreated, [], false, true)).toEqual({ windows: [], capturedAt: null, stale: true });
});

test("a failed refresh keeps the stored reading as the last good one across processes", async () => {
  const ctx = fakeCtx({ now: 1_800_000_000 });
  cache(ctx, 25);
  await readAccountUsage(ctx, account(), []);
  clearUsageMemo();
  rmSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"));
  const failed = await readAccountUsage(ctx, account(), [], true);
  expect(failed.error).toBeTruthy();
  expect(failed.windows.map(w => w.usedPct)).toEqual(expect.arrayContaining([25, 10]));
  expect(failed.stale).toBe(true);
  clearUsageMemo();
  const cold = await readAccountUsage({ ...ctx, now: ctx.now + 60 }, account(), [], false, true);
  expect(cold.error).toContain("no Claude rate-limit data");
  expect(cold.windows.map(w => w.usedPct)).toEqual(expect.arrayContaining([25, 10]));
});

test("a store that cannot be written never fails the reading", async () => {
  const ctx = fakeCtx({ now: 1_800_000_000 });
  cache(ctx, 40);
  clearUsageMemo();
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "state", "usage"), "not a directory");
  const reading = await readAccountUsage(ctx, account(), []);
  expect(reading.windows.map(w => w.usedPct)).toContain(40);
  expect(reading.error).toBeUndefined();
});
