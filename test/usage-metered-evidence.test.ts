import { afterEach as afterUsageFixture } from "bun:test";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
afterUsageFixture(cleanupUsageFixtures);
import { expect, test } from "bun:test";
import { readAccountUsage } from "../src/usage";
import { validateStrategy } from "../src/config/strategy";


test("malformed metered statistics never become zero measured spend", async () => {
  const strategy = validateStrategy({ planner: "claude-code", providers: {
    paid: { via: "opencode", model: "api/code", usage: "metered", budget: { weekly_tokens: 10000 } },
  } }, "/x");
  for (const response of [{}, { models: [{ model: { providerID: "api", id: "code" }, tokens: null }] }]) {
    const ctx = fakeCtx({ run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify(response) }) });
    const reading = await readAccountUsage(ctx, strategy.accounts.paid, Object.values(strategy.runners).filter(r => r.account === "paid"), true);
    expect(reading.error).toBeDefined();
    expect(reading.windows.every(w => w.usedPct === null)).toBe(true);
  }
});
