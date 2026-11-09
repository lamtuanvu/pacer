import {expect, test} from "bun:test";
import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {availableModels, closestModels, isOffered, type AvailableModels} from "../src/models/available";
import type {Ctx} from "../src/types";
import {fakeCtx} from "./helpers";

// A strategy always carries a default claude account so the claude-code planner resolves cleanly.
function writeStrategy(ctx: Ctx, accounts: Record<string, unknown>, runners: Record<string, unknown>) {
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
    planner: "claude-code",
    accounts: {claude: {kind: "claude"}, ...accounts},
    runners,
  }));
}
function writeCatalog(ctx: Ctx, providers: Record<string, unknown>) {
  mkdirSync(join(ctx.pacerHome, "cache"), {recursive: true});
  writeFileSync(join(ctx.pacerHome, "cache", "models.json"), JSON.stringify({fetchedAt: ctx.now, providers}));
}
function ctxWithOpencodeModels(stdout: string, code = 0) {
  let calls = 0;
  const ctx = fakeCtx({run: async () => { calls++; return {code, stdout, stderr: ""}; }});
  return {ctx, calls: () => calls};
}
const opencodeAcc = {kind: "endpoint", source: "opencode", provider: "acme"};

test("opencode runner lists served models with catalog facts and provider-prefixed ids", async () => {
  const {ctx, calls} = ctxWithOpencodeModels("acme/a\nacme/b\nother/x\n");
  writeStrategy(ctx, {acme: opencodeAcc}, {"opencode#acme": {model: "acme/a"}});
  writeCatalog(ctx, {acme: {id: "acme", name: "Acme", env: [], api: null, models: [
    {id: "a", name: "A Model", toolCall: true, input: [], output: [], context: 262144, outputLimit: 8192, costIn: 1.2, costOut: 4.5, release: "2026-01-01"},
    {id: "b", name: "B", toolCall: true, input: [], output: [], context: 128000, outputLimit: null, costIn: null, costOut: null, release: null},
  ]}});
  const r = await availableModels(ctx, "opencode#acme");
  expect(r.source).toBe("opencode");
  expect(r.models!.map(m => m.id)).toEqual(["acme/a", "acme/b"]);
  expect(r.models!.find(m => m.id === "acme/a")).toMatchObject({context: 262144, output: 8192, tools: true, name: "A Model", release: "2026-01-01"});
  expect(calls()).toBe(1);
});

test("a failed opencode listing is unknown, not empty, and is not cached", async () => {
  const {ctx, calls} = ctxWithOpencodeModels("", 1);
  writeStrategy(ctx, {acme: opencodeAcc}, {"opencode#acme": {model: "acme/a"}});
  const r = await availableModels(ctx, "opencode#acme");
  expect(r.source).toBe("opencode");
  expect(r.models).toBeNull();
  expect(r.note).toContain("could not list");
  const again = await availableModels(ctx, "opencode#acme");
  expect(again.models).toBeNull();
  expect(calls()).toBe(2);
});

test("connection runner lists connection.models with the pacer prefix", async () => {
  const ctx = fakeCtx();
  const connection = {api: "openai-compatible", base_url: "http://127.0.0.1:8123/v1", key: "none",
    models: [{id: "m1", name: "M1", context: 4000, output: 500, tools: true}]};
  writeStrategy(ctx, {ornode: {kind: "endpoint", connection}}, {"opencode#ornode": {model: "pacer-ornode/m1"}});
  const r = await availableModels(ctx, "opencode#ornode");
  expect(r.source).toBe("connection");
  expect(r.models!.map(m => m.id)).toEqual(["pacer-ornode/m1"]);
  expect(r.models![0]).toMatchObject({context: 4000, output: 500, tools: true, name: "M1"});
});

test("claude-code runner has no adapter", async () => {
  const ctx = fakeCtx();
  writeStrategy(ctx, {}, {"claude-code": {}});
  const r = await availableModels(ctx, "claude-code");
  expect(r.source).toBe("none");
  expect(r.models).toBeNull();
});

test("isOffered and closestModels", () => {
  const list: AvailableModels = {runner: "r", source: "opencode", models: [{id: "acme/a"}, {id: "acme/b"}, {id: "acme/bb"}], fetchedAt: 0};
  expect(isOffered(list, "acme/b")).toBe(true);
  expect(isOffered({runner: "r", source: "none", models: null, fetchedAt: 0}, "acme/b")).toBeNull();
  // The queried id itself is not an offer; acme/b shares the longest prefix with acme/bb.
  expect(closestModels(list, "acme/bb")[0]).toBe("acme/b");
});

test("cached for ten minutes unless refreshed", async () => {
  let calls = 0;
  const ctx = fakeCtx({run: async () => { calls++; return {code: 0, stdout: "acme/a\n", stderr: ""}; }});
  writeStrategy(ctx, {acme: opencodeAcc}, {"opencode#acme": {model: "acme/a"}});
  const first = await availableModels(ctx, "opencode#acme");
  const second = await availableModels(ctx, "opencode#acme");
  expect(calls).toBe(1);
  expect(second.fetchedAt).toBe(first.fetchedAt);
  await availableModels(ctx, "opencode#acme", {refresh: true});
  expect(calls).toBe(2);
});