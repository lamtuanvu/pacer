import { toApiError } from "../src/api/protocol";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { createTask, listTasks, readTask, updateTask } from "../src/tasks/store";
import { runAttempt } from "../src/exec/direct";
import { loadStrategy } from "../src/config/strategy";
import { fakeCtx, gitRepo, realRun } from "./helpers";

async function setup() {
 const ctx=fakeCtx({run:realRun});
 mkdirSync(ctx.pacerHome,{recursive:true});
 await Bun.write(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  cursor: {}\n");
 return ctx;
}
const spawnRunner=()=>1;

test("request_id dedupes concurrent calls through 600 seconds and expires at 601",async()=>{
 const ctx=await setup(),repo=gitRepo(); let spawned=0;
 const params={goal:"test",repo,request_id:"ui/request..1"};
 const deps={spawnRunner:()=>{spawned++;return 1;}};
 const [a,b]=await Promise.all([callOp(ctx,"task.delegate",params,deps),callOp(ctx,"task.delegate",params,deps)]) as any[];
 expect(a.task_id).toBe(b.task_id);expect(spawned).toBe(1);
 expect((await callOp({...ctx,now:ctx.now+600},"task.delegate",params,deps) as any).task_id).toBe(a.task_id);
 expect((await callOp({...ctx,now:ctx.now+601},"task.delegate",params,deps) as any).task_id).not.toBe(a.task_id);
 expect(listTasks(ctx,Infinity)).toHaveLength(2);
});

test("a reused request_id with a different brief is a conflict, not the old task",async()=>{
 const ctx=await setup(),repo=gitRepo(),deps={spawnRunner:()=>1};
 await callOp(ctx,"task.delegate",{goal:"first",repo,request_id:"r-1"},deps);
 expect(await callOp(ctx,"task.delegate",{goal:"second",repo,request_id:"r-1"},deps).catch(e=>toApiError(e).code)).toBe("conflict");
});

test("delegate accepts repo keys and persists explicit and client-default source",async()=>{
 const ctx=await setup(),repo=gitRepo();
 const ref=await callOp(ctx,"repo.add",{path:repo}) as any;
 for(const [client,source] of [["desktop-v2","ui"],["app","ui"],["codex","planner"]]) {
  const result=await callOp(ctx,"task.delegate",{goal:"g",repo:ref.key},{client,spawnRunner}) as any;
  expect(readTask(ctx,result.task_id)).toMatchObject({source,brief:{repo:ref.path},repo:ref});
 }
 const result=await callOp(ctx,"task.delegate",{goal:"g",repo,source:"cli"},{client:"app",spawnRunner}) as any;
 expect(readTask(ctx,result.task_id)?.source).toBe("cli");
});

test("base starts the new worktree at the requested branch and rejects bad refs",async()=>{
 const ctx=await setup(),repo=gitRepo();
 await realRun(["git","-C",repo,"branch","release/1.2"],10000);
 writeFileSync(join(repo,"main.txt"),"main only");
 await realRun(["git","-C",repo,"add","."],10000);
 await realRun(["git","-C",repo,"-c","user.name=t","-c","user.email=t@t","commit","-qm","main"],10000);
 const result=await callOp(ctx,"task.delegate",{goal:"g",repo,base:"release/1.2",worktree:"new"},{spawnRunner}) as any;
 const task=readTask(ctx,result.task_id)!;
 const out=await runAttempt(ctx,{...loadStrategy(ctx).providers.cursor,id:"gemini"},task);
 expect(out.exec.code).toBe(127);
 expect((await realRun(["git","-C",readTask(ctx,task.id)!.worktree!,"rev-parse","HEAD"],10000)).stdout).toBe((await realRun(["git","-C",repo,"rev-parse","release/1.2"],10000)).stdout);
 await expect(callOp(ctx,"task.delegate",{goal:"g",repo,base:"bad ref"},{spawnRunner})).rejects.toMatchObject({code:"invalid_input"});
});

test("task.list filters before paging and keeps limit-only legacy arrays",async()=>{
 const ctx=await setup(),repo=gitRepo();
 const ref=await callOp(ctx,"repo.add",{path:repo}) as any;
 for(let i=0;i<5;i++) {
  const t=createTask({...ctx,now:ctx.now+i},{brief:{goal:String(i),repo},kind:null,requestedExecutor:"cursor",timeoutS:60});
  updateTask(ctx,t.id,t=>{t.repo=ref;t.state=i===0?"failed":"done";t.executor="cursor";});
 }
 const params={repo:ref.key,states:["done"],limit:2};
 const first=await callOp(ctx,"task.list",params) as any;
 expect(first.tasks).toHaveLength(2);expect(first.next).toBe(first.tasks[1].id);
 const second=await callOp(ctx,"task.list",{...params,before:first.next}) as any;
 expect(second.tasks).toHaveLength(2);expect(second.next).toBeNull();
 expect(new Set([...first.tasks,...second.tasks].map(t=>t.id)).size).toBe(4);
 expect((await callOp(ctx,"task.list",{executor:"absent"}) as any).tasks).toEqual([]);
 expect((await callOp(ctx,"task.list",{since:ctx.now+4}) as any).tasks).toHaveLength(1);
 expect(await callOp(ctx,"task.list",{limit:5})).toMatchObject({tasks:expect.any(Array),next:null});
});

test("routing.route classifies a goal and accepts a repo key",async()=>{
 const ctx=await setup(),repo=gitRepo(),ref=await callOp(ctx,"repo.add",{path:repo}) as any;
 expect(await callOp(ctx,"routing.route",{goal:"add tests for x",repo:ref.key})).toMatchObject({kind:"tests"});
 expect(await callOp(ctx,"routing.route",{kind:"docs",goal:"add tests for x"})).toMatchObject({kind:"docs"});
});


test("delegate validates request ids, sources and base refs before creating a task",async()=>{
 const ctx=await setup(),repo=gitRepo();
 for(const params of [{request_id:""},{request_id:"x".repeat(129)},{source:"other"},{base:"--help"},{base:"main\0other"},{base:"@{-1}"}]) {
  await expect(callOp(ctx,"task.delegate",{goal:"g",repo,...params},{spawnRunner})).rejects.toMatchObject({code:"invalid_input"});
 }
 expect(listTasks(ctx,Infinity)).toEqual([]);
});

test("delegating an absolute subfolder keeps its working directory",async()=>{
 const ctx=await setup(),repo=gitRepo(),sub=join(repo,"package");
 mkdirSync(sub);
 const result=await callOp(ctx,"task.delegate",{goal:"g",repo:sub},{spawnRunner}) as any;
 expect(readTask(ctx,result.task_id)!.brief.repo).toBe(sub);
});
