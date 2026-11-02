import {expect, test} from "bun:test";
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/protocol";
import {fakeCtx} from "./helpers";
import {pluginRegistry} from "../src/plugins";
import {launchEnv, type LaunchInput} from "../plugins/pacer-endpoints/launch-env";
import {discoveryFromFetch} from "./endpoint-discovery-fixtures";
import {endpointTestFromSpawn} from "./fixtures/endpoint-test-fixtures";

// Keep unrelated endpoint-config writes in-process; broker behavior is covered below.
function stubConfigBroker(ctx: ReturnType<typeof fakeCtx>) {
  const registry = pluginRegistry(ctx);
  registry.find = (() => "endpoint-plugin") as typeof registry.find;
  registry.call = (async (_ctx, _id, method, params) => {
    if (method === "usage.read") return {windows: [], capturedAt: null, stale: false, error: (params as {provider: string}).provider === "codex" ? "no Codex session logs" : "no Claude rate-limit data yet (the Claude Code status line writes it)"};
    if (method !== "endpoint.launchEnv") throw Error(`unexpected broker method ${method}`);
    return launchEnv({fs: {
      mkdir: async path => { mkdirSync(path, {recursive: true, mode: 0o700}); },
      write: async (path, data, mode) => { writeFileSync(path, data, {mode}); },
      remove: async () => { throw Error("unexpected remove"); },
    }}, params as LaunchInput);
  }) as typeof registry.call;
}

// Freeze the public results, including omitted and nullable fields, for native parity.
test("account and endpoint operation results", async () => {
  const ctx = fakeCtx({now: Date.parse("2026-10-10T12:00:00.000Z") / 1000});
  stubConfigBroker(ctx);
  ctx.env = {HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: process.env.PATH};
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), 'accounts:\n  personal: {kind: claude}\n  external: {kind: endpoint, usage: unmetered, model: vendor/old}\nplanner: claude-code\nrouting:\n  - default: [claude-code, opencode#external]\n');
  const calls: unknown[] = [];
  const deps = {endpoint: {
    discover: discoveryFromFetch(async (url, init) => {calls.push({url: String(url), authorization: (init?.headers as Record<string, string>).Authorization}); return Response.json({data: [{id: "model-a", context_length: 128000, max_output_tokens: 16000}]});}),
    endpointTest: endpointTestFromSpawn(async spec => {writeFileSync(join(spec.cwd, "hello.txt"), "ok"); return {code: 0, stdout: "", stderr: "", timedOut: false};}),
  }};
  const results: Record<string, unknown> = {};
  const call = (op: string, params: unknown) => callOp(ctx, op, params, deps);
  results.add = await call("account.add", {kind: "endpoint", name: "work", base_url: "https://endpoint.invalid/v1", key_source: "file", key: "fake-key", models: [{id: "model-a", context: 128000, output: 16000, tools: true}], usage: "unmetered", test: false});
  const strategyPath = join(ctx.pacerHome, "strategy.yaml");
  const keyPath = join(ctx.pacerHome, "secrets/work.key");
  const statePath = join(ctx.pacerHome, "endpoints/state.json");
  const saved = readFileSync(strategyPath, "utf8");
  expect(saved).toContain("opencode#work");
  expect(saved).toContain("pacer-work/model-a");
  expect(saved).not.toContain("fake-key");
  const providerPath = join(ctx.pacerHome, "opencode/opencode.json");
  const provider = readFileSync(providerPath, "utf8");
  expect(JSON.parse(provider).provider["pacer-work"].models["model-a"]).toBeDefined();
  expect(provider).not.toContain("fake-key");
  expect(statSync(providerPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(keyPath, "utf8")).toBe("fake-key");
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.pacerHome, "secrets")).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(statePath, "utf8")).work.state).toBe("not_tested");
  expect(statSync(statePath).mode & 0o777).toBe(0o600);
  const rejected = await call("account.add", {kind: "endpoint", name: "bad", base_url: "https://endpoint.invalid/v1", key_source: "file", key: "fake-key", models: [{id: "fake-key", context: 1, output: 1, tools: true}], usage: "unmetered", test: false}).catch(toApiError);
  expect(JSON.stringify(rejected)).not.toContain("fake-key");
  expect(readFileSync(strategyPath, "utf8")).toBe(saved);
  expect(existsSync(join(ctx.pacerHome, "secrets/bad.key"))).toBe(false);
  results.models = await call("account.models", {name: "work"});
  results.test = await call("account.test", {name: "work"});
  expect(JSON.parse(readFileSync(statePath, "utf8")).work.state).toBe("ready");
  results.edit = await call("account.edit", {name: "work", models: [{id: "model-b", context: 100, output: 10, tools: false}]});
  expect(JSON.parse(readFileSync(statePath, "utf8")).work.state).toBe("not_tested");
  expect(readFileSync(strategyPath, "utf8")).toContain("pacer-work/model-b");
  expect(JSON.parse(readFileSync(providerPath, "utf8")).provider["pacer-work"].models["model-b"]).toBeDefined();
  const dir = join(ctx.home, ".config/opencode"); mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({provider: {vendor: {options: {baseURL: "https://endpoint.invalid/v1", apiKey: "fake-external-key"}, models: {old: {}}}}}));
  results.adopt = await call("account.adopt", {name: "external", key_source: "none"});
  results.list = await call("account.list", {});
  results.removeInUse = await call("account.remove", {name: "work"}).catch(toApiError);
  expect(readFileSync(strategyPath, "utf8")).toContain("opencode#work");
  results.addNative = await call("account.add", {kind: "codex", name: "spare"});
  results.remove = await call("account.remove", {name: "spare", delete_home: true});
  // Replace only the disposable root; never snapshot credentials or host-specific paths.
  const rendered = JSON.stringify({results, calls}, (key, value) => key === "signin_command" && typeof value === "string" ? value.replaceAll("\n", "\\n") : value).replaceAll(ctx.home, "$HOME").replaceAll("Bearer fake-key", "Bearer <fake-key>");
  expect(rendered).not.toContain("fake-external-key");
  expect(JSON.parse(rendered)).toMatchSnapshot();
});

