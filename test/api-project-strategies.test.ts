import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { eventsSince } from "../src/api/events";
import { readTask, createTask, updateTask } from "../src/tasks/store";
import { resolveRepo } from "../src/core/repos";
import { fakeCtx, gitRepo, realRun, withLoginIndicators } from "./helpers";

async function setup() {
  const ctx = withLoginIndicators(fakeCtx({home:gitRepo(),run:realRun})); mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\n");
  return { ctx, repo: await resolveRepo(ctx, ctx.home) };
}
test("API persists qualified ordered identities and CAS removal", async () => {
  const { ctx, repo } = await setup();
  expect(await callOp(ctx, "project.strategy.get", { repo: ctx.home })).toMatchObject({ rev: 0, executors: null });
  expect(await callOp(ctx, "project.strategy.set", { repo: ctx.home, executors: ["cursor", "codex"], expect_rev: 0 })).toMatchObject({ rev: 1, executors: ["cursor#cursor@local", "codex#codex@local"] });
  expect(await callOp(ctx, "project.strategy.list", {})).toMatchObject([{ repo: { key: repo.key }, rev: 1 }]);
  await expect(callOp(ctx, "project.strategy.set", { repo: repo.key, executors: ["codex"], expect_rev: 0 })).rejects.toMatchObject({ code: "conflict" });
  expect(await callOp(ctx, "project.strategy.remove", { repo: repo.key, expect_rev: 1 })).toMatchObject({ rev: 2, executors: null });
});
test("mutations require revisions and publish only successful commits", async () => {
  const { ctx } = await setup();
  for (const executors of [[], ["unknown"], ["claude-code"], ["codex", "codex#codex@local"]]) await expect(callOp(ctx, "project.strategy.set", { repo: ctx.home, executors, expect_rev: 0 })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(callOp(ctx, "project.strategy.set", { repo: ctx.home, executors: ["codex"] })).rejects.toMatchObject({ code: "invalid_input" });
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config")).toHaveLength(0);
  await callOp(ctx, "project.strategy.set", { repo: ctx.home, executors: ["codex"], expect_rev: 0 });
  expect(eventsSince(ctx, 0).events.filter(e => e.type === "config")).toHaveLength(1);
});
test("forbidden API delegation and retry do not spawn or alter the source task", async () => {
  const { ctx, repo } = await setup();
  await callOp(ctx, "project.strategy.set", { repo: ctx.home, executors: ["cursor"], expect_rev: 0 });
  let spawned = 0; const deps = { spawnRunner: () => { spawned++; return 1; } };
  await expect(callOp(ctx, "task.delegate", { goal: "work", repo: ctx.home, executor: "codex" }, deps)).rejects.toMatchObject({ code: "not_allowed" });
  const t = createTask(ctx, { brief: { goal: "old", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const before = updateTask(ctx, t.id, x => { x.repo = repo; x.state = "failed"; });
  await expect(callOp(ctx, "task.retry", { id: t.id, executor: "codex" }, deps)).rejects.toMatchObject({ code: "not_allowed" });
  expect(readTask(ctx, t.id)).toEqual(before); expect(spawned).toBe(0);
});
test("corrupt policy preserves stored task detail while suppressing retry actions", async () => {
  const { ctx, repo } = await setup();
  const t = createTask(ctx, { brief: { goal: "evidence", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const before = updateTask(ctx, t.id, x => { x.repo = repo; x.state = "failed"; });
  writeFileSync(join(ctx.pacerHome, "project-strategies.json"), "{broken");
  const detail = await callOp(ctx, "task.get", { id: t.id });
  expect(detail).toMatchObject({ brief: { goal: "evidence" }, retryOptions: [], policyError: expect.stringContaining("Invalid project strategies") });
  expect(readTask(ctx, t.id)).toEqual(before);
  await expect(callOp(ctx, "task.retry_options", { id: t.id })).rejects.toMatchObject({ code: "invalid_input" });
});

test("repo preview and retry options use the allowlist while no-repo preview stays global", async () => {
  const { ctx, repo } = await setup();
  await callOp(ctx, "project.strategy.set", { repo: ctx.home, executors: ["cursor"], expect_rev: 0 });
  const route = await callOp(ctx, "routing.route", { repo: ctx.home }) as { policy?: unknown; ranked: {id:string}[]; excluded: {id:string}[] };
  expect(route.policy).toMatchObject({ repoKey: repo.key, rev: 1 });
  expect([...route.ranked, ...route.excluded].map(r => r.id)).toEqual(["cursor"]);
  expect(await callOp(ctx, "routing.route", {})).not.toHaveProperty("policy");
  const t = createTask(ctx, { brief: { goal: "work", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.repo = repo; x.state = "failed"; });
  expect((await callOp(ctx, "task.retry_options", {id:t.id}) as {id:string}[]).map(r=>r.id)).toEqual(["cursor"]);
});
test("orphan policy keys remain readable and removable without Git", async () => {
  const { ctx } = await setup();
  const { writeProjectStrategy } = await import("../src/config/project-strategies");
  const key = "github.com/example/missing";
  await writeProjectStrategy(ctx, key, ["cursor#cursor@local"], 0);
  ctx.run = async () => { throw Error("must not probe Git for an orphan key"); };
  expect(await callOp(ctx, "project.strategy.get", {repo:key})).toMatchObject({repo:{key},rev:1});
  expect(await callOp(ctx, "project.strategy.remove", {repo:key,expect_rev:1})).toMatchObject({rev:2,executors:null});
});

test("new delegation and preview fail closed on inconclusive Git identity", async () => {
  const {ctx}=await setup();
  await callOp(ctx,"project.strategy.set",{repo:ctx.home,executors:["cursor"],expect_rev:0});
  ctx.run=async()=>({code:128,stdout:"",stderr:"Git unavailable"});
  for (const [op,params] of [["task.delegate",{goal:"work",repo:ctx.home,executor:"codex"}],["routing.route",{repo:ctx.home}]] as const) {
    await expect(callOp(ctx,op,params,{spawnRunner:()=>{throw Error("must not spawn");}})).rejects.toMatchObject({code:"invalid_input",message:expect.stringContaining("Cannot establish repository identity")});
  }
});

test("unresolved legacy retry choices are suppressed with an actionable diagnostic", async()=>{
  const {ctx,repo}=await setup();
  await callOp(ctx,"project.strategy.set",{repo:ctx.home,executors:["cursor"],expect_rev:0});
  const task=createTask(ctx,{brief:{goal:"legacy",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
  updateTask(ctx,task.id,t=>{t.state="failed";});
  await callOp(ctx,"repo.remove",{key:repo.key});
  await expect(callOp(ctx,"task.retry_options",{id:task.id})).rejects.toMatchObject({code:"invalid_input"});
  expect(await callOp(ctx,"task.get",{id:task.id})).toMatchObject({retryOptions:[],policyError:expect.stringContaining("Cannot establish repository identity")});
  const {apiTask}=await import("../src/api/read-model/tasks");
  const {retryTargetFor}=await import("../src/api/read-model");
  const {loadStrategy}=await import("../src/config/strategy");
  const {readProjectStrategies}=await import("../src/config/project-strategies");
  const model=apiTask(ctx,readTask(ctx,task.id)!);
  expect(model.repo.identityUnverified).toBe(true);
  expect(retryTargetFor(model,loadStrategy(ctx),[{id:"codex",enabled:true,rank:1,state:"ready",slots:{used:0,max:1}} as any],readProjectStrategies(ctx))).toBeNull();
});

test("saving policy cannot manufacture identity after a failed Git probe",async()=>{
  const {ctx}=await setup();
  ctx.run=async()=>({code:128,stdout:"",stderr:"unavailable"});
  await expect(callOp(ctx,"project.strategy.set",{repo:ctx.home,executors:["cursor"],expect_rev:0})).rejects.toMatchObject({code:"invalid_input"});
  expect(await callOp(ctx,"project.strategy.list",{})).toEqual([]);
});
