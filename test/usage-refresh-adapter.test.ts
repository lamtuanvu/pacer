import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { readAccountUsage, usageRefreshCapability } from "../src/usage";
import type { AccountCfg } from "../src/config/accounts";
import { fakeCtx } from "./helpers";
import { fakeCtx as pluginFixtureCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
import { shutdownPlugins } from "../src/plugins";

afterEach(cleanupUsageFixtures);

function syntheticCodex(ctx: ReturnType<typeof pluginFixtureCtx>, usedPercent: number) {
  const executable = join(ctx.home, "codex-live-fixture"), receipt = join(ctx.home, "codex-live-request.json");
  writeFileSync(executable, `#!${process.execPath}\nlet input="";process.stdin.on("data",part=>{input+=part;if(input.includes("account/rateLimits/read")){process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:${usedPercent},windowDurationMins:300,resetsAt:1800003600},secondary:{usedPercent:62,windowDurationMins:10080,resetsAt:1800086400}}}})+"\\n")}});process.stdin.on("end",()=>{require("node:fs").writeFileSync(${JSON.stringify(receipt)},JSON.stringify({home:process.env.CODEX_HOME,input,proxy:process.env.HTTPS_PROXY,noProxy:process.env.NO_PROXY,ca:process.env.SSL_CERT_FILE,private:process.env.PRIVATE_TOKEN}));process.exit(0)});\n`);
  chmodSync(executable, 0o700);
  const previous = ctx.which;
  ctx.which = name => name === "codex" ? executable : previous(name);
  return receipt;
}

test("idle Codex refresh reads account limits through its CLI without a turn", async () => {
  const ctx = pluginFixtureCtx({ now: 1_800_000_000, run: async () => { throw Error("host run bypass"); } });
  ctx.env.HTTPS_PROXY="http://proxy";ctx.env.NO_PROXY="localhost";ctx.env.SSL_CERT_FILE="/tmp/ca";ctx.env.PRIVATE_TOKEN="hidden";
  const receipt = syntheticCodex(ctx, 24);
  const home = join(ctx.home, "work-codex");
  const strategy = validateStrategy({ planner: "claude-code", accounts: { "claude-code": { kind: "claude" }, work: { kind: "codex", home } }, routing: [{ default: ["codex#work"] }] }, "/strategy");
  const reading = await readAccountUsage(ctx, strategy.accounts.work, [], true);
  expect(reading.windows.map(w => [w.name, w.usedPct])).toEqual([["5h", 24], ["weekly", 62]]);
  expect(reading.capturedAt).toBe(ctx.now);
  const request = JSON.parse(readFileSync(receipt, "utf8"));
  expect(request.input).toContain("account/rateLimits/read");
  expect(request.home).toBe(home);
  expect(request).toMatchObject({proxy:"http://proxy",noProxy:"localhost",ca:"/tmp/ca"});
  expect(request.private).toBeUndefined();
  expect(usageRefreshCapability(strategy.accounts.work)).toBe("provider-command");
});

test("idle Claude refresh remains passive and does not spawn an agent", async () => {
  let calls = 0;
  const ctx = fakeCtx({ run: async () => { calls++; return { code: 0, stdout: "", stderr: "" }; } });
  const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {} } }, "/strategy");
  const reading = await readAccountUsage(ctx, strategy.accounts["claude-code"], [], true);
  expect(reading.capturedAt).toBeNull();
  expect(calls).toBe(0);
  expect(usageRefreshCapability(strategy.accounts["claude-code"])).toBe("passive-log");
});

test("active refresh waits for a passive read, then makes its own provider request", async () => {
  let finishFirst!: (value: { code: number; stdout: string; stderr: string }) => void;
  const first = new Promise<{ code: number; stdout: string; stderr: string }>(resolve => { finishFirst = resolve; });
  let signalFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { signalFirst = resolve; });
  let calls = 0;
  const response = { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
  const ctx = pluginFixtureCtx({ run: async () => {
    if (++calls === 1) { signalFirst(); return first; }
    return response;
  } });
  const account = { name: "plan", kind: "endpoint", source: "endpoint", usage: "quota", quotaSource: "arkcli" } as AccountCfg;
  const passive = readAccountUsage(ctx, account, []);
  await firstStarted;
  const active = readAccountUsage(ctx, account, [], true);
  finishFirst(response);
  await Promise.all([passive, active]);
  expect(calls).toBe(2);
}, 15_000);

test("an older passive Codex log cannot replace a newer provider reading after cache expiry", async () => {
  const ctx = pluginFixtureCtx({ now: 1_800_000_000 });
  syntheticCodex(ctx, 40);
  const account = { name: "work", kind: "codex", source: "default", usage: "quota" } as AccountCfg;
  const sessions = join(ctx.home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  const log = join(sessions, "rollout-refresh.jsonl");
  writeFileSync(log, JSON.stringify({ timestamp: new Date((ctx.now - 300) * 1000).toISOString(),
    payload: { rate_limits: { primary: { used_percent: 20, window_minutes: 10080 } } } }) + "\n");
  try {
    await readAccountUsage(ctx, account, [], true);
    ctx.now += 61;
    const later = await readAccountUsage(ctx, account, []);
    expect(later.windows[0]?.usedPct).toBe(40);
    expect(later.source).toBe("provider-cli");
    expect(later.stale).toBe(false);
    writeFileSync(log, JSON.stringify({ timestamp: new Date((ctx.now - 100) * 1000).toISOString(),
      payload: { rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } } } }) + "\n");
    ctx.now += 61;
    const newest = await readAccountUsage(ctx, account, []);
    expect(newest.windows[0]?.usedPct).toBe(40);
    expect(newest.stale).toBe(false);
  } finally { await shutdownPlugins(ctx); }
});
