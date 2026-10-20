import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp, type OpDeps } from "../src/api/ops";
import { callV2Op, v2Hello } from "../src/api/v2-compat";
import { delegate } from "../src/core/tasks";
import { readTask, updateTask } from "../src/tasks/store";
import { apiTask, needsReview } from "../src/api/read-model/tasks";
import { buildToday } from "../src/api/read-model/summary";
import { doneToday } from "../src/view-model/selectors";
import { emptySnapshot } from "../src/link/envelope";
import type { TryResult } from "../src/onboarding/try";
import { fakeCtx, realRun } from "./helpers";

function fixture() {
 const ctx = fakeCtx({run: realRun});
 mkdirSync(ctx.pacerHome, {recursive: true});
 writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
 const deps: OpDeps = {onboardingRoute: async (_ctx, kind) => {
  expect(kind).toBe("docs");
  return {kind, ranked: [{id:"codex",score:0,verdict:"UNKNOWN",reason:"priority"}], excluded:[]};
 }, spawnRunner: () => undefined};
 return {ctx, deps};
}

test("onboarding.try commits the bundled README and delegates the fixed tagged brief", async () => {
 const {ctx, deps} = fixture(), spawned: string[] = [];
 const result = await callOp(ctx, "onboarding.try", {}, {...deps, spawnRunner: (_c,id) => {spawned.push(id);return 1;}, delegate: (c,input,spawn) => {
  expect(input).toMatchObject({source:"onboarding",kind:"docs",worktree:"current",timeoutMin:15,brief:{goal:"Summarize README.md in three bullet points into SUMMARY.md",acceptance:"test -s SUMMARY.md"}});
  expect(input.executor).toBeUndefined();
  return delegate(c,input,spawn);
 }}) as TryResult;
 expect(result.executor).toBe("codex"); expect(result.repo.startsWith(join(ctx.pacerHome,"onboarding","try-"))).toBe(true);
 expect(spawned).toEqual([result.task_id]);
 const git = async (...args:string[]) => (await realRun(["git","-C",result.repo,...args],10000)).stdout.trim();
 expect(await git("rev-list","--count","HEAD")).toBe("1");
 expect(await git("ls-tree","--name-only","HEAD")).toBe("README.md");
 expect(await git("status","--porcelain")).toBe("");
 const readme=readFileSync(join(result.repo,"README.md"),"utf8");
 expect(readme.trim().split("\n").length).toBeGreaterThanOrEqual(10);
 expect(readme.trim().split("\n").length).toBeLessThanOrEqual(15);
 expect(readme).not.toMatch(/\/(Users|Volumes)\//);
 const task=readTask(ctx,result.task_id)!;
 expect(task.source).toBe("onboarding"); expect(task.brief.repo).toBe(result.repo); expect(task.timeoutS).toBe(900);
 const second=await callOp(ctx,"onboarding.try",{},deps) as TryResult;
 expect(second.repo).not.toBe(result.repo);
});

test("onboarding.try refuses missing executors, executor sessions and v2", async () => {
 const {ctx,deps}=fixture();
 await expect(callOp(ctx,"onboarding.try",{}, {...deps,onboardingRoute:async()=>({kind:"docs",ranked:[],excluded:[]})})).rejects.toMatchObject({code:"unknown_executor",message:"Add an executor first"});
 expect(existsSync(join(ctx.pacerHome,"onboarding"))).toBe(false);
 await expect(callOp({...ctx,env:{PACER_ROLE:"executor"}},"onboarding.try",{},deps)).rejects.toMatchObject({code:"not_allowed"});
 await expect(callV2Op(ctx,"onboarding.try",{},deps)).rejects.toMatchObject({code:"unknown_op"});
 expect(v2Hello().ops).not.toContain("onboarding.try");
});

test("onboarding.try serializes starts and surfaces git failures without delegating", async () => {
 const {ctx,deps}=fixture(); let release!:()=>void,entered!:()=>void;
 const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const first=callOp(ctx,"onboarding.try",{}, {...deps,onboardingRoute:async(c,k)=>{entered();await gate;return deps.onboardingRoute!(c,k);}});
 await started;
 await expect(callOp(ctx,"onboarding.try",{},deps)).rejects.toMatchObject({code:"conflict"});
 release();await first;
 let delegated=false;
 await expect(callOp({...ctx,run:async()=>({code:1,stdout:"",stderr:"git unavailable"})},"onboarding.try",{}, {...deps,delegate:()=>{delegated=true;throw Error("unexpected");}})).rejects.toMatchObject({code:"invalid_input",message:"Could not create the first delegation repository"});
 expect(delegated).toBe(false);
});

test("onboarding tasks stay reviewable and listed but do not count as finished today", async () => {
 const {ctx,deps}=fixture(),result=await callOp(ctx,"onboarding.try",{},deps) as TryResult;
 const record=updateTask(ctx,result.task_id,t=>{t.state="done";});
 const task=apiTask(ctx,record),today=buildToday(ctx,[task]);
 expect(today.done).toBe(0);expect(today.byRepo).toEqual({});expect(needsReview(task)).toBe(true);
 expect(doneToday({...emptySnapshot(),tasks:[task],today},{repo:null})).toEqual([]);
 expect(await callOp(ctx,"task.list",{},deps)).toMatchObject({tasks:[expect.objectContaining({id:record.id,source:"onboarding"})]});
 const normal={...task,source:undefined};expect(buildToday(ctx,[normal]).done).toBe(1);
 expect(readdirSync(join(ctx.pacerHome,"onboarding"))).toHaveLength(1);
});

test("TUI Try it requires a ranked executor and reports the started task", async () => {
 const {setupChecklist}=await import("../src/setup/checklist");
 const {setupAct}=await import("../src/dashboard/screens/setup");
 const {Dashboard}=await import("../src/dashboard/controller");
 const {PLAIN_THEME}=await import("../src/dashboard/theme");
 const {emptySnapshot}=await import("../src/link/envelope");
 const facts={version:"test",planner:"claude-code",service:{installed:true,running:true},link:true,live:false,agents:[]};
 const ops=["onboarding.try","onboarding.skip"],supports=(op:string)=>ops.includes(op);
 const first=(c:ReturnType<typeof setupChecklist>)=>setupAct(c,c.items.find(i=>i.id==="first")!,supports);
 expect(first(setupChecklist(facts,0))).toBeUndefined();
 const checklist=setupChecklist({...facts,executors:{ranked:[{id:"codex"}],excluded:[]}},0);
 const act=first(checklist)!;expect(act.effect).toMatchObject({type:"action",action:{op:"onboarding.try",params:{}}});
 const frames:string[]=[];
 const dash=new Dashboard({client:{kind:"inprocess",hello:async()=>({ops}),snapshot:async()=>({seq:1,snapshot:emptySnapshot()}),call:async<T>()=>({task_id:"t-first",executor:"codex"}) as T,subscribe:()=>()=>{},close(){}} as any,
  theme:PLAIN_THEME,version:"t",cwd:"/tmp",now:()=>0,size:()=>({width:120,height:30}),write:f=>frames.push(f)});
 await dash.run(act.effect);
 expect(frames.at(-1)).toContain("Started t-first on codex. Review it when it finishes.");
});

test("retry keeps the onboarding source and fixed exercise settings", async () => {
 const {ctx,deps}=fixture(),started=await callOp(ctx,"onboarding.try",{},deps) as TryResult;
 updateTask(ctx,started.task_id,t=>{t.state="failed";});
 const result=await callOp(ctx,"task.retry",{id:started.task_id,executor:"codex"},deps) as {retry:{task_id:string}};
 expect(readTask(ctx,result.retry.task_id)).toMatchObject({source:"onboarding",kind:"docs",timeoutS:900,placement:{requested:"current"},retryOf:started.task_id});
});

test("onboarding.try uses normal routing to detect a planner-only setup", async () => {
 const {ctx}=fixture();
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: codex\nproviders:\n  codex: {}\n");
 await expect(callOp({...ctx,which:()=>null},"onboarding.try",{},{spawnRunner:()=>{throw Error("must not spawn");}})).rejects.toMatchObject({code:"unknown_executor",message:"Add an executor first"});
});

 test("onboarding scratch repository inherits global routing when another project has a policy", async () => {
  const { ctx, deps } = fixture();
  const { writeProjectStrategy } = await import("../src/config/project-strategies");
  await writeProjectStrategy(ctx, "local:0123456789ab", ["cursor#cursor@local"], 0);
  const result = await callOp(ctx, "onboarding.try", {}, deps) as TryResult;
  expect(readTask(ctx, result.task_id)!.repo?.identityUnverified).not.toBe(true);
  expect(readTask(ctx, result.task_id)!.repo?.path).toBe((await import("node:fs")).realpathSync(result.repo));
 });