test("OpenCode provider setup and endpoint broker requests", async () => {
  const {parseCatalog} = await import("../src/endpoints/catalog");
  const {readFileSync} = await import("node:fs");
  const {discoverEndpointModels} = await import("../src/plugins/endpoint-adapter");
  const ctx = fakeCtx({now: Date.parse("2026-10-10T12:00:00.000Z") / 1000, run: async argv => argv.slice(0, 3).join(" ") === "opencode auth list"
    ? {code: 0, stdout: JSON.stringify([{id: "openrouter", name: "OpenRouter", connections: [{type: "api", id: "fake-credential"}]}]), stderr: ""}
    : {code: 1, stdout: "", stderr: ""}});
  stubConfigBroker(ctx);
  mkdirSync(join(ctx.pacerHome, "cache"), {recursive: true});
  const catalog = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/models-dev-sample.json"), "utf8"));
  writeFileSync(join(ctx.pacerHome, "cache/models.json"), JSON.stringify({fetchedAt: ctx.now, providers: parseCatalog(catalog)}));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  personal: {kind: claude}\nplanner: claude-code\nrouting:\n  - default: [claude-code]\n");
  const deps = {endpoint: {fetch: (async () => {throw Error("no network");}) as never, discover: discoveryFromFetch(async () => {throw Error("no network");})}};
  const candidates = await callOp(ctx, "executor.setup.candidates", {}, deps);
  const models = await callOp(ctx, "executor.setup.models", {provider: "openrouter", group: "signed_in"}, deps);
  const connect = await callOp(ctx, "executor.setup.connect", {provider: "deepseek", key: "fake-key"}, deps);
  const add = await callOp(ctx, "account.add", {kind: "endpoint", source: "opencode", provider: "openrouter", model: "qwen/qwen3-coder", cap_usd: 5, test: false}, deps);
  let broker: unknown;
  const registry = {find: () => "endpoint-plugin", call: async (_ctx: unknown, id: unknown, method: unknown, params: unknown, options: any) => {
    broker = {id, method, params, resources: options.resources, deadlineMs: options.deadlineMs, credentialRefs: options.credentialBindings.map((binding: {ref: string}) => binding.ref)};
    expect(await options.credentialBindings[0].resolve()).toBe("fake-key");
    return {listed: true, models: []};
  }};
  const discovered = await discoverEndpointModels(ctx, {baseUrl: "https://endpoint.invalid/v1", key: "fake-key", timeoutMs: 1000}, registry as never);
  const rendered = JSON.stringify({candidates, models, connect, add, broker, discovered}).replaceAll(ctx.home, "$HOME");
  expect(rendered).not.toContain("fake-key");
  expect(rendered).not.toContain("fake-credential");
  expect(JSON.parse(rendered)).toMatchSnapshot();
});

