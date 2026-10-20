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
  const d = await detectCandidates(ctx, {fetch: ollama, catalog, accounts});
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
  const d = await detectCandidates(ctx, {fetch: noServers, catalog: null, accounts: {}});
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
