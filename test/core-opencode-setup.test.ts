import {expect, test} from "bun:test";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {loadStrategy} from "../src/config/strategy";
import {CoreError} from "../src/core/errors";
import {addOpencodeAccount, connectProvider, setupModels, suggestName} from "../src/core/opencode-setup";
import {parseCatalog} from "../src/endpoints/catalog";
import {testEndpoint} from "../src/endpoints/test-task";
import {fakeCtx} from "./helpers";

const catalog = {providers: parseCatalog(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "models-dev-sample.json"), "utf8"))), fetchedAt: 0, stale: false};
const authJson = (ids: string[]) => JSON.stringify(ids.map(id => ({id, name: id, connections: []})));
function setup(signed = ["openrouter"]) {
  const state = {signed};
  const ctx = fakeCtx({run: async argv => argv.slice(0, 3).join(" ") === "opencode auth list" ? {code: 0, stdout: authJson(state.signed), stderr: ""} : {code: 1, stdout: "", stderr: ""}});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  personal: {kind: claude}\nplanner: claude-code\nrouting:\n  - default: [claude-code]\n");
  const spawn = async (spec: {cwd: string; argv: string[]}) => { writeFileSync(join(spec.cwd, "hello.txt"), "ok"); return {code: 0, stdout: "", stderr: "", timedOut: false}; };
  return {ctx, state, spawn};
}

test("adds a provider account with no key, a runner and a routing entry, then tests it", async () => {
  const {ctx, spawn} = setup();
  const spawned: string[][] = [];
  const result = await addOpencodeAccount(ctx, {provider: "openrouter", model: "qwen/qwen3-coder", cap_usd: 10}, {catalog, spawn: async spec => { spawned.push(spec.argv); return spawn(spec); }});
  expect(result.state).toBe("ready");
  const yaml = readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8");
  expect(yaml).toContain("source: opencode");
  expect(yaml).toContain("weekly_usd: 10");
  const s = loadStrategy(ctx);
  expect(s.accounts.openrouter).toMatchObject({source: "opencode", provider: "openrouter", usage: "metered", weeklyUsd: 10});
  expect(s.runners["opencode#openrouter"].model).toBe("openrouter/qwen/qwen3-coder");
  expect(s.routing.at(-1)?.executors).toContain("opencode#openrouter");
  expect(spawned[0].join(" ")).toContain("openrouter/qwen/qwen3-coder");
});

test("refuses a provider OpenCode is not signed in to", async () => {
  const {ctx} = setup([]);
  await expect(addOpencodeAccount(ctx, {provider: "deepseek", model: "deepseek-chat", test: false}, {catalog})).rejects.toThrow("run opencode auth login deepseek");
});

// The only CoreError with a hint that addOpencodeAccount's callees can produce (applyEdit's
// "Check the strategy values and retry.") is unreachable here: addOpencodeAccount validates its
// own preview before calling edit(), so by the time edit() runs the change is already known-valid.
// So this instead confirms the catch no longer discards a nested CoreError's identity/code using
// the "already exists" path, which is reachable.
test("keeps the CoreError's identity and code when the account name already exists", async () => {
  const {ctx} = setup();
  await addOpencodeAccount(ctx, {provider: "openrouter", model: "qwen/qwen3-coder", name: "openrouter", test: false}, {catalog});
  let caught: unknown;
  try {
    await addOpencodeAccount(ctx, {provider: "openrouter", model: "z-ai/glm-5.3", name: "openrouter", test: false}, {catalog});
  } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(CoreError);
  expect((caught as CoreError).code).toBe("invalid_input");
});

test("suggestName avoids taken names", async () => {
  const {ctx} = setup();
  await addOpencodeAccount(ctx, {provider: "openrouter", model: "z-ai/glm-5.3", test: false}, {catalog});
  expect(suggestName(ctx, "openrouter")).toBe("openrouter-2");
  expect(suggestName(ctx, "Z.AI Coding")).toBe("z-ai-coding");
});

test("the test reports Key missing once the provider is signed out", async () => {
  const {ctx, state} = setup();
  await addOpencodeAccount(ctx, {provider: "openrouter", model: "z-ai/glm-5.3", test: false}, {catalog});
  state.signed = [];
  expect(await testEndpoint(ctx, "openrouter")).toEqual({state: "key_missing", detail: "Run opencode auth login openrouter"});
});

test("setupModels recommends from the catalog", async () => {
  const {ctx} = setup();
  const m = await setupModels(ctx, {provider: "openrouter", group: "signed_in"}, {catalog});
  expect(m).toMatchObject({filtered: "catalog", pick: {id: "qwen/qwen3-coder"}, usage: {usage: "metered"}});
  expect(m.rest.map(r => r.id)).toEqual(["z-ai/glm-5.3"]);
});

test("setupModels reports a note when OpenCode cannot list models", async () => {
  const {ctx} = setup();
  const m = await setupModels(ctx, {provider: "deepseek", group: "signed_in"}, {catalog});
  expect(m).toEqual({pick: null, rest: [], filtered: "ids", usage: m.usage, note: "OpenCode could not list models for deepseek; enter a model id."});
});

test("connectProvider reports success only when the provider then appears", async () => {
  const {ctx, state} = setup([]);
  expect(await connectProvider(ctx, "deepseek", {login: async () => 0})).toBe(false);
  expect(await connectProvider(ctx, "deepseek", {login: async argv => { expect(argv).toEqual(["opencode", "auth", "login", "deepseek"]); state.signed = ["deepseek"]; return 0; }})).toBe(true);
});

test("a dollar cap on a quota or unmetered account is refused instead of being dropped", async () => {
  const {ctx} = setup(["openrouter"]);
  await expect(addOpencodeAccount(ctx, {provider: "openrouter", model: "qwen/qwen3-coder", usage: "quota", cap_usd: 10, test: false}, {catalog}))
    .rejects.toThrow("A weekly dollar cap applies only to metered usage; openrouter is quota.");
  expect(loadStrategy(ctx).accounts.openrouter).toBeUndefined();
});

test("connectProvider refuses a provider id that is not a plain id before running anything", async () => {
  const {ctx} = setup([]);
  const ran: string[][] = [];
  for (const bad of ["--help", "a b", "x;rm", ""]) {
    await expect(connectProvider(ctx, bad, {login: async argv => { ran.push(argv); return 0; }})).rejects.toThrow("not a valid OpenCode provider id");
  }
  expect(ran).toEqual([]);
});

test("Coding Plan onboarding persists the ArkCLI source without catalog pricing", async () => {
  const {ctx} = setup(["coding-plan"]);
  const models = await setupModels(ctx, {provider: "coding-plan", group: "signed_in"}, {catalog: null});
  expect(models.usage).toEqual({usage: "quota", quota_source: "arkcli", known: true});
  await addOpencodeAccount(ctx, {provider: "coding-plan", model: "code", test: false}, {catalog: null});
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toContain("quota_source: arkcli");
  expect(loadStrategy(ctx).accounts["coding-plan"]).toMatchObject({usage: "quota", quotaSource: "arkcli", usageSource: "arkcli"});
});
