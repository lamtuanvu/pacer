import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { previewDispatch } from "../src/core/dispatch";
import { createMcpServer } from "../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { listTasksWhere } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

export function dispatchCtx() {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  return ctx;
}
test("preview operation is read-only, leaves legacy delegation guarded, and returns uncertainty", async () => {
  const ctx = dispatchCtx(), input = { repo: tmpDir(), goal: "Investigate", kind: "architecture" };
  const direct = await previewDispatch(ctx, input);
  const api = await callOp(ctx, "dispatch.preview", input);
  expect(api).toEqual(direct);
  expect(direct.proposal?.state).toBe("no-match");
  expect(direct.engine.id).toBe("ladder");
  expect(listTasksWhere(ctx, {all: true})).toEqual([]);
  expect(direct.request.task.kind).toBe("architecture");
  await expect(callOp(ctx, "dispatch.preview", {...input, requirements: {minTier: "magic"}})).rejects.toMatchObject({code: "invalid_input"});
});
test("MCP preview uses the same core decision contract", async () => {
  const ctx = dispatchCtx(), input = {repo: tmpDir(), goal: "Check"};
  const server = createMcpServer(() => ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); const client = new Client({name: "test", version: "1"}); await client.connect(ct);
  try {
    const result = await client.callTool({name: "dispatch_preview", arguments: input});
    expect(result.structuredContent).toEqual(await callOp(ctx, "dispatch.preview", input));
  } finally { await client.close(); await server.close(); }
});
test("preview chooses a declared capable model and preserves shared pool accounting", async () => {
  const {validateStrategy} = await import("../src/config/strategy");
  const ctx = dispatchCtx();
  const strategy = validateStrategy({planner: "claude-code", accounts: {"claude-code": {kind: "claude"}, codex: {kind: "codex"}}, runners: {codex: {models: [{id: "provider/small", tier: "small"}, {id: "provider/deep", tier: "frontier", tools: true}]}}}, "test");
  const result = await previewDispatch(ctx, {repo: tmpDir(), goal: "Debug", requirements: {minTier: "medium", tools: true}}, {
    strategy,
    status: async () => ({generatedAt: ctx.now, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false, providers: [{id: "codex", usage: "quota", windows: [{name: "weekly", usedPct: 25, resetsAt: ctx.now + 3600, lengthS: 604800, paced: true, verdict: "ON_PACE"}], binding: null, verdict: "ON_PACE", installed: true, stale: false}], accounts: [{name: "codex", kind: "codex", verdict: "ON_PACE", usedPct: 25, pacePct: null, resetsAt: ctx.now + 3600, window: "weekly", stale: false, source: null, capturedAt: ctx.now, runners: ["codex"], spendUsd: null}], executors: {ranked: [], excluded: []}}),
  });
  expect(result.proposal?.state).toBe("ranked");
  expect(result.request.candidates).toHaveLength(1);
  expect(result.request.candidates[0].binding).toEqual({kind: "exact", id: "provider/deep"});
  expect(result.request.candidates[0].headroom).toBe(75);
  expect(result.excluded.some(e => e.reason === "Task requirements not satisfied")).toBe(true);
});
test("cold remote preview never probes SSH or writes reachability cache", async () => {
  const {validateStrategy} = await import("../src/config/strategy");
  const {existsSync} = await import("node:fs");
  const ctx = dispatchCtx(); let ssh = 0;
  ctx.run = async argv => { if (argv[0] === "ssh") ssh++; return {code: 1, stdout: "", stderr: "unavailable"}; };
  const strategy = validateStrategy({planner: "claude-code", providers: {"claude-code": {}, codex: {}}}, "test");
  strategy.hosts.remote = {alias: "remote", ssh: "remote", repos: {}, maxTasks: 2, accounts: {}};
  strategy.runners = {"codex@remote": {...strategy.runners.codex, id: "codex@remote", host: "remote"}};
  strategy.routing = [{kinds: null, executors: ["codex@remote"]}];
  const result = await previewDispatch(ctx, {repo: tmpDir(), goal: "check"}, {strategy, status: async () => ({generatedAt: ctx.now, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false, providers: [{id: "codex@remote", usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false}], executors: {ranked: [], excluded: []}})});
  expect(ssh).toBe(0);
  expect(existsSync(join(ctx.pacerHome, "cache/hosts.json"))).toBe(false);
  expect(result.request.candidates).toEqual([]);
  expect(result.excluded.some(e => e.reason.includes("unknown"))).toBe(true);
});
test("core requests model-specific observations without leaking capabilities to sibling models", async () => {
  const {validateStrategy} = await import("../src/config/strategy");
  const ctx = dispatchCtx();
  const strategy = validateStrategy({planner: "claude-code", accounts: {"claude-code": {kind: "claude"}, codex: {kind: "codex"}}, runners: {codex: {models: [{id: "provider/a"}, {id: "provider/b"}]}}}, "test");
  const result = await previewDispatch(ctx, {repo: tmpDir(), goal: "Check", requirements: {tools: true}}, {
    strategy,
    status: async () => ({generatedAt: ctx.now, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false, providers: [{id: "codex", usage: "quota", windows: [], binding: null, verdict: "OK", installed: true, stale: false}], executors: {ranked: [], excluded: []}}),
    adapters: [{id: "capabilities", methods: ["capabilities"], async observe(c, scope, method) {
      if (scope.binding?.kind !== "exact" || scope.binding.id !== "provider/a") return [];
      return [{source: "capabilities", scope, method, state: "known", observedAt: c.now, expiresAt: c.now + 60, value: {tools: true}}];
    }}],
  });
  expect(result.request.candidates.map(c => c.binding)).toEqual([{kind: "exact", id: "provider/a"}]);
});
test("MCP preview uses the running service instead of a separate process-local usage cache", async () => {
  const ctx = dispatchCtx();
  const daemon = Bun.serve({port: 0, hostname: "127.0.0.1", fetch(req) {
    if (new URL(req.url).pathname === "/health") return new Response("ok", {headers: {"x-pacer": "1"}});
    if (new URL(req.url).pathname === "/v3/ops/dispatch.preview" && req.headers.get("authorization") === "Bearer test-token") return Response.json({result: {marker: "authoritative-service"}});
    return new Response("bad request", {status: 400});
  }});
  ctx.env.PACER_PORT = String(daemon.port); writeFileSync(join(ctx.pacerHome, "token"), "test-token");
  const server = createMcpServer(() => ctx), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); const client = new Client({name: "test", version: "1"}); await client.connect(ct);
  try { expect((await client.callTool({name: "dispatch_preview", arguments: {repo: tmpDir(), goal: "check"}})).structuredContent).toEqual({marker: "authoritative-service"}); }
  finally {await client.close(); await server.close(); daemon.stop(true);}
});
