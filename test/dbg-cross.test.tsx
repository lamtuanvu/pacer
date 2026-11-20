import { test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy, type Strategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { buildAccounts, buildExecutors, buildPlanner } from "../src/api/read-model/capacity";
import { list as accountsList } from "../src/core/accounts";
import { markExhausted } from "../src/usage/reactive";
import { fakeCtx, withLoginIndicators, localTs } from "./helpers";
import { cleanupUsageFixtures } from "./usage-plugin-fixtures";
import { usageView } from "../src/view-model/usage";
import type { Ctx } from "../src/types";

const now = localTs(2026, 11, 20, 10, 0);
test("debug rows for reactive limit", async () => {
  const ctx = withLoginIndicators(fakeCtx({now}));
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: cursor\naccounts:\n  cursor: {kind: cursor}\nrunners:\n  cursor: {}\nrouting:\n  - default: [cursor]\n");
  const s = loadStrategy(ctx);
  markExhausted(ctx, "cursor", now + 3600, {manual: true});
  const st = await computeStatus(ctx, s, {profile: null});
  const rows = buildAccounts(st, s, ctx);
  console.log("SNAPSHOT ROW", JSON.stringify(rows[0]!.usageState));
  const listRows = await accountsList(ctx);
  console.log("LIST ROW", JSON.stringify(listRows[0]!.usageState));
  console.log("VIEW", JSON.stringify(usageView(rows[0]!.usageState, ctx.now)));
});
