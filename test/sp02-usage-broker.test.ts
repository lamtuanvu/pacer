import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPluginUsage } from "../src/plugins/usage-broker";
import { shutdownPlugins } from "../src/plugins";
import type { ProviderCfg } from "../src/config/strategy";
import { fakeCtx } from "./helpers";
const cfg = (usage: ProviderCfg["usage"], id = "fixture"): ProviderCfg => ({ id, usage, via: null, model: null,
  weeklyTokens: null, weeklyUsd: null, quotaSource: null, allowPaid: false, cooldownS: 0 });

test("reactive and unmetered readings never start a plugin child", async () => {
  const ctx = fakeCtx({ now: 100 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  try {
    expect(await readPluginUsage(ctx, cfg("reactive"))).toEqual({ windows: [{ name: "limit", usedPct: 0, resetsAt: null, lengthS: 0, paced: false }], capturedAt: 100, stale: false, source: "reactive" });
    expect(await readPluginUsage(ctx, cfg("unmetered"))).toEqual({ windows: [], capturedAt: 100, stale: false, source: "unmetered" });
    const { pluginRegistry } = await import("../src/plugins");
    expect(pluginRegistry(ctx).list(ctx).every(plugin => plugin.pid === null)).toBe(true);
  } finally { await shutdownPlugins(ctx); }
});

test("actual bundled Claude reader receives only host-derived telemetry resources", async () => {
  const ctx = fakeCtx({ now: 100 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"), JSON.stringify({ captured_at: 90, seven_day: { used_percentage: 25, resets_at: 200 }, five_hour: { used_percentage: 4, resets_at: 110 } }));
  try {
    const result = await readPluginUsage(ctx, cfg("quota", "claude-code"));
    expect(result.capturedAt).toBe(90); expect(result.windows[0]?.usedPct).toBe(25);
  } finally { await shutdownPlugins(ctx); }
});

test("actual bundled Codex reader interprets bounded log ranges and persists reusable cursors", async () => {
  const ctx = fakeCtx({ now: 1000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const sessions = join(ctx.home, ".codex", "sessions"); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-fixture.jsonl"), JSON.stringify({ timestamp: new Date(900000).toISOString(), payload: { rate_limits: { primary: { used_percent: 25, window_minutes: 10080, resets_in_seconds: 3600 } } } }) + "\n");
  try {
    const first = await readPluginUsage(ctx, cfg("quota", "codex"));
    expect(first.source).toBe("session-log"); expect(first.windows[0]?.usedPct).toBe(25);
    const second = await readPluginUsage(ctx, cfg("quota", "codex"));
    expect(second).toEqual(first);
    expect(await Bun.file(join(ctx.pacerHome, "state", "codex-cursors.json")).exists()).toBe(true);
  } finally { await shutdownPlugins(ctx); }
});

test("actual bundled provider cache uses only the pinned synthetic executable and survives child restart", async () => {
  const ctx = fakeCtx({ now: 100 }); mkdirSync(ctx.pacerHome, { recursive: true });
  const executable = join(ctx.home, "owned-arkcli");
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({items:[{product:"coding-plan",subscribed:true,periods:[{label:"weekly",percent:25,reset_at:200}]}]}));\n`, { mode: 0o700 });
  ctx.which = () => executable;
  const provider = { ...cfg("quota"), quotaSource: "arkcli" as const };
  try {
    const first = await readPluginUsage(ctx, provider);
    expect(first.windows[0]?.usedPct).toBe(25); expect(first.capturedAt).toBe(100);
    await shutdownPlugins(ctx);
    ctx.which = () => null;
    expect(await readPluginUsage(ctx, provider)).toEqual(first);
  } finally { await shutdownPlugins(ctx); }
});

test("public usage dispatch reports a disabled contribution without falling back to a built-in reader", async () => {
  const { readUsage } = await import("../src/usage");
  const ctx = fakeCtx({ now: 100 }); mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  disabled: [pacer-usage]\n");
  writeFileSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"), JSON.stringify({ captured_at: 90, seven_day: { used_percentage: 25 } }));
  try { expect((await readUsage(ctx, cfg("quota", "claude-code"))).error).toContain("no enabled plugin reads claude-code usage"); }
  finally { await shutdownPlugins(ctx); }
});

test("readOnly passive telemetry does not require or create a pacer home directory", async () => {
  const ctx = { ...fakeCtx({ now: 100 }), readOnly: true };
  const dir = join(ctx.home, ".claude", "state", "budget"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "claude.json"), JSON.stringify({ captured_at: 90, seven_day: { used_percentage: 25 } }));
  try {
    expect((await readPluginUsage(ctx, cfg("quota", "claude-code"))).windows[0]?.usedPct).toBe(25);
    const { existsSync } = await import("node:fs"); expect(existsSync(ctx.pacerHome)).toBe(false);
  } finally { await shutdownPlugins(ctx); }
});

test("public Codex dispatch preserves >4MiB current-account state and a >1MiB rich result", async () => {
  const { statSync } = await import("node:fs"), { readUsage } = await import("../src/usage");
  const ctx = fakeCtx({ now: 1000 });
  const sessions = join(ctx.home, ".codex", "sessions"), state = join(ctx.pacerHome, "state");
  mkdirSync(sessions, { recursive: true }); mkdirSync(state, { recursive: true });
  const path = join(sessions, "rollout-large-state.jsonl"); writeFileSync(path, "{}\n");
  const info = statSync(path);
  const rateLimits = (balance: number) => ({ primary: { used_percent: 25, window_minutes: 10080, resets_at: 2000 },
    credits: { has_credits: true, balance: String(balance) }, retainedProviderField: "x".repeat(600) });
  const observation = { rateLimits: rateLimits(12.5), observedAt: 900,
    alternatives: Array.from({ length: 5000 }, (_, i) => ({ rateLimits: rateLimits(i), observedAt: 900 })) };
  const aggregate = { found: observation, last: observation, position: 0 };
  const snapshot = JSON.stringify({ version: 4, files: { [path]: { size: info.size, mtime: info.mtimeMs, inode: info.ino, offset: info.size, aggregate } } });
  expect(Buffer.byteLength(snapshot)).toBeGreaterThan(4 * 1024 * 1024);
  writeFileSync(join(state, "codex-cursors.json"), snapshot);
  try {
    const reading = await readUsage(ctx, cfg("quota", "codex"));
    expect(reading.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(reading))).toBeGreaterThan(1024 * 1024);
    expect(reading.alternatives).toHaveLength(5000);
    expect(reading.spending?.creditBalance).toBe(12.5);
    expect(reading.alternatives?.[4999]?.spending?.creditBalance).toBe(4999);
    expect(reading.capturedAt).toBe(900);
  } finally { await shutdownPlugins(ctx); }
});
