import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server";
import { readLabels } from "../src/tasks/labels";
import { readTask, updateTask } from "../src/tasks/store";
import { readMarks } from "../src/usage/reactive";
import { fakeCtx, tmpDir } from "./helpers";
import pkg from "../package.json";

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

test("lists planner and strategy tools", async () => {
  const { client } = await connect();
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
    "budget_status", "delegate", "guard_feedback", "report_limit", "route", "task_answer", "task_review", "task_status", "task_stop", "task_wait",
    "strategy_list", "strategy_preview", "strategy_save", "strategy_show", "strategy_use",
  ].sort());
});

test("task_answer retries a question with text and revision checks", async()=>{
  const {ctx,call,spawned,client}=await connect();
  const d=await call("delegate",{goal:"g",repo:tmpDir(),executor:"codex"});
  const id=d.structuredContent.task_id;
  const task=updateTask(ctx,id,t=>{t.state="needs_input";t.question={text:"which db?",at:ctx.now};});
  expect((await call("task_status",{task_id:id})).structuredContent.question).toEqual(task.question);
  expect((await call("task_answer",{task_id:id,text:"postgres",expect_rev:task.rev-1})).isError).toBe(true);
  const r=await call("task_answer",{task_id:id,text:"postgres",expect_rev:task.rev});
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent.task.question.answer).toBe("postgres");
  expect(readTask(ctx,r.structuredContent.retry.id)?.brief.qa).toEqual([{q:"which db?",a:"postgres"}]);
  expect(spawned).toEqual([id,r.structuredContent.retry.id]);
  expect((await call("task_answer",{task_id:id,text:"again"})).isError).toBe(true);
  await client.close();
});

test("budget_status and route return structured data in priority order", async () => {
  const { call } = await connect();
  const b = await call("budget_status");
  expect(b.structuredContent.planner).toBe("claude-code");
  const r = await call("route", { kind: "debug" });
  expect(r.structuredContent.ranked.map((e: { id: string }) => e.id)).toEqual(["codex", "cursor"]);
  expect(r.structuredContent.excluded).toContainEqual({ id: "claude-code", account: "claude-code", reason: "planner" });
});

