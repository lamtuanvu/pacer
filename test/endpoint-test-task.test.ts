import {endpointTestFromSpawn} from './fixtures/endpoint-test-fixtures';
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testEndpoint } from "../src/endpoints/test-task";
import { readEndpointState, writeEndpointState } from "../src/endpoints/state";
import { endpointRow } from "../src/endpoints/row";
import { loadStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { accountCmd } from "../src/commands/accounts";
import { fakeCtx } from "./helpers";

function setup() {
  const ctx = fakeCtx({env: {TEST_ENDPOINT_KEY: "private-endpoint-value"}});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({accounts: {plan: {kind: "claude"}, api: {kind: "endpoint", usage: "unmetered", connection: {api: "openai-compatible", base_url: "http://localhost:1234/v1", key: "env:TEST_ENDPOINT_KEY", models: [{id: "m", context: 8192, output: 1024, tools: true}]}}, external: {kind: "endpoint", usage: "unmetered", model: "local/m"}}, planner: "claude-code", routing: [{default: ["opencode#api", "opencode#external"]}]}));
  return ctx;
}
test("test task uses launch helpers in a disposable git repo and records Ready", async () => {
  const ctx = setup(); let repo = "";
  const state = await testEndpoint(ctx, "api", {endpointTest: endpointTestFromSpawn(async spec => {
    repo = spec.cwd; expect(existsSync(join(repo, ".git"))).toBe(true);
    expect(repo.startsWith(ctx.pacerHome)).toBe(true);
    expect(spec.argv).toContain("pacer-api/m");
    expect(spec.argv.at(-1)).toBe("Create a file named hello.txt containing exactly: ok");
    expect(spec.timeoutMs).toBe(120000); expect(spec.env.PACER_KEY_API).toBe(ctx.env.TEST_ENDPOINT_KEY);
    expect(spec.logFile).toBeUndefined();
    writeFileSync(join(repo, "hello.txt"), "ok");
    return {code: 0, stdout: "", stderr: "", timedOut: false};
  })});
  expect(state).toEqual({state: "ready", checked_at: new Date(ctx.now * 1000).toISOString()});
  expect(readEndpointState(ctx, "api")).toEqual(state); expect(existsSync(repo)).toBe(false);
  expect(statSync(join(ctx.pacerHome, "endpoints/state.json")).mode & 0o777).toBe(0o600);
});
for (const failure of ["missing", "wrong", "exit", "timeout", "throw"]) test(`test task failure ${failure} is recorded and cleaned`, async () => {
  const ctx = setup(); let repo = "";
  const result = await testEndpoint(ctx, "api", {endpointTest: endpointTestFromSpawn(async spec => {
    repo = spec.cwd;
    if (failure === "throw") throw Error(`Authorization: Bearer ${ctx.env.TEST_ENDPOINT_KEY}\nsecond line`);
    if (failure !== "missing") writeFileSync(join(repo, "hello.txt"), failure === "wrong" ? "wrong" : "ok");
    return {code: failure === "exit" ? 1 : 0, stdout: "", stderr: `failed ${ctx.env.TEST_ENDPOINT_KEY}\nsecond line`, timedOut: failure === "timeout"};
  })});
  expect(result.state).toBe("not_working"); expect(result.detail).not.toContain("private-endpoint-value"); expect(result.detail).not.toContain("second line");
  expect(readFileSync(join(ctx.pacerHome, "endpoints/state.json"), "utf8")).not.toContain("private-endpoint-value");
  expect(existsSync(repo)).toBe(false);
});
test("routing and shared account rows reflect live keys and stored states", async () => {
  const ctx = setup(), s = loadStrategy(ctx);
  expect(await endpointRow(ctx, s.accounts.api)).toMatchObject({state: "not_tested", connection: {api: "openai-compatible", base_url_host: "localhost:1234", key: "present", models: s.accounts.api.connection!.models}});
  for (const state of ["not_tested", "ready", "not_working"] as const) {
    writeEndpointState(ctx, "api", {state, ...(state === "not_working" ? {detail: "model not found"} : {})});
    const status = await computeStatus(ctx, s, {profile: null});
    expect(status.executors.ranked.some(r => r.id === "opencode#api")).toBe(state !== "not_working");
    if (state === "not_working") expect(status.executors.excluded).toContainEqual(expect.objectContaining({id: "opencode#api", account: "api", reason: "Not working · model not found"}));
  }
  delete ctx.env.TEST_ENDPOINT_KEY;
  const status = await computeStatus(ctx, s, {profile: null});
  expect(status.executors.excluded).toContainEqual(expect.objectContaining({id: "opencode#api", account: "api", reason: "Key missing"}));
  const rows = JSON.parse((await accountCmd(["list", "--json"], ctx)).out);
  expect(rows.find((a: any) => a.name === "api")).toMatchObject({state: "key_missing", connection: {key: "missing"}});
  expect(rows.find((a: any) => a.name === "external")).toMatchObject({state: "external"});
  expect(status.executors.ranked.some(r => r.id === "opencode#external")).toBe(true);
  expect((await testEndpoint(ctx, "api", {endpointTest: endpointTestFromSpawn(async () => {throw Error("must not launch");})})).state).toBe("not_working");
});
test("state updates preserve other accounts and file permissions", () => {
  const ctx = setup();
  writeEndpointState(ctx, "api", {state: "ready", checked_at: "2026-10-15T00:00:00Z"});
  writeEndpointState(ctx, "external", {state: "not_working", detail: "model not found"});
  expect(readEndpointState(ctx, "api").state).toBe("ready");
  expect(statSync(join(ctx.pacerHome, "endpoints")).mode & 0o777).toBe(0o700);
  expect(statSync(join(ctx.pacerHome, "endpoints/state.json")).mode & 0o777).toBe(0o600);
});
test("key none remains available and invalid account tests never launch", async () => {
  const ctx = setup(), path = join(ctx.pacerHome, "strategy.yaml");
  const raw = JSON.parse(readFileSync(path, "utf8")); raw.accounts.api.connection.key = "none";
  writeFileSync(path, JSON.stringify(raw)); delete ctx.env.TEST_ENDPOINT_KEY;
  expect(await endpointRow(ctx, loadStrategy(ctx).accounts.api)).toMatchObject({state: "not_tested", connection: {key: "present"}});
  await expect(testEndpoint(ctx, "external")).rejects.toThrow("connection");
  await expect(testEndpoint(ctx, "unknown")).rejects.toThrow("connection");
});
