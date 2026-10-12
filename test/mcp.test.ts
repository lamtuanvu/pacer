import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server";
import { readLabels } from "../src/tasks/labels";
import { updateTask } from "../src/tasks/store";
import { readMarks } from "../src/usage/reactive";
import { fakeCtx, tmpDir } from "./helpers";

// codex: reactive so a fresh test home (no Codex logs) does not make it UNKNOWN, which would move it below cursor
const STRATEGY = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: { usage: reactive }\n  cursor: {}\n";

async function connect() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), STRATEGY);
  const spawned: string[] = [];
  const server = createMcpServer(() => ctx, { spawnRunner: (_c, id) => { spawned.push(id); return 1; } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  return { ctx, client, call, spawned };
}

test("lists exactly the nine planner tools", async () => {
  const { client } = await connect();
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
    "budget_status", "delegate", "guard_feedback", "report_limit", "route", "task_review", "task_status", "task_stop", "task_wait",
  ]);
});

test("budget_status and route return structured data in priority order", async () => {
  const { call } = await connect();
  const b = await call("budget_status");
  expect(b.structuredContent.planner).toBe("claude-code");
  const r = await call("route", { kind: "debug" });
  expect(r.structuredContent.ranked.map((e: { id: string }) => e.id)).toEqual(["codex", "cursor"]);
  expect(r.structuredContent.excluded).toContainEqual({ id: "claude-code", reason: "planner" });
});

test("delegate queues a task and task_status/task_wait/task_stop work on it", async () => {
  const { ctx, call, spawned } = await connect();
  const d = await call("delegate", { goal: "Fix add()", repo: tmpDir(), kind: "debug", acceptance: "true", timeout_min: 5 });
  expect(d.isError).toBeFalsy();
  const id = d.structuredContent.task_id;
  expect(spawned).toEqual([id]);
  expect(d.structuredContent).toMatchObject({ state: "queued", kind: "debug" });
  expect((await call("task_status", { task_id: id })).structuredContent.state).toBe("queued");
  updateTask(ctx, id, (t) => { t.state = "done"; });
  expect((await call("task_wait", { task_id: id, timeout_s: 1 })).structuredContent.state).toBe("done");
  expect((await call("task_stop", { task_id: id })).structuredContent.state).toBe("done");
});

test("bad delegate is isError and unknown task ids are isError", async () => {
  const { call } = await connect();
  const bad = await call("delegate", { goal: "x", repo: "relative" });
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain("repo must be an absolute path");
  expect((await call("task_status", { task_id: "../etc" })).isError).toBe(true);
});

test("report_limit marks exhaustion; task_review and guard_feedback record labels", async () => {
  const { ctx, call } = await connect();
  const lim = await call("report_limit", { provider: "cursor" });
  expect(lim.structuredContent.exhausted_until).toBe(ctx.now + 21600);
  expect(readMarks(ctx).cursor).toBe(ctx.now + 21600);
  expect((await call("report_limit", { provider: "nope" })).isError).toBe(true);
  const d = await call("delegate", { goal: "g", repo: tmpDir() });
  await call("task_review", { task_id: d.structuredContent.task_id, accepted: false, kind: "refactor", note: "wrong file" });
  await call("guard_feedback", { event_id: "e-1", correct: true });
  const labels = readLabels(ctx);
  expect(labels[0]).toMatchObject({ type: "task_review", task_id: d.structuredContent.task_id, accepted: false, kind: "refactor", note: "wrong file" });
  expect(labels[1]).toMatchObject({ type: "guard_feedback", event_id: "e-1", correct: true });
});

test("executor MCP sessions cannot delegate onward", async () => {
  const { ctx, call, spawned, client } = await connect();
  ctx.env.PACER_ROLE = "executor";
  const result = await call("delegate", { goal: "Loop work", repo: tmpDir() });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("PACER_ROLE=executor");
  expect(spawned).toEqual([]);
  await client.close();
});
