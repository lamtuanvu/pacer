import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {readMetered} from "../src/usage/metered";
import type {ProviderCfg} from "../src/config/strategy";
import {fakeCtx} from "./helpers";

const stats = readFileSync(join(import.meta.dir, "fixtures", "opencode-stats-cost.json"), "utf8");
const cfg = (o: Partial<ProviderCfg>): ProviderCfg => ({id: "opencode#openrouter", via: "opencode", model: "openrouter/z-ai/glm-5.3", usage: "metered", allowPaid: false, cooldownS: 0, quotaSource: null, weeklyTokens: null, weeklyUsd: null, ...o});
function ctx() {
  const argvs: string[][] = [];
  return {argvs, ctx: fakeCtx({run: async argv => { argvs.push(argv); return {code: 0, stdout: stats, stderr: ""}; }})};
}

test("a dollar cap paces on the model's cost across variants", async () => {
  const {ctx: c, argvs} = ctx();
  const r = await readMetered(c, cfg({weeklyUsd: 100}));
  expect(argvs[0]).toEqual(["opencode", "stats", "--models", "--cost", "--json", "--days", "7"]);
  expect(r.spendUsd).toBeCloseTo(46);
  expect(r.windows).toEqual([{name: "7d $", usedPct: expect.closeTo(46, 5), resetsAt: null, lengthS: 7 * 86400, paced: false}]);
});

test("no budget reports spend without a paced window", async () => {
  const r = await readMetered(ctx().ctx, cfg({}));
  expect(r.windows).toEqual([]);
  expect(r.spendUsd).toBeCloseTo(46);
  expect(r.error).toBeUndefined();
});

test("a token budget keeps today's token window and also reports spend", async () => {
  const r = await readMetered(ctx().ctx, cfg({weeklyTokens: 1265}));
  expect(r.windows[0]).toMatchObject({name: "7d", usedPct: 100});
  expect(r.spendUsd).toBeCloseTo(46);
});
