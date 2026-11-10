import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server";
import { parseDelegateBrief, summarizeTask } from "../src/tasks/api";
import { callOp } from "../src/api/ops";
import { listTasks, readTask } from "../src/tasks/store";
import { getWork } from "../src/dispatch/work";
import { cliDeps, main } from "../src/cli";
import { fakeCtx, gitRepo, realRun, withLoginIndicators } from "./helpers";

async function setup() {
  const ctx = fakeCtx({run: realRun});
  mkdirSync(ctx.pacerHome, {recursive: true});
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  cursor: {}\n");
  return ctx;
}
const warning = {code: "difficulty_missing", field: "difficulty", values: ["simple", "standard", "complex"]};
test("brief parses difficulty and model, accepts equal alias, rejects conflict", () => {
  expect(parseDelegateBrief({goal: "g", difficulty: "complex", model: "m"}, "/tmp")).toMatchObject({difficulty: "complex", model: "m"});
  expect(parseDelegateBrief({goal: "g", difficulty: "simple", dispatch: {difficulty: "simple"}}, "/tmp").difficulty).toBe("simple");
  expect(parseDelegateBrief({goal: "g", dispatch: {difficulty: "complex"}}, "/tmp").difficulty).toBe("complex");
  expect(() => parseDelegateBrief({goal: "g", difficulty: "simple", dispatch: {difficulty: "complex"}}, "/tmp")).toThrow("Give difficulty once: top-level difficulty and dispatch.difficulty differ");
  expect(parseDelegateBrief({goal: "g", difficulty: "complex", dispatch: {}}, "/tmp").difficulty).toBe("complex");
});
test("omission records unspecified and warns through API", async () => {
  const ctx = await setup();
  const result = await callOp(ctx, "task.delegate", {goal: "g", repo: gitRepo(), dispatch: {}}, {spawnRunner: () => 1}) as any;
  expect(result.warnings).toEqual([warning]);
  expect(readTask(ctx, result.task_id)).toMatchObject({difficulty: "standard", difficultySource: "unspecified"});
  expect(getWork(ctx, result.task_id)?.options.difficulty).toBe("standard");
});
test("CLI flags override brief and omission warning goes to stderr", async () => {
  const ctx = await setup(), repo = gitRepo(), file = join(ctx.home, "brief.json");
  writeFileSync(file, JSON.stringify({goal: "g", repo, difficulty: "simple", model: "old"}));
  const original = cliDeps.spawnRunner;
  cliDeps.spawnRunner = () => 1;
  try {
    const result = await main(["delegate", "--brief-file", file, "--difficulty", "complex", "--model", "new", "--executor", "cursor", "--json"], ctx);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({difficulty: "complex", model: "new"});
    const omitted = await main(["delegate", "--goal", "g", "--repo", repo, "--json"], ctx);
    expect(omitted.code).toBe(0);
    expect(JSON.parse(omitted.err)).toEqual(warning);
  } finally { cliDeps.spawnRunner = original; }
});
test("invalid declared model pin fails before task or worktree creation", async () => {
  const ctx = await setup(), repo = gitRepo();
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\naccounts:\n  anthropic: {kind: claude}\n  cursor: {kind: cursor}\nrunners:\n  claude-code: {}\n  cursor:\n    models: [{id: allowed, tier: small}]\n");
  let spawned = false;
  withLoginIndicators(ctx);
  for (const executor of ["cursor", undefined]) {
    await expect(callOp(ctx, "task.delegate", {goal: "g", kind: "tests", repo, executor, model: "wrong", worktree: "new"}, {spawnRunner: () => {spawned = true; return 1;}})).rejects.toMatchObject({code: "invalid_input", message: 'Model "wrong" is not declared by executor "cursor"'});
  }
  expect(listTasks(ctx, Infinity)).toEqual([]);
  expect(spawned).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "worktrees"))).toBe(false);
  const accepted = await callOp(ctx, "task.delegate", {goal: "g", repo, executor: "cursor", model: "allowed", difficulty: "simple"}, {spawnRunner: () => 1}) as any;
  expect(accepted.model).toBe("allowed");
  expect(accepted.warnings).toBeUndefined();
});
test("both MCP delegate schemas expose difficulty and model", async () => {
  for (const grant of [false, true]) {
    const ctx = fakeCtx({env: grant ? {PACER_WORK_GRANT: "fixture"} : {}});
    const server = createMcpServer(() => ctx), client = new Client({name: "test", version: "1"});
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const tool = (await client.listTools()).tools.find(t => t.name === "delegate")!;
      expect(tool.inputSchema.properties?.difficulty).toMatchObject({enum: ["simple", "standard", "complex"]});
      expect(tool.inputSchema.properties?.model).toMatchObject({type: "string"});
    } finally { await client.close(); await server.close(); }
  }
});

test("model aliases must agree", () => {
  expect(() => parseDelegateBrief({goal: "g", model: "one", dispatch: {model: "two"}}, "/tmp"))
    .toThrow("Give model once: top-level model and dispatch.model differ");
  expect(parseDelegateBrief({goal: "g", dispatch: {model: "one"}}, "/tmp").model).toBe("one");
});

test("difficulty warning appears only on creation", async () => {
  const ctx = await setup();
  const result = await callOp(ctx, "task.delegate", {goal: "g", repo: gitRepo()}, {spawnRunner: () => 1}) as any;
  expect(result.warnings).toEqual([warning]);
  expect(summarizeTask(readTask(ctx, result.task_id)!)).not.toHaveProperty("warnings");
});

test("saving only model choices from built-in dispatch defaults keeps plain delegation", async () => {
  const {saveTierTargets} = await import("../app/src/screens/settings/DispatcherModelChoice");
  const ctx = await setup();
  const saved = await callOp(ctx, "dispatch.config.get", {}) as any;
  await saveTierTargets(((op: any, params: any) => callOp(ctx, op, params)) as any, saved,
    {simple: "medium", standard: "medium", complex: "frontier"}, "choices");
  const result = await callOp(ctx, "task.delegate", {goal: "plain", repo: gitRepo()}, {spawnRunner: () => 1}) as any;
  expect(getWork(ctx, result.task_id)).toBeNull();
});
