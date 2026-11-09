import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableModel, AvailableModels } from "../src/models/available";
import { checkRunner, readRunnerCheck, type RunnerCheckDeps } from "../src/core/runner-check";
import { fakeCtx } from "./install-plugin-fixtures";

function setup(model: string | null = "prov/main") {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: "claude-code", accounts: {claude: {kind: "claude"}, team: {kind: "codex", home: join(ctx.home, "team"), provider: "prov"}}, runners: {"codex#team": {model}}, routing: [{default: ["codex#team"]}]}));
  return ctx;
}
/** Fakes only the listing shape; the real isOffered and closestModels still run. */
function listing(models: AvailableModel[] | null, o: {note?: string; source?: "none" | "opencode" | "connection" | "discovery"} = {}): RunnerCheckDeps {
  return {
    detectAgents: async () => [{agent: "codex", found: true, version: "1.0", path: "/bin/codex", install_hint: "install codex"}],
    listAccounts: async () => [{name: "team", signedIn: null}],
    checkLimits: async () => [{account: "team", kind: "codex", source: "session-log", capturedAt: 1, ageS: 0, stale: false, verdict: "OK", usedPct: 3, window: "weekly", resetsAt: null, runners: ["codex#team"], error: null, hint: null}],
    runTestTask: async () => {},
    availableModels: async () => ({runner: "codex#team", source: o.source ?? (models === null ? "opencode" : "connection"), models, fetchedAt: 1, ...(o.note ? {note: o.note} : {})}) as AvailableModels,
  } as RunnerCheckDeps;
}

test("a served default passes Model offered", async () => {
  const ctx = setup();
  let launched = false;
  const d = listing([{id: "prov/other"}, {id: "prov/main"}]);
  d.runTestTask = async () => {launched = true;};
  const job = await checkRunner(ctx, "codex#team", d);
  expect(job.state).toBe("passed");
  expect(job.steps[3]).toMatchObject({name: "Model offered", state: "passed", detail: "prov/main is offered"});
  expect(job.steps[4]).toMatchObject({name: "Test task", state: "passed"});
  expect(launched).toBe(true);
  expect(readRunnerCheck(ctx, "codex#team")).toMatchObject({passed: true});
});

test("a missing default fails Model offered and skips the test task", async () => {
  const ctx = setup("prov/removal");
  let launched = false;
  const d = listing([{id: "prov/other"}]);
  d.runTestTask = async () => {launched = true;};
  const job = await checkRunner(ctx, "codex#team", d);
  expect(job.state).toBe("failed");
  expect(job.steps[3]).toMatchObject({state: "failed", detail: "prov/removal is no longer offered by prov; try prov/other"});
  expect(job.steps[4]).toMatchObject({name: "Test task", state: "skipped"});
  expect(launched).toBe(false);
  expect(readRunnerCheck(ctx, "codex#team")).toMatchObject({passed: false, detail: "prov/removal is no longer offered by prov; try prov/other"});
});

test("an agent without an adapter skips Model offered", async () => {
  const ctx = setup();
  const job = await checkRunner(ctx, "codex#team", listing(null, {source: "none"}));
  expect(job.state).toBe("passed");
  expect(job.steps[3]).toMatchObject({state: "skipped", detail: "No model list for this agent"});
  expect(job.steps[4]).toMatchObject({state: "passed"});
});

test("no closest listing still fails Model offered without a suggestion", async () => {
  const ctx = setup("prov/removal");
  const d = listing([]);
  d.runTestTask = async () => {};
  expect((await checkRunner(ctx, "codex#team", d)).steps[3]).toMatchObject({state: "failed", detail: "prov/removal is no longer offered by prov"});
});