test("usage consent refusal and consented probe results", async () => {
  const ctx = fakeCtx({now: 1_800_000_000});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: {agent: "claude-code", account: "work"}, accounts: {work: {kind: "claude"}}, runners: {}, routing: []}));
  let probes = 0;
  const reading = {windows: [{name: "weekly", usedPct: 20, resetsAt: null, lengthS: 604800, paced: true}], capturedAt: ctx.now - 10, stale: false};
  const deps = {accountUsageCheck: {probe: async () => {probes++;}, read: async (_ctx: unknown, _account: unknown, _runners: unknown, refresh?: boolean) => ({...reading, capturedAt: refresh ? ctx.now : reading.capturedAt})}};
  const refused = await callOp(ctx, "account.usage.check", {account: "work"}, deps).catch(toApiError);
  expect(probes).toBe(0);
  const job = await callOp(ctx, "account.usage.check", {account: "work", consent: true}, deps) as Record<string, unknown>;
  expect(probes).toBe(1);
  // Process identity and completion time vary between runs.
  expect({refused, job: {...job, id: "<job-id>", pid: "<pid>", endedAt: "<ended-at>"}}).toMatchSnapshot();
});

test("account schema preserves JavaScript string and number boundaries", async () => {
  const {OPS} = await import("../src/api/ops");
  const parse = (op: string, params: unknown) => OPS[op]!.params.safeParse(params).success;
  const endpoint = {kind: "endpoint", name: "work", base_url: "https://endpoint.invalid/v1", key_source: "none", models: [{id: "m", context: 1, output: 1, tools: true}], usage: "unmetered"};
  const cases = {
    names: ["", " ", "a".repeat(128), "a".repeat(129), "😀".repeat(64), "😀".repeat(128), "😀".repeat(129)].map(name => parse("account.test", {name})),
    modelIds: ["", " ", "\u00a0", "😀"].map(id => parse("account.add", {...endpoint, models: [{...endpoint.models[0], id}]})),
    context: [0, 1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN].map(context => parse("account.add", {...endpoint, models: [{...endpoint.models[0], context}]})),
    caps: [0, Number.MIN_VALUE, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN].map(cap_usd => parse("account.add", {kind: "endpoint", source: "opencode", provider: "openrouter", model: "m", cap_usd})),
  };
  expect(cases).toEqual({names: [false, true, true, false, true, true, false], modelIds: [false, true, true, true], context: [false, true, false, true, false, false, false], caps: [false, true, true, true, false, false]});
});

test("environment key source and failed validation preserve persisted state", async () => {
  const ctx = fakeCtx({now: 1_800_000_000, env: {ENDPOINT_TOKEN: "env-secret"}});
  stubConfigBroker(ctx);
  mkdirSync(ctx.pacerHome, {recursive: true});
  const path = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(path, "accounts:\n  personal: {kind: claude}\nplanner: claude-code\nrouting:\n  - default: [claude-code]\n");
  const params = {kind: "endpoint", name: "env-work", base_url: "https://endpoint.invalid/v1", key_source: "env", env_var: "ENDPOINT_TOKEN", models: [{id: "first", context: 10, output: 5, tools: true}, {id: "second", context: 20, output: 10, tools: false}], usage: "unmetered", test: false};
  const added = await callOp(ctx, "account.add", params);
  const saved = readFileSync(path, "utf8");
  expect(saved).toContain("env:ENDPOINT_TOKEN");
  expect(saved).toContain("pacer-env-work/first");
  expect(saved).not.toContain("env-secret");
  expect(JSON.stringify(added)).not.toContain("env-secret");
  expect(existsSync(join(ctx.pacerHome, "secrets/env-work.key"))).toBe(false);
  const failure = await callOp(ctx, "account.edit", {name: "env-work", models: []}).catch(toApiError);
  expect(JSON.stringify(failure)).toContain("invalid");
  expect(readFileSync(path, "utf8")).toBe(saved);
});
