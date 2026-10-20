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
  const {ranked} = rankExecutors(null, s, Object.fromEntries(st.providers.map(p => [p.id, p])));
  expect(ranked.map(r => r.id)[0]).toBe("opencode#openrouter");
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
