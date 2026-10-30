import {discoveryFromFetch} from "./endpoint-discovery-fixtures";
import {expect, test} from "bun:test";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {accountCmd, type AccountDeps} from "../src/commands/accounts";
import {parseCatalog} from "../src/endpoints/catalog";
import {loadStrategy} from "../src/config/strategy";
import {fakeCtx} from "./helpers";

const noServers = async () => { throw Error("no local servers"); };
const providers = parseCatalog(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "models-dev-sample.json"), "utf8")));
function setup(signed: string[] = ["openrouter"]) {
  const state = {signed};
  const ctx = fakeCtx({run: async argv => argv.slice(0, 3).join(" ") === "opencode auth list" ? {code: 0, stdout: JSON.stringify(state.signed.map(id => ({id, name: id === "openrouter" ? "OpenRouter" : id, connections: []}))), stderr: ""} : {code: 1, stdout: "", stderr: ""}});
  mkdirSync(join(ctx.pacerHome, "cache"), {recursive: true});
  writeFileSync(join(ctx.pacerHome, "cache", "models.json"), JSON.stringify({fetchedAt: ctx.now, providers}));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  personal: {kind: claude}\nplanner: claude-code\nrouting:\n  - default: [claude-code]\n");
  return {ctx, state};
}
function script(answers: string[], extra: Partial<AccountDeps> = {}) {
  const questions: string[] = [], printed: string[] = [];
  const deps: AccountDeps = {prompt: async q => { questions.push(q); if (!answers.length) throw Error(`unexpected prompt: ${q}`); return answers.shift()!; },
    print: l => { printed.push(l); }, fetch: noServers, discover: discoveryFromFetch(noServers), ...extra};
  return {deps, questions, printed};
}

test("case A: provider, Enter for model, cap, name and test", async () => {
  const {ctx} = setup();
  const {deps, questions, printed} = script(["3", "1", "", "10", "", "n"]);
  const r = await accountCmd(["add"], ctx, deps);
  expect(r.code).toBe(0);
  expect(printed).toContain("  Already signed in to OpenCode");
  expect(questions).toContain("Model: qwen/qwen3-coder (tools, 262K context, $0.22/$0.95 per M)  [Enter to accept, / to search 1 others]");
  expect(questions).toContain("Weekly spend cap in $ (Enter for no cap)");
  expect(loadStrategy(ctx).accounts.openrouter).toMatchObject({source: "opencode", weeklyUsd: 10});
  expect(r.out).toContain("opencode#openrouter (openrouter/qwen/qwen3-coder) · cap $10/week");
});

test("an invalid cap asks again and keeps earlier answers", async () => {
  const {ctx} = setup();
  const {deps, printed} = script(["3", "1", "", "ten", "-1", "", "", "n"]);
  expect((await accountCmd(["add"], ctx, deps)).code).toBe(0);
  expect(printed.filter(l => l === "Enter a positive dollar amount, for example 10, or leave it blank.").length).toBe(2);
  expect(loadStrategy(ctx).accounts.openrouter.weeklyUsd).toBeNull();
});

test("case B: search, OpenCode stores the key, then the flow continues", async () => {
  const {ctx, state} = setup([]);
  const logins: string[][] = [];
  const {deps} = script(["3", "1", "volc", "1", "", "", "n"], {login: async (argv: string[]) => { logins.push(argv); state.signed = ["volcengine-coding-plan"]; return 0; }} as never);
  const r = await accountCmd(["add"], ctx, deps);
  expect(r.code).toBe(0);
  expect(logins).toEqual([["opencode", "auth", "login", "volcengine-coding-plan"]]);
  expect(loadStrategy(ctx).accounts["volcengine-coding-plan"]).toMatchObject({usage: "quota", quotaSource: "arkcli"});
});

test("a local server with one model says model, and no recommendation is explained", async () => {
  const {ctx} = setup([]);
  const local = (async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith("http://127.0.0.1:11434/")) return Response.json({data: [{id: "nomic-embed-text:latest"}]});
    throw Error("offline");
  }) as never;
  const {deps, printed, questions} = script(["3", "1", "llama3", "", "n"], {discover: discoveryFromFetch(local)});
  expect((await accountCmd(["add"], ctx, deps)).code).toBe(0);
  expect(printed.some(l => l.includes("Ollama (127.0.0.1:11434)   1 model · free"))).toBe(true);
  expect(printed).toContain("No model here can run an executor, so there is nothing to recommend. Enter a model id.");
  expect(questions).toContain("Model id");
});

test("a cancelled opencode auth login says so and shows the picker again, then a second try continues", async () => {
  const {ctx, state} = setup([]);
  let attempts = 0;
  const {deps, printed} = script(["3", "1", "volc", "1", "1", "volc", "1", "", "", "n"], {login: async () => {
    attempts++;
    if (attempts === 1) return 130;
    state.signed = ["volcengine-coding-plan"];
    return 0;
  }} as never);
  expect((await accountCmd(["add"], ctx, deps)).code).toBe(0);
  expect(attempts).toBe(2);
  expect(printed).toContain("OpenCode did not finish signing in to volcengine-coding-plan.");
  expect(printed.filter(l => l === "  Connect a provider (OpenCode stores the key)").length).toBe(2);
  expect(loadStrategy(ctx).accounts["volcengine-coding-plan"]).toMatchObject({source: "opencode"});
});
