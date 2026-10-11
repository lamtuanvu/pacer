import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { readUsage } from "../src/usage/index";
import { markExhausted } from "../src/usage/reactive";
import type { RunFn } from "../src/types";
import { fakeCtx } from "./helpers";

const STATS = JSON.stringify({
  models: [
    { model: { id: "kimi-k2", providerID: "opencode-go" }, tokens: { input: 1_500_000, output: 400_000, reasoning: 100_000, cache: { read: 9_000_000, write: 0 } } },
    { model: { id: "other", providerID: "opencode-go" }, tokens: { input: 5_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  ],
});

const strategy = validateStrategy({
  planner: "claude-code",
  providers: {
    "claude-code": {},
    cursor: {},
    "opencode-go": { via: "opencode", model: "opencode-go/kimi-k2", usage: "metered", budget: { weekly_tokens: "20M" } },
    local: { via: "opencode", model: "lmstudio/q", usage: "unmetered" },
  },
}, "/x");

test("metered: counts input+output+reasoning for the configured model only, against the weekly budget", async () => {
  const run: RunFn = async (argv) => {
    expect(argv).toEqual(["opencode", "stats", "--models", "--json", "--days", "7"]);
    return { code: 0, stdout: STATS, stderr: "" };
  };
  const r = await readUsage(fakeCtx({ run }), strategy.providers["opencode-go"]);
  expect(r.windows).toEqual([{ name: "7d", usedPct: 10, resetsAt: null, lengthS: 604800, paced: false }]);
});

test("unmetered has no windows; reactive has an OK limit window; quota dispatches by provider", async () => {
  const ctx = fakeCtx();
  expect((await readUsage(ctx, strategy.providers.local)).windows).toEqual([]);
  expect((await readUsage(ctx, strategy.providers.cursor)).windows).toEqual([
    { name: "limit", usedPct: 0, resetsAt: null, lengthS: 0, paced: false },
  ]);
  expect((await readUsage(ctx, strategy.providers["claude-code"])).error).toContain("no Claude rate-limit data");
});

test("an active exhausted mark overrides any provider's limit window", async () => {
  const ctx = fakeCtx({ now: 1000 });
  markExhausted(ctx, "cursor", 5000);
  markExhausted(ctx, "local", 5000);
  expect((await readUsage(ctx, strategy.providers.cursor)).windows).toEqual([
    { name: "limit", usedPct: 100, resetsAt: 5000, lengthS: 4000, paced: false },
  ]);
  expect((await readUsage(ctx, strategy.providers.local)).windows[0].usedPct).toBe(100);
});
