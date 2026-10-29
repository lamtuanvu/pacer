// OpenCode provider accounts through status, ranking and the read model.
import {expect, test} from "bun:test";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {loadStrategy} from "../src/config/strategy";
import {computeStatus} from "../src/engine/status";
import {buildAccounts} from "../src/api/read-model/capacity";
import {rankExecutors} from "../src/engine/rank";
import {writeEndpointState} from "../src/endpoints/state";
import {fakeCtx} from "./helpers";
import {accountUsageFreshness} from "../src/view-model/capacity";
import {accountEvidenceScope, recordExecutionEvidence} from "../src/core/evidence";

const stats = readFileSync(join(import.meta.dir, "fixtures", "opencode-stats-cost.json"), "utf8");
function setup(budget?: {weekly_usd: number}) {
  const ctx = fakeCtx({run: async argv => argv[0] === "opencode" && argv[1] === "stats" ? {code: 0, stdout: stats, stderr: ""}
    : argv.slice(0, 3).join(" ") === "opencode auth list" ? {code: 0, stdout: JSON.stringify([{id: "openrouter", name: "OpenRouter", connections: []}]), stderr: ""}
    : {code: 1, stdout: "", stderr: ""}});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
    planner: "codex",
    accounts: {codex: {kind: "codex"}, openrouter: {kind: "endpoint", source: "opencode", provider: "openrouter", usage: "metered", ...(budget ? {budget} : {})}},
    runners: {codex: {}, "opencode#openrouter": {model: "openrouter/z-ai/glm-5.3"}},
    routing: [{default: ["opencode#openrouter", "codex"]}],
  }));
  writeEndpointState(ctx, "openrouter", {state: "ready"});
  return ctx;
}

test("an uncapped OpenCode provider has a known verdict, so routing does not rank it as unknown", async () => {
  const ctx = setup();
  const s = loadStrategy(ctx), st = await computeStatus(ctx, s);
  const p = st.providers.find(p => p.id === "opencode#openrouter")!;
  expect(p.verdict).toBe("OK");
  expect(p.eligibility).toMatchObject({state: "eligible", budget: "not_required", availability: "ready"});
  const {ranked} = rankExecutors(null, s, Object.fromEntries(st.providers.map(p => [p.id, p])));
  expect(ranked.map(r => r.id)[0]).toBe("opencode#openrouter");
});

test("changing a cap uses the current policy while preserving authentication restrictions", async () => {
  const ctx = setup({weekly_usd: 10}), s = loadStrategy(ctx);
  const account = s.accounts.openrouter!;
  account.weeklyUsd = null; account.weeklyTokens = 100;
  expect((await computeStatus(ctx, s)).providers[1]!.eligibility?.state).toBe("ineligible");
  account.weeklyTokens = null; account.weeklyUsd = 100;
  expect((await computeStatus(ctx, s)).providers[1]!.eligibility).toMatchObject({state: "eligible", budget: "permitted"});
  account.weeklyUsd = 10;
  expect((await computeStatus(ctx, s)).providers[1]!.eligibility?.state).toBe("ineligible");
  account.weeklyUsd = null;
  expect((await computeStatus(ctx, s)).providers[1]!.eligibility).toMatchObject({state: "eligible", budget: "not_required"});
  await recordExecutionEvidence(ctx, accountEvidenceScope(account), {
    endedAt: ctx.now, exitCode: 1, timedOut: false, classification: "authentication",
  });
  account.weeklyUsd = 100;
  expect((await computeStatus(ctx, s)).providers[1]!.eligibility?.state).toBe("ineligible");
});

test("switching OpenCode provider cannot reuse the previous provider's evidence", async () => {
  const ctx = setup({weekly_usd: 10}), s = loadStrategy(ctx);
  await computeStatus(ctx, s);
  s.accounts.openrouter!.provider = "other";
  s.runners["opencode#openrouter"]!.model = "other/new";
  const st = await computeStatus(ctx, s, {readings: new Map([["openrouter", {
    windows: [], capturedAt: null, stale: true, error: "unavailable",
  }]])});
  expect(st.providers[1]!.eligibility?.state).toBe("uncertain");
  expect(st.accounts[1]!.usedPct).toBeNull();
});

test("a newer healthy current cap recovers an execution quota failure despite obsolete exhausted history", async () => {
  const ctx = setup({weekly_usd: 10}), s = loadStrategy(ctx), account = s.accounts.openrouter!;
  await computeStatus(ctx, s);
  ctx.now += 10;
  await recordExecutionEvidence(ctx, accountEvidenceScope(account), {
    endedAt: ctx.now, exitCode: 1, timedOut: false, classification: "quota",
  });
  ctx.now += 10;
  account.weeklyUsd = 100;
  const st = await computeStatus(ctx, s, {refreshAccounts: ["openrouter"]});
  expect(st.providers[1]!.eligibility).toMatchObject({state: "eligible", budget: "permitted"});
});

test("failed refresh of uncapped spend retains its historical label and observation age", async () => {
  const ctx = setup(), s = loadStrategy(ctx);
  await computeStatus(ctx, s);
  ctx.now += 120;
  ctx.run = async () => ({code: 1, stdout: "", stderr: "offline"});
  const st = await computeStatus(ctx, s, {refreshAccounts: ["openrouter"], cacheOnly: false});
  const row = buildAccounts(st, s, ctx).find(a => a.name === "openrouter")!;
  expect(row.spendUsdWeek).toBe(46);
  expect(row.stale).toBe(true);
  expect(accountUsageFreshness(row)).toBe("Reading 2m old");
  expect(accountUsageFreshness({...row, eligibility: undefined, capturedAt: null})).toContain("Stale reading · refresh to use");
  expect(st.providers[1]!.eligibility?.state).toBe("uncertain");
});

test("account spending sums distinct models without counting duplicate runners twice", async () => {
  const ctx = setup({weekly_usd: 200}), s = loadStrategy(ctx);
  s.runners.other = {...s.runners["opencode#openrouter"]!, name: "other", model: "openrouter/anthropic/claude-sonnet-5.5"};
  s.runners.duplicate = {...s.runners.other, name: "duplicate"};
  const st = await computeStatus(ctx, s);
  expect(st.accounts[1]!.spendUsd).toBeCloseTo(133.37);
  expect(st.accounts[1]!.usedPct).toBeCloseTo(66.685);
});

test("spend and a dollar cap reach the read model", async () => {
  const ctx = setup({weekly_usd: 100});
  const s = loadStrategy(ctx), st = await computeStatus(ctx, s);
  const a = buildAccounts(st, s, ctx).find(a => a.name === "openrouter")!;
  expect(a.spendUsdWeek).toBeCloseTo(46);
  expect(a.capUsdWeek).toBe(100);
  expect(a.usedPct).toBeCloseTo(46, 0);
});

test("cached status keeps Key missing for an OpenCode provider account", async () => {
  const ctx = setup();
  writeEndpointState(ctx, "openrouter", {state: "key_missing", detail: "run opencode auth login openrouter"});
  const st = await computeStatus(ctx, loadStrategy(ctx), {cacheOnly: true});
  expect(st.providers.find(p => p.id === "opencode#openrouter")?.unavailableReason ?? "").toContain("Key missing");
});

test("account list shows the week's spend and cap for an OpenCode provider", async () => {
  const ctx = setup({weekly_usd: 100});
  const {accountCmd} = await import("../src/commands/accounts");
  const out = (await accountCmd(["list"], ctx, {})).out;
  expect(out).toMatch(/\$4\d\.\d\d of \$100 this week/);
});
