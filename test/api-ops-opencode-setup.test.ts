import {discoveryFromFetch} from "./endpoint-discovery-fixtures";
import {expect, test} from "bun:test";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {callOp, OPS} from "../src/api/ops";
import {parseCatalog} from "../src/endpoints/catalog";
import {fakeCtx} from "./helpers";

const providers = parseCatalog(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "models-dev-sample.json"), "utf8")));
const argvs: string[][] = [];
function setup(signed = ["openrouter"]) {
  argvs.length = 0;
  const ctx = fakeCtx({run: async argv => {
    argvs.push(argv);
    return argv.slice(0, 3).join(" ") === "opencode auth list"
      ? {code: 0, stdout: JSON.stringify(signed.map(id => ({id, name: id === "openrouter" ? "OpenRouter" : id, connections: [{type: "api", id: "cred_private"}]}))), stderr: ""}
      : {code: 1, stdout: "", stderr: ""};
  }});
  mkdirSync(join(ctx.pacerHome, "cache"), {recursive: true});
  writeFileSync(join(ctx.pacerHome, "cache", "models.json"), JSON.stringify({fetchedAt: ctx.now, providers}));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  personal: {kind: claude}\nplanner: claude-code\nrouting:\n  - default: [claude-code]\n");
  return ctx;
}
const noNetwork = {endpoint: {fetch: (async () => { throw new Error("no catalog"); }) as never, discover: discoveryFromFetch(async () => { throw new Error("no local servers"); })}};

test("executor.setup.candidates lists signed-in providers without secrets", async () => {
  const ctx = setup();
  const body = await callOp(ctx, "executor.setup.candidates", {}, noNetwork) as {candidates: {group: string; provider: string}[]};
  expect(body.candidates[0]).toMatchObject({group: "signed_in", provider: "openrouter"});
  expect(JSON.stringify(body)).not.toMatch(/cred_|apiKey/);
});

test("executor.setup.models recommends a model for a candidate", async () => {
  const ctx = setup();
  const body = await callOp(ctx, "executor.setup.models", {provider: "openrouter", group: "signed_in"}, noNetwork) as {pick: {id: string} | null; usage: {usage: string}};
  expect(body.pick?.id).toBe("qwen/qwen3-coder");
  expect(body.usage.usage).toBe("metered");
});

test("account.add with source opencode creates a provider account", async () => {
  const ctx = setup();
  const added = await callOp(ctx, "account.add", {kind: "endpoint", source: "opencode", provider: "openrouter", model: "qwen/qwen3-coder", cap_usd: 5, test: false}, noNetwork);
  expect(added).toMatchObject({account: {source: "opencode", provider: "openrouter", weeklyUsd: 5}, state: "not_tested"});
});

test("account.add rejects a negative cap and keeps plain endpoints working", async () => {
  const ctx = setup();
  await expect(callOp(ctx, "account.add", {kind: "endpoint", source: "opencode", provider: "openrouter", model: "m", cap_usd: -1}, noNetwork)).rejects.toMatchObject({code: "invalid_input"});
  await expect(callOp(ctx, "account.add", {kind: "endpoint", name: "work", base_url: "not a url", key_source: "none", models: [{id: "m", context: 1, output: 1, tools: true}], usage: "unmetered"}, noNetwork)).rejects.toMatchObject({code: "invalid_input"});
});

test("executor.setup.connect never runs anything with the key and returns the CLI command", async () => {
  const ctx = setup([]);
  const out = await callOp(ctx, "executor.setup.connect", {provider: "deepseek", key: "sk-test-secret"}, noNetwork);
  expect(out).toEqual({connected: false, command: "opencode auth login deepseek"});
  expect(argvs.flat().join(" ")).not.toContain("sk-test-secret");
  expect(JSON.stringify(out)).not.toContain("sk-test-secret");
  expect(await callOp(ctx, "executor.setup.connect", {provider: "deepseek"}, noNetwork)).toEqual({connected: false, command: "opencode auth login deepseek"});
});

test("the setup ops are registered", () => {
  for (const name of ["executor.setup.candidates", "executor.setup.models", "executor.setup.connect"]) expect(Object.keys(OPS)).toContain(name);
});
