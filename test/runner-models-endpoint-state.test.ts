import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRunnerModels, saveRunnerModels, saveRunnerModelsMany } from "../src/core/runner-models";
import { readEndpointState, writeEndpointState } from "../src/endpoints/state";
import { fakeCtx } from "./helpers";

// A new default model makes an old endpoint test result meaningless, so it is reset to not_tested.
function setup() {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code
accounts:
  claude: {kind: claude}
  oc: {kind: endpoint, source: opencode, provider: prov, usage: unmetered}
runners:
  opencode#oc: {model: prov/a}
routing:
  - default: [opencode#oc]
`);
  writeEndpointState(ctx, "oc", {state: "not_working", detail: "test task failed: Model unavailable: prov/prov/a"});
  return ctx;
}

test("changing the default model resets the endpoint state", async () => {
  const ctx = setup();
  await saveRunnerModels(ctx, {id: "opencode#oc", expectedRevision: readRunnerModels(ctx, "opencode#oc").revision, default: "prov/b", models: []});
  expect(readEndpointState(ctx, "oc")).toEqual({state: "not_tested"});
});

test("saving the same default model keeps the endpoint state", async () => {
  const ctx = setup();
  await saveRunnerModels(ctx, {id: "opencode#oc", expectedRevision: readRunnerModels(ctx, "opencode#oc").revision, default: "prov/a", models: [{id: "prov/a", tier: "small"}]});
  expect(readEndpointState(ctx, "oc")).toMatchObject({state: "not_working"});
});

test("set-many resets the endpoint state only for a changed default", async () => {
  const ctx = setup();
  const revision = readRunnerModels(ctx, "opencode#oc").revision;
  await saveRunnerModelsMany(ctx, {expectedRevision: revision, runners: [{id: "opencode#oc", default: "prov/a", models: []}]});
  expect(readEndpointState(ctx, "oc")).toMatchObject({state: "not_working"});
  await saveRunnerModelsMany(ctx, {expectedRevision: readRunnerModels(ctx, "opencode#oc").revision, runners: [{id: "opencode#oc", default: "prov/b", models: []}]});
  expect(readEndpointState(ctx, "oc")).toEqual({state: "not_tested"});
});
