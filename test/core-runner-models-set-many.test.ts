import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRunnerModels, saveRunnerModelsMany } from "../src/core/runner-models";
import { loadStrategy } from "../src/config/strategy";
import { callOp, OPS } from "../src/api/ops";
import { fakeCtx } from "./helpers";

const withRunners = () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `# keep runners
planner: claude-code
accounts:
  claude: {kind: claude}
  one: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:9", key: none, models: [{id: m1, context: 8192, output: 512, tools: true}, {id: m2, context: 4096, output: 512, tools: false}]}}
  two: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:9", key: none, models: [{id: n1, context: 8192, output: 512, tools: true}]}}
runners:
  claude-code: {}
  opencode#one: {}
  opencode#two: {}
`);
  return ctx;
};

const path = (ctx: ReturnType<typeof fakeCtx>) => join(ctx.pacerHome, "strategy.yaml");

test("commits every runner in one revision-checked edit", async () => {
  const ctx = withRunners(), base = readRunnerModels(ctx, "opencode#one");
  const result = await saveRunnerModelsMany(ctx, {expectedRevision: base.revision, runners: [
    {id: "opencode#one", default: "pacer-one/m1", models: [{id: "pacer-one/m1", tier: "small"}, {id: "pacer-one/m2", tier: "frontier"}]},
    {id: "opencode#two", default: "pacer-two/n1", models: [{id: "pacer-two/n1", tier: "medium"}]},
  ]});
  expect(result.revision).not.toBe(base.revision);
  expect(result.warnings).toEqual([]);
  expect(result.runners.map(r => r.runner).sort()).toEqual(["opencode#one", "opencode#two"]);
  const one = loadStrategy(ctx).runners["opencode#one"];
  expect(one).toMatchObject({model: "pacer-one/m1"});
  expect(one.models).toMatchObject([{id: "pacer-one/m1", tier: "small"}, {id: "pacer-one/m2", tier: "frontier", strengths: []}]);
  expect(loadStrategy(ctx).runners["opencode#two"]).toMatchObject({model: "pacer-two/n1"});
  expect(readFileSync(path(ctx), "utf8")).toContain("# keep runners");
  const reread = readRunnerModels(ctx, "opencode#one");
  expect(reread.revision).toBe(result.revision);
  expect(result.runners.find(r => r.runner === "opencode#one")).toMatchObject({revision: result.revision, default: "pacer-one/m1"});
});

test("a stale revision conflicts and writes nothing", async () => {
  const ctx = withRunners(), before = readFileSync(path(ctx), "utf8");
  await expect(saveRunnerModelsMany(ctx, {expectedRevision: "stale", runners: [
    {id: "opencode#one", default: "pacer-one/m1", models: [{id: "pacer-one/m1", tier: "small"}]},
  ]})).rejects.toMatchObject({code: "conflict"});
  expect(readFileSync(path(ctx), "utf8")).toBe(before);
});

test("a second invalid runner refuses the whole batch and writes nothing", async () => {
  const ctx = withRunners(), before = readFileSync(path(ctx), "utf8");
  await expect(saveRunnerModelsMany(ctx, {expectedRevision: readRunnerModels(ctx, "opencode#one").revision, runners: [
    {id: "opencode#one", default: "pacer-one/m1", models: [{id: "pacer-one/m1", tier: "small"}]},
    {id: "opencode#two", default: "pacer-two/zz", models: [{id: "pacer-two/n1", tier: "small"}]}, // default not in models
  ]})).rejects.toMatchObject({code: "invalid_input"});
  expect(readFileSync(path(ctx), "utf8")).toBe(before);
  expect(loadStrategy(ctx).runners["opencode#one"].models).toBeUndefined();
});

test("a model the listing does not offer refuses the whole batch and writes nothing", async () => {
  const ctx = withRunners(), before = readFileSync(path(ctx), "utf8");
  await expect(saveRunnerModelsMany(ctx, {expectedRevision: readRunnerModels(ctx, "opencode#one").revision, runners: [
    {id: "opencode#one", default: "pacer-one/m1", models: [{id: "pacer-one/m1", tier: "small"}]},
    {id: "opencode#two", default: "pacer-two/m1", models: [{id: "pacer-two/m1", tier: "small"}]},
  ]})).rejects.toMatchObject({code: "invalid_input", message: "pacer-two/m1 is not offered by two"});
  expect(readFileSync(path(ctx), "utf8")).toBe(before);
  expect(loadStrategy(ctx).runners["opencode#one"].models).toBeUndefined();
});

