import { afterEach as afterUsageFixture } from "bun:test";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
afterUsageFixture(cleanupUsageFixtures);
import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCodex } from "../src/usage/codex";
import { readMetered } from "../src/usage/metered";
import type { ProviderCfg } from "../src/config/strategy";
import type { Ctx, UsageReading } from "../src/types";


const at = 1791633600;
const event = (used: number, balance: string) => JSON.stringify({ timestamp: new Date(at * 1000).toISOString(),
  payload: { rate_limits: {
    primary: { used_percent: used, window_minutes: 10080, resets_in_seconds: 3600 },
    secondary: { used_percent: 7, window_minutes: 300, resets_at: at + 1200 },
    credits: { has_credits: true, balance },
  } },
});
const sample = (used: number, balance: number): UsageReading => ({
  windows: [
    { name: "weekly", usedPct: used, resetsAt: at + 3600, lengthS: 604800, paced: true },
    { name: "5h", usedPct: 7, resetsAt: at + 1200, lengthS: 18000, paced: false },
  ],
  capturedAt: at, stale: false, source: "session-log",
  spending: { creditsAvailable: true, creditBalance: balance, paidConsumption: "unknown" },
});

test("large Codex tails preserve complete rich conflict readings without readOnly persistence", async () => {
  const ctx = { ...fakeCtx({ now: at + 60 }), readOnly: true };
  const dir = join(ctx.home, ".codex", "sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "rollout-large.jsonl");
  // A whole-file capability limited to 4 MiB would lose these valid tail observations.
  await writeFile(path, JSON.stringify({ message: "é".repeat(2_100_000) }) + "\n"
    + event(25, "12.5") + "\n" + event(40, "8") + "\n" + event(99, "0"));
  expect((await stat(path)).size).toBeGreaterThan(4 * 1024 * 1024);
  const expected = { ...sample(40, 8), alternatives: [sample(25, 12.5)] };
  expect(await readCodex(ctx)).toEqual(expected);
  const state = join(ctx.pacerHome, "state", "codex-cursors.json");
  expect(await Bun.file(state).exists()).toBe(false);
  // A complete JSON object is still provisional until its JSONL delimiter arrives.
  await appendFile(path, "\n");
  expect(await readCodex(ctx)).toEqual({ ...sample(99, 0), alternatives: [sample(40, 8), sample(25, 12.5)] });
  expect(await Bun.file(state).exists()).toBe(false);
});

const cfg: ProviderCfg = { id: "opencode#paid", via: "opencode", model: "public/code", usage: "metered",
  allowPaid: false, cooldownS: 0, quotaSource: null, weeklyTokens: null, weeklyUsd: 100 };
const stats = { models: [{ model: { providerID: "public", id: "code" }, tokens: { input: 10 }, cost: 25 }] };
const metered = (stale = false, error?: string): UsageReading => ({ source: "metered",
  windows: [{ name: "7d $", usedPct: 25, resetsAt: null, lengthS: 604800, paced: false }],
  spendUsd: 25, capturedAt: at, stale, ...(error ? { error } : {}),
});

async function restartedMetered(ctx: Ctx, now: number, refresh: boolean) {
  const script = `import { readMetered } from ${JSON.stringify(new URL("../src/usage/metered.ts", import.meta.url).pathname)};
    const {fakeCtx,cleanupUsageFixtures}=await import(${JSON.stringify(new URL("./usage-plugin-fixtures.ts", import.meta.url).pathname)});
    const calls = [];
    const ctx = fakeCtx({ home: process.env.HOME, pacerHome: process.env.PACER_HOME, now: ${now}, env: {},
      readOnly: true, run: async argv => {
        calls.push(argv); return {code: 1, stdout: "", stderr: "synthetic offline"};
      } });
    try { console.log(JSON.stringify({reading: await readMetered(ctx, ${JSON.stringify(cfg)}, ${refresh}), calls})); } finally {await cleanupUsageFixtures();}`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(stdout);
}

test("metered disk cache survives restart without renewing failed-refresh observation times", async () => {
  const ctx = fakeCtx({ now: at, run: async () => ({ code: 0, stdout: JSON.stringify(stats), stderr: "" }) });
  expect(await readMetered(ctx, cfg)).toEqual(metered());
  const path = join(ctx.pacerHome, "cache", "opencode-stats-7d-cost.json");
  const persisted = await readFile(path, "utf8");
  expect(await restartedMetered(ctx, at + 299, false)).toEqual({ reading: metered(), calls: [] });
  const command = ["opencode", "stats", "--models", "--cost", "--json", "--days", "7"];
  const error = "opencode stats exited 1: synthetic offline";
  // Refresh bypasses a fresh hit; failed refresh preserves the old observation.
  expect(await restartedMetered(ctx, at + 1, true)).toEqual({ reading: metered(true, error), calls: [command] });
  expect(await restartedMetered(ctx, at + 300, false)).toEqual({ reading: metered(true, error), calls: [command] });
  expect(await restartedMetered(ctx, at + 6 * 3600, false)).toEqual({
    reading: { windows: [], capturedAt: null, stale: false, error }, calls: [command],
  });
  expect(await restartedMetered(ctx, at - 1, false)).toEqual({
    reading: { windows: [], capturedAt: null, stale: false, error }, calls: [command],
  });
  expect(await readFile(path, "utf8")).toBe(persisted);
});

test("successful readOnly metered fetch neither creates nor replaces a persistent cache", async () => {
  const ctx = { ...fakeCtx({ now: at,
    run: async () => ({ code: 0, stdout: JSON.stringify(stats), stderr: "" }) }), readOnly: true };
  const path = join(ctx.pacerHome, "cache", "opencode-stats-7d-cost.json");
  expect(await readMetered(ctx, cfg)).toEqual(metered());
  expect(await Bun.file(path).exists()).toBe(false);
  await readMetered({ ...ctx, readOnly: false }, cfg);
  const persisted = await readFile(path, "utf8");
  expect(await readMetered({ ...ctx, now: at + 301 }, cfg)).toEqual({ ...metered(), capturedAt: at + 301 });
  expect(await readFile(path, "utf8")).toBe(persisted);
});
