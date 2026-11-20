import { afterEach, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { list } from "../src/core/accounts";
import { loadStrategy } from "../src/config/strategy";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";

afterEach(cleanupUsageFixtures);

// account.list runs one usage computation for the whole listing (ADR 0030): every account
// row quotes computeStatus's reading and endpoint row instead of probing again. The
// plugin-backed reader makes each read observable, so one listing means one read per account.
test("account.list reads each account's usage once per listing", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    `planner: opencode#plan\naccounts:\n  plan: {kind: endpoint, usage: metered, quota_source: arkcli, model: public/code}\nrunners:\n  opencode#plan: {}\nrouting:\n  - default: [opencode#plan]\n`);
  loadStrategy(ctx);
  const usage = await import("../src/usage");
  const actual = usage.readAccountUsage;
  let reads = 0;
  mock.module("../src/usage", () => ({...usage, readAccountUsage: (async (...args: Parameters<typeof actual>) => {
    reads++;
    return actual(...args);
  }) as typeof actual}));
  try {
    const rows = await list(ctx);
    expect(reads).toBe(1);
    // The row's diagnostics quote the same reading the record was built from.
    const row = rows.find(a => a.name === "plan")!;
    expect(row.usageState).toBeDefined();
    expect(row.diagnostics.readings).toEqual([row.usageReading]);
  } finally { mock.restore(); }
});
