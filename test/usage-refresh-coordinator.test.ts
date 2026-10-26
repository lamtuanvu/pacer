import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshAccountUsage } from "../src/usage/refresh";
import { readAccountUsage } from "../src/usage";
import { loadStrategy } from "../src/config/strategy";
import { fakeCtx } from "./helpers";
import type { RunFn } from "../src/types";

function setup(run: RunFn) {
  const ctx = fakeCtx({ now: 1_800_000_000, run });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\naccounts:\n  claude-code: {kind: claude}\n  codex: {kind: codex}\nrouting: [{default: [codex]}]\n");
  return ctx;
}

const response = (pct: number) => JSON.stringify({ id: 2, result: { rateLimits: {
  primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: 1_800_003_600 },
} } }) + "\n";

test("simultaneous idle refreshes of one account share one provider request", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ctx = setup(async () => { calls++; await gate; return { code: 0, stdout: response(23), stderr: "" }; });
  const first = refreshAccountUsage(ctx, "codex");
  const second = refreshAccountUsage(ctx, "codex");
  release();
  const results = await Promise.all([first, second]);
  expect(calls).toBe(1);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({ outcome: "updated", capturedAt: ctx.now, source: "provider-cli" });
});

test("failed active refresh keeps a previous measured reading historical", async () => {
  let fail = false;
  const ctx = setup(async () => fail
    ? { code: 1, stdout: "", stderr: "offline" }
    : { code: 0, stdout: response(46), stderr: "" });
  await refreshAccountUsage(ctx, "codex");
  fail = true;
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
  const ctx = fakeCtx({ now: 1_800_000_000, run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ items: [{
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

test("passive Claude refresh reports unchanged rather than making old data fresh", async () => {
  const ctx = setup(async () => { throw Error("no subprocess expected"); });
  const result = await refreshAccountUsage(ctx, "claude-code");
  expect(result).toMatchObject({ capability: "passive-log", outcome: "unchanged", capturedAt: null });
});
