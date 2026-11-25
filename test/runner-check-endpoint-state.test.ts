import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableModels } from "../src/models/available";
import { checkRunner, type RunnerCheckDeps } from "../src/core/runner-check";
import { readEndpointState, writeEndpointState } from "../src/endpoints/state";
import { fakeCtx } from "./install-plugin-fixtures";

// The drawer's executor check is the only test task the app offers, so its result must replace the
// account-level endpoint state that routing reads; otherwise an old failure blocks the agent forever.
function setup() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: "claude-code",
    accounts: {claude: {kind: "claude"}, oc: {kind: "endpoint", source: "opencode", provider: "prov", usage: "unmetered"}},
    runners: {"opencode#oc": {model: "prov/main"}}, routing: [{default: ["opencode#oc"]}]}));
  writeEndpointState(ctx, "oc", {state: "not_working", detail: "test task failed: Error: Model unavailable: prov/prov/main"});
  return ctx;
}
function deps(over: Partial<RunnerCheckDeps> = {}): RunnerCheckDeps {
  return {
    detectAgents: async () => [{agent: "opencode", found: true, version: "2.2", path: "/bin/opencode", install_hint: "install opencode"}],
    listAccounts: async () => [{name: "oc", signedIn: null}],
    checkLimits: async () => [],
    runTestTask: async () => {},
    availableModels: async () => ({runner: "opencode#oc", source: "opencode", models: [{id: "prov/main"}], fetchedAt: 1}) as AvailableModels,
    ...over,
  } as RunnerCheckDeps;
}

test("a passing executor check replaces a stale not_working endpoint state", async () => {
  const ctx = setup();
  const job = await checkRunner(ctx, "opencode#oc", deps());
  expect(job.state).toBe("passed");
  expect(readEndpointState(ctx, "oc")).toMatchObject({state: "ready", checked_at: expect.any(String)});
});

test("a failing test task records not_working with its detail", async () => {
  const ctx = setup();
  writeEndpointState(ctx, "oc", {state: "ready", checked_at: "2026-01-01T00:00:00.000Z"});
  const job = await checkRunner(ctx, "opencode#oc", deps({runTestTask: async () => { throw Error("test task failed: boom"); }}));
  expect(job.state).toBe("failed");
  expect(readEndpointState(ctx, "oc")).toMatchObject({state: "not_working", detail: expect.stringContaining("boom")});
});

test("a failure before the test task leaves the endpoint state alone", async () => {
  const ctx = setup();
  const job = await checkRunner(ctx, "opencode#oc", deps({availableModels: async () => ({runner: "opencode#oc", source: "opencode", models: [{id: "prov/other"}], fetchedAt: 1}) as AvailableModels}));
  expect(job.state).toBe("failed");
  expect(readEndpointState(ctx, "oc")).toMatchObject({state: "not_working", detail: expect.stringContaining("prov/prov/main")});
});

test("a failing test task keeps a key_missing state", async () => {
  const ctx = setup();
  writeEndpointState(ctx, "oc", {state: "key_missing", detail: "Run opencode auth login --standalone prov"});
  await checkRunner(ctx, "opencode#oc", deps({runTestTask: async () => { throw Error("test task failed: unauthorized"); }}));
  expect(readEndpointState(ctx, "oc")).toMatchObject({state: "key_missing"});
});
