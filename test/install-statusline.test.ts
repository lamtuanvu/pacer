import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureClaudeRateLimits, statusLine } from "../src/install/statusline";
import { fakeCtx } from "./helpers";

test("status line captures Claude limits before rendering the weekly ON_PACE budget", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), `
planner: claude-code
providers:
  claude-code: {usage: quota}
`);
  const rateLimits = {
    five_hour: { used_percentage: 12, resets_at: ctx.now + 3600 },
    seven_day: { used_percentage: 40, resets_at: ctx.now + 3 * 86400 },
  };

  const line = (await statusLine(ctx, JSON.stringify({ rate_limits: rateLimits })))
    .replace(/\x1b\[[0-9;]*m/g, "");

  expect(line).toContain("Claude 40% used");
  expect(line).toContain("✓ on pace");
  expect(await Bun.file(join(ctx.pacerHome, "cache", "claude-rate-limits.json")).json())
    .toEqual({ ...rateLimits, captured_at: ctx.now });
});

test("capture returns true and preserves all rate-limit fields with the current timestamp", async () => {
  const ctx = fakeCtx();
  const rateLimits = {
    seven_day: { used_percentage: 40 },
    seven_day_sonnet: { used_percentage: 5 },
    captured_at: 1,
  };
  expect(captureClaudeRateLimits(ctx, JSON.stringify({ rate_limits: rateLimits }))).toBe(true);
  expect(await Bun.file(join(ctx.pacerHome, "cache", "claude-rate-limits.json")).json())
    .toEqual({ ...rateLimits, captured_at: ctx.now });
});

test("capture ignores malformed input and absent or non-object weekly limits", () => {
  const ctx = fakeCtx();
  for (const stdin of ["not JSON", "null", "{}", '{"rate_limits":null}',
    '{"rate_limits":{"seven_day":null}}', '{"rate_limits":{"seven_day":[]}}',
    '{"rate_limits":{"seven_day":40}}']) {
    expect(captureClaudeRateLimits(ctx, stdin)).toBe(false);
  }
  expect(existsSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"))).toBe(false);
});

test("non-JSON stdin with no strategy returns the budget fallback without writing a cache", async () => {
  const ctx = fakeCtx();
  expect(await statusLine(ctx, "not JSON")).toContain("◆ Budget ? (no strategy found");
  expect(existsSync(join(ctx.pacerHome, "cache", "claude-rate-limits.json"))).toBe(false);
});

test("status line errors include only the first line of the message", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "strategy.yaml");
  await Bun.write(path, "planner: invalid\nproviders: {}\n");
  expect(await statusLine(ctx, "{}")).toBe(`◆ Budget ? (invalid strategy ${path}:)`);
});

test("cache-write failure preserves the rendered budget line", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), `
planner: claude-code
providers:
  claude-code: {usage: quota}
`);
  const expected = await statusLine(ctx, "{}");
  writeFileSync(join(ctx.pacerHome, "cache"), "blocks cache directory creation");
  const stdin = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 40 } } });
  expect(() => captureClaudeRateLimits(ctx, stdin)).toThrow();
  expect(await statusLine(ctx, stdin)).toBe(expected);
});
