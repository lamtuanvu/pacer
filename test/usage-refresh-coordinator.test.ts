import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshAccountUsage } from "../src/usage/refresh";
import { readAccountUsage } from "../src/usage";
import { loadStrategy } from "../src/config/strategy";
import { fakeCtx as pluginFixtureCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";

afterEach(cleanupUsageFixtures);

function setup() {
  const ctx = pluginFixtureCtx({ now: 1_800_000_000, run: async () => { throw Error("host run bypass"); } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\naccounts:\n  claude-code: {kind: claude}\n  codex: {kind: codex}\nrouting: [{default: [codex]}]\n");
  return ctx;
}

function syntheticCodex(ctx: ReturnType<typeof setup>, pct: number) {
  const executable = join(ctx.home, "codex-refresh-fixture");
  const invocations = join(ctx.home, "codex-refresh-invocations");
  const failure = join(ctx.home, "codex-refresh-fail");
  const response = JSON.stringify({ id: 2, result: { rateLimits: {
    primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: 1_800_003_600 },
  } } }) + "\n";
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require("node:fs");\nfs.appendFileSync(${JSON.stringify(invocations)},"call\\n");\nlet input="",answered=false;\nprocess.stdin.on("data",part=>{input+=part;if(answered||!input.includes("account/rateLimits/read"))return;answered=true;if(fs.existsSync(${JSON.stringify(failure)})){process.stderr.write("offline");process.exit(1)}process.stdout.write(${JSON.stringify(response)})});\nprocess.stdin.on("end",()=>process.exit(0));\n`);
  chmodSync(executable, 0o700);
  const previous = ctx.which;
  ctx.which = name => name === "codex" ? executable : previous(name);
  return { invocations, failure };
}

test("simultaneous idle refreshes of one account share one provider request", async () => {
  const ctx = setup();
  const { invocations } = syntheticCodex(ctx, 23);
  const first = refreshAccountUsage(ctx, "codex");
  const second = refreshAccountUsage(ctx, "codex");
  const results = await Promise.all([first, second]);
  expect(readFileSync(invocations, "utf8").trim().split("\n")).toHaveLength(1);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({ outcome: "updated", capturedAt: ctx.now, source: "provider-cli" });
});

test("failed active refresh keeps a previous measured reading historical", async () => {
  const ctx = setup();
  const { failure } = syntheticCodex(ctx, 46);
  await refreshAccountUsage(ctx, "codex");
  writeFileSync(failure, "offline");
  ctx.now += 300;
  const result = await refreshAccountUsage(ctx, "codex");
  const strategy = loadStrategy(ctx);
  const reading = await readAccountUsage(ctx, strategy.accounts.codex, [strategy.runners.codex], false, true);
  expect(result).toMatchObject({ outcome: "failed", capturedAt: 1_800_000_000 });
  expect(reading.windows[0]?.usedPct).toBe(46);
  expect(reading.stale).toBe(true);
});

test("an Ark CLI sign-in failure replaces prior subscription availability", async () => {
  let expired = false;
  const ctx = pluginFixtureCtx({ now: 1_800_000_000, run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ items: [{
    product: "coding-plan", subscribed: !expired,
    ...(expired ? { error: "requires BytePlus Ark SSO STS, please run `arkcli auth login`" } : { periods: [{label:"weekly",percent:18}] }),
  }] }) }) });
  const account = { name: "coding-plan", kind: "endpoint", source: "opencode", usage: "quota", quotaSource: "arkcli" } as const;
  await readAccountUsage(ctx, account as never, []);
  expired = true;
  ctx.now += 300;
  const reading = await readAccountUsage(ctx, account as never, [], true);
  expect(reading.availability).toMatchObject({state:"unknown",reason:"authentication_failed"});
  expect(reading.windows).toEqual([]);
});

test("a malformed Ark CLI refresh retains measured windows as historical", async () => {
  let malformed = false;
  const ctx = pluginFixtureCtx({ now: 1_800_000_000, run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify(malformed ? {} : { items: [{
    product: "coding-plan", subscribed: true, periods: [{ label: "weekly", percent: 18 }],
  }] }) }) });
  const account = { name: "coding-plan", kind: "endpoint", source: "opencode", usage: "quota", quotaSource: "arkcli" } as const;
  await readAccountUsage(ctx, account as never, []);
  malformed = true;
  ctx.now += 300;
  const reading = await readAccountUsage(ctx, account as never, [], true);
  expect(reading.windows[0]?.usedPct).toBe(18);
  expect(reading.stale).toBe(true);
  expect(reading.availability).toMatchObject({ state: "unknown", reason: "subscription_response_invalid" });
  expect(reading.error).toBe("invalid coding-plan subscription response");
});

test("passive Claude refresh reports unchanged rather than making old data fresh", async () => {
  const ctx = setup();
  const result = await refreshAccountUsage(ctx, "claude-code");
  expect(result).toMatchObject({ capability: "passive-log", outcome: "unchanged", capturedAt: null });
});
