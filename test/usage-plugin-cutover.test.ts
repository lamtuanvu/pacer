import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readClaude } from "../src/usage/claude";
import { readCodex } from "../src/usage/codex";
import { readByteplus } from "../src/usage/byteplus";
import { readMetered } from "../src/usage/metered";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
afterEach(cleanupUsageFixtures);
test("all compatibility readers require enabled plugin contribution and have no host fallback", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  disabled: [pacer-usage]\n");
  const cfg = { id: "fixture", usage: "metered" as const, via: null, model: "public/code", weeklyUsd: 100, weeklyTokens: null, quotaSource: null, allowPaid: false, cooldownS: 0 };
  for (const read of [() => readClaude(ctx), () => readCodex(ctx), () => readByteplus(ctx), () => readMetered(ctx, cfg)]) {
    expect((await read()).error).toContain("no enabled plugin reads");
  }
});