test("delegate queues a task and task_status/task_wait/task_stop work on it", async () => {
  const { ctx, call, spawned } = await connect();
  const d = await call("delegate", { goal: "Fix add()", repo: tmpDir(), kind: "debug", acceptance: "true", timeout_min: 5 });
  expect(d.isError).toBeFalsy();
  const id = d.structuredContent.task_id;
  expect(spawned).toEqual([id]);
  expect(readTask(ctx,id)?.source).toBe("planner");
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
  updateTask(ctx, d.structuredContent.task_id, t => { t.state = "done"; });
  await call("task_review", { task_id: d.structuredContent.task_id, accepted: false, kind: "refactor", note: "wrong file" });
  await call("guard_feedback", { event_id: "e-1", correct: true });
  expect(readTask(ctx,d.structuredContent.task_id)).toMatchObject({resolved:"reviewed",review:{accepted:false,kind:"refactor",note:"wrong file"}});
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

test("Orca executor cwd refuses onward delegation without an environment marker", async () => {
  const { ctx, call, spawned, client } = await connect();
  const cwd = process.cwd();
  const worktree = join(ctx.home, "orca/workspaces/repo/pacer-t-20261011-140500-abcd-codex/src");
  mkdirSync(worktree, { recursive: true });
  try {
    process.chdir(worktree);
    const result = await call("delegate", { goal: "Loop", repo: ctx.home });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot delegate onward");
    expect(spawned).toEqual([]);
  } finally { process.chdir(cwd); await client.close(); }
});

test("strategy MCP schemas and structured preview/save/show/use results",async()=>{
 const {call,client}=await connect();
 const tools=(await client.listTools()).tools.filter(t=>t.name.startsWith("strategy_"));
 expect(tools).toHaveLength(5);for(const tool of tools){expect(tool.description).toContain("preview first");expect(tool.description).toContain("Never switch unless asked");}
 const draft={from:"default",set:{"pacing.planner_reserve":25},description:"Protect planner"};
 const preview=await call("strategy_preview",{draft});expect(preview.structuredContent.ok).toBe(true);expect(preview.structuredContent.ranking.current).toEqual(["codex","cursor"]);
 expect((await call("strategy_save",{name:"protect",draft,reason:"Approved"})).structuredContent.active).toBe(false);
 expect((await call("strategy_show",{name:"protect"})).structuredContent.summary).toContain("25%");
 expect((await call("strategy_list")).structuredContent.strategies).toHaveLength(2);
 expect((await call("strategy_use",{name:"protect"})).isError).toBeFalsy();expect((await call("strategy_show",{name:"protect"})).structuredContent.active).toBe(true);
 expect((await call("strategy_save",{name:"protect",draft,reason:"Approved"})).isError).toBe(true);
 expect((await call("strategy_save",{name:"../unsafe",draft,reason:"Approved"})).isError).toBe(true);
 expect((await call("strategy_preview",{draft:{...draft,set:{"pacing.policy":"invalid"}}})).structuredContent.ok).toBe(false);await client.close();
});

test("MCP active overwrite exposes approval and uses option names in errors",async()=>{
 const {call,client}=await connect();
 const tool=(await client.listTools()).tools.find(t=>t.name==="strategy_save")!;
 expect(tool.description).toContain("activeOk");expect(tool.description).toContain("live routing");
 const draft={from:"default"};await call("strategy_save",{name:"active",draft,reason:"approved"});await call("strategy_use",{name:"active"});
 const duplicate=await call("strategy_save",{name:"active",draft,reason:"approved"});expect(duplicate.structuredContent.error).toContain("overwrite:true");
 const refused=await call("strategy_save",{name:"active",draft,reason:"approved",overwrite:true});expect(refused.isError).toBe(true);expect(refused.structuredContent.error).toContain("activeOk:true");
 expect((await call("strategy_save",{name:"active",draft,reason:"approved",overwrite:true,activeOk:true})).isError).toBeFalsy();await client.close();
});

test("delegate placement schema validates and task_status exposes resolution",async()=>{
 const {ctx,call,client}=await connect();
 const tools=(await client.listTools()).tools, schema=tools.find(t=>t.name==="delegate")!.inputSchema;
 expect(schema.properties).toHaveProperty("worktree");expect(schema.properties).toHaveProperty("worktree_reason");
 for(const args of [{worktree:"bad"},{worktree_reason:"x".repeat(201)}])expect((await call("delegate",{goal:"g",repo:tmpDir(),...args})).isError).toBe(true);
 const queued=await call("delegate",{goal:"g",repo:tmpDir(),worktree:"current",worktree_reason:"follow-up"});
 const id=queued.structuredContent.task_id;expect(queued.structuredContent.placement).toEqual({requested:"current",reason:"follow-up"});
 updateTask(ctx,id,t=>{t.placement={...t.placement!,mode:"current",why:"agent: follow-up"};});
 expect((await call("task_status",{task_id:id})).structuredContent.placement).toMatchObject({mode:"current",why:"agent: follow-up"});
 await client.close();
});

test("the MCP server reports pacer's package version", async () => {
  const { client } = await connect();
  expect(client.getServerVersion()).toMatchObject({ name: "pacer", version: pkg.version });
});


test("task_review supports verdicts and retries with the configured runner", async () => {
  const { ctx, call, spawned, client } = await connect();
  const d = await call("delegate", { goal: "g", repo: tmpDir() });
  const id = d.structuredContent.task_id;
  updateTask(ctx, id, t => { t.state = "done"; });
  const r = await call("task_review", { task_id: id, verdict: "retry", executor: "cursor#cursor" });
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent.task.review.accepted).toBe(false);
  expect(readTask(ctx, r.structuredContent.retry.id)?.requestedExecutor).toBe("cursor");
  expect(spawned).toEqual([id, r.structuredContent.retry.id]);
  await client.close();
});
