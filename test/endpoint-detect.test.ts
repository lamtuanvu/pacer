import {discoveryFromFetch} from "./endpoint-discovery-fixtures";
import {expect, test} from "bun:test";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {parseCatalog} from "../src/endpoints/catalog";
import {detectCandidates, opencodeModelIds, signedInProviders} from "../src/endpoints/detect";
import type {AccountCfg} from "../src/config/accounts";
import {fakeCtx} from "./helpers";

const providers = parseCatalog(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "models-dev-sample.json"), "utf8")));
const catalog = {providers, fetchedAt: 0, stale: false};
const authJson = JSON.stringify([{id: "openrouter", name: "OpenRouter", connections: [{type: "credential", method: "key", label: "OpenRouter", id: "cred_secretish"}]}]);
function ctxWith(run: Record<string, {code: number; stdout: string}>, which = true) {
  const calls: string[][] = [];
  const ctx = fakeCtx({which: () => which ? "/bin/opencode" : null, run: async argv => { calls.push(argv); return {...(run[argv.slice(0, 3).join(" ")] ?? {code: 1, stdout: ""}), stderr: ""}; }});
  return {ctx, calls};
}
const noServers = (async () => { throw Error("refused"); }) as unknown as typeof fetch;

test("signed-in providers come from auth list ids and names only", async () => {
  const {ctx, calls} = ctxWith({"opencode auth list": {code: 0, stdout: authJson}});
  expect(await signedInProviders(ctx)).toEqual([{id: "openrouter", name: "OpenRouter"}]);
  expect(calls[0]).toEqual(["opencode", "auth", "list", "--format", "json"]);
});

test("auth list failure is reported as unknown, not an error", async () => {
  const {ctx} = ctxWith({"opencode auth list": {code: 0, stdout: "garbage"}});
  expect(await signedInProviders(ctx)).toBeNull();
});

test("candidates group signed-in, config, catalog and local providers and mark added ones", async () => {
  const {ctx} = ctxWith({"opencode auth list": {code: 0, stdout: authJson}});
  mkdirSync(join(ctx.home, ".config", "opencode"), {recursive: true});
  writeFileSync(join(ctx.home, ".config", "opencode", "opencode.json"), JSON.stringify({provider: {terastor: {name: "TeraStor AI", options: {apiKey: "sk-never-read"}}}}));
  const ollama = (async (url: string) => url.includes(":11434") ? Response.json({data: [{id: "qwen3-coder:30b"}]}) : Promise.reject(Error("refused"))) as unknown as typeof fetch;
  const accounts = {openrouter: {name: "openrouter", kind: "endpoint", source: "opencode", provider: "openrouter"} as AccountCfg};
  const d = await detectCandidates(ctx, {discover: discoveryFromFetch(ollama), catalog, accounts});
  expect(d.candidates.map(c => [c.group, c.provider, c.added])).toEqual([
    ["signed_in", "openrouter", "openrouter"], ["signed_in", "terastor", null],
    ["local", "ollama", null],
    ["catalog", "volcengine-coding-plan", null],
  ]);
  expect(d.candidates.find(c => c.provider === "ollama")).toMatchObject({base_url: "http://127.0.0.1:11434/v1", models: 1, usage: {usage: "unmetered"}});
  expect(JSON.stringify(d)).not.toContain("sk-never-read");
  expect(JSON.stringify(d)).not.toContain("cred_secretish");
});

test("without opencode only local servers are offered", async () => {
  const {ctx, calls} = ctxWith({}, false);
  const d = await detectCandidates(ctx, {discover: discoveryFromFetch(noServers), catalog: null, accounts: {}});
  expect(d).toMatchObject({opencode: false, catalog: "offline", candidates: []});
  expect(d.notes[0]).toContain("Install OpenCode");
  expect(calls).toEqual([]);
});

test("opencode model ids are read for one provider", async () => {
  // The real CLI rejects a positional provider arg ("Unexpected positional argument"), so pacer
  // lists all models with `opencode models` and filters by the "<provider>/" prefix.
  const {ctx} = ctxWith({"opencode models": {code: 0, stdout: "openrouter/qwen/qwen3-coder\nopenrouter/z-ai/glm-5.3\nanthropic/claude-opus-4-5\n"}});
  expect(await opencodeModelIds(ctx, "openrouter")).toEqual(["qwen/qwen3-coder", "z-ai/glm-5.3"]);
});

test("failed opencode model listing returns null, not empty array", async () => {
  const {ctx} = ctxWith({"opencode models": {code: 1, stdout: ""}});
  expect(await opencodeModelIds(ctx, "openrouter")).toBeNull();
});

test("one failing local-server probe does not fail detection and keeps signed-in candidates (F3)", async () => {
  const {ctx} = ctxWith({"opencode auth list": {code: 0, stdout: authJson}});
  let calls = 0;
  const discover = (async (_ctx: unknown, input: {baseUrl: string}) => {
    calls++;
    if (calls === 1) throw Object.assign(Error("no enabled plugin provides OpenAI-compatible endpoints"), {code: "plugin_unavailable"});
    return {listed: true, models: [{id: "m"}]};
  }) as unknown as Parameters<typeof detectCandidates>[1]["discover"];
  const d = await detectCandidates(ctx, {discover, catalog: null, accounts: {}});
  expect(d.candidates.some(c => c.group === "signed_in" && c.provider === "openrouter")).toBe(true);
  expect(d.candidates.filter(c => c.group === "local")).toHaveLength(calls - 1);
  expect(d.notes).toContain("Could not check local model servers: no enabled plugin provides OpenAI-compatible endpoints");
});

test("detection with the endpoint plugin disabled still lists signed-in providers (F3)", async () => {
  const {ctx} = ctxWith({"opencode auth list": {code: 0, stdout: authJson}});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: "claude-code", providers: {"claude-code": {}}, plugins: {disabled: ["pacer-endpoints"]}}));
  const d = await detectCandidates(ctx, {catalog: null, accounts: {}});
  expect(d.candidates.map(c => c.group)).toEqual(["signed_in"]);
  expect(d.notes.some(n => n.startsWith("Could not check local model servers"))).toBe(true);
});