test("the planner runner is refused and writes nothing", async () => {
  const ctx = withRunners(), before = readFileSync(path(ctx), "utf8");
  await expect(saveRunnerModelsMany(ctx, {expectedRevision: readRunnerModels(ctx, "claude-code").revision, runners: [
    {id: "opencode#one", default: "pacer-one/m1", models: [{id: "pacer-one/m1", tier: "small"}]},
    {id: "claude-code", default: "x", models: [{id: "x", tier: "small"}]},
  ]})).rejects.toMatchObject({code: "not_allowed", message: "cannot edit the planner runner"});
  expect(readFileSync(path(ctx), "utf8")).toBe(before);
});

test("an unknown runner, duplicate ids and out-of-range counts are invalid_input", async () => {
  const ctx = withRunners();
  const edit = (id: string) => ({id, default: "pacer-one/m1", models: [{id: "pacer-one/m1", tier: "small" as const}]});
  await expect(saveRunnerModelsMany(ctx, {expectedRevision: readRunnerModels(ctx, "opencode#one").revision, runners: [edit("nope")]})).rejects.toMatchObject({code: "invalid_input", message: "unknown runner nope"});
  await expect(saveRunnerModelsMany(ctx, {expectedRevision: readRunnerModels(ctx, "opencode#one").revision, runners: [edit("opencode#one"), edit("opencode#one")]})).rejects.toMatchObject({code: "invalid_input", message: "duplicate runner ids"});
  await expect(saveRunnerModelsMany(ctx, {expectedRevision: "x", runners: []})).rejects.toMatchObject({code: "invalid_input"});
  await expect(saveRunnerModelsMany(ctx, {expectedRevision: "x", runners: Array.from({length: 65}, (_, i) => edit(`r${i}`))})).rejects.toMatchObject({code: "invalid_input"});
});

test("an empty model list clears models and keeps the default", async () => {
  const ctx = withRunners();
  writeFileSync(path(ctx), `planner: claude-code
accounts:
  claude: {kind: claude}
  one: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:9", key: none, models: [{id: m1, context: 8192, output: 512, tools: true}]}}
runners:
  claude-code: {}
  opencode#one: {model: pacer-one/m1, models: [{id: pacer-one/m1, tier: small}]}
`);
  const result = await saveRunnerModelsMany(ctx, {expectedRevision: readRunnerModels(ctx, "opencode#one").revision, runners: [
    {id: "opencode#one", default: "pacer-one/m1", models: []},
  ]});
  expect(result.runners[0]).toMatchObject({default: "pacer-one/m1", models: []});
  expect(loadStrategy(ctx).runners["opencode#one"]).toMatchObject({model: "pacer-one/m1"});
  expect(readFileSync(path(ctx), "utf8")).toContain("opencode#one: {model: pacer-one/m1}");
});

test("an unknown listing warns instead of refusing", async () => {
  const ctx = withRunners();
  writeFileSync(path(ctx), `planner: claude-code
accounts:
  claude: {kind: claude}
  go: {kind: endpoint, source: opencode, provider: acme, usage: unmetered}
runners:
  claude-code: {}
  opencode#go: {model: acme/a}
`);
  ctx.run = async () => ({code: 1, stdout: "", stderr: "probe failed"});
  const result = await saveRunnerModelsMany(ctx, {expectedRevision: readRunnerModels(ctx, "opencode#go").revision, runners: [
    {id: "opencode#go", default: "acme/a", models: [{id: "acme/a", tier: "small"}]},
  ]});
  expect(result.warnings.some(w => w.includes("acme/a could not be checked"))).toBe(true);
  expect(loadStrategy(ctx).runners["opencode#go"]).toMatchObject({model: "acme/a"});
});

test("the op is registered and validates through the registry", async () => {
  expect(Object.keys(OPS)).toContain("runner.models.set_many");
  const ctx = withRunners();
  const got = await callOp(ctx, "runner.models.get", {id: "opencode#one"}) as {revision: string};
  const set = await callOp(ctx, "runner.models.set_many", {expectedRevision: got.revision, runners: [
    {id: "opencode#one", default: "pacer-one/m1", models: [{id: "pacer-one/m1", tier: "small"}]},
  ]});
  expect(set).toMatchObject({runners: [{runner: "opencode#one", default: "pacer-one/m1"}]});
  await expect(callOp(ctx, "runner.models.set_many", {expectedRevision: (set as {revision: string}).revision, runners: []})).rejects.toMatchObject({code: "invalid_input"});
});
