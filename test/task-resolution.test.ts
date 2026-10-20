import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolutionReason, resolveTask } from "../src/tasks/resolution";
import { taskReview } from "../src/tasks/api";
import { createTask, updateTask, readTask } from "../src/tasks/store";
import { fakeCtx, tmpDir, realRun } from "./helpers";
import { taskData, pumpOnce } from "../src/link/pump";
import { emptySnapshot, parseOutboxEvent } from "../src/link/envelope";

function setup(){const ctx=fakeCtx({run:realRun}),repo=tmpDir(),worker=join(ctx.home,"worker");
 const git=(...a:string[])=>execFileSync("git",["-C",repo,...a],{stdio:"pipe"});
 git("init","-b","main");git("config","user.email","test@example.com");git("config","user.name","Test");
 writeFileSync(join(repo,"tracked"),"base\n");git("add",".");git("commit","-m","base");git("worktree","add","-b","worker",worker);
 const t=createTask(ctx,{brief:{goal:"g",repo},kind:null,requestedExecutor:null,timeoutS:60});
 const task=updateTask(ctx,t.id,x=>{x.state="partial";x.worktree=worker;x.baseBranch="main";});return {ctx,repo,worker,git,task};}
test("unlanded diff stays visible; tracked and untracked bytes clear when base contains them",async()=>{
 const {ctx,repo,worker,git,task}=setup();writeFileSync(join(worker,"tracked"),"changed\n");writeFileSync(join(worker,"new"),"new\n");
 expect(await resolutionReason(ctx,task)).toBeNull();writeFileSync(join(repo,"tracked"),"changed\n");writeFileSync(join(repo,"new"),"new\n");git("add",".");git("commit","-m","landed");
 expect(await resolutionReason(ctx,task)).toBe("already on main");const resolved=await resolveTask(ctx,task);expect(readTask(ctx,task.id)?.resolved).toBe("already on main");
 expect(taskData(resolved)).toMatchObject({resolved:"already on main"});
});
test("worker commits and deleted files are compared; differing untracked content prevents resolution",async()=>{
 const {ctx,repo,worker,git,task}=setup();execFileSync("git",["-C",worker,"rm","tracked"]);execFileSync("git",["-C",worker,"commit","-m","delete"]);
 expect(await resolutionReason(ctx,task)).toBeNull();git("rm","tracked");git("commit","-m","delete landed");expect(await resolutionReason(ctx,task)).toBe("already on main");
 writeFileSync(join(worker,"extra"),"pending");expect(await resolutionReason(ctx,task)).toBeNull();
});
test("an empty worker diff and in-place runs never count as landed",async()=>{
 const {ctx,repo,task}=setup();expect(await resolutionReason(ctx,task)).toBeNull();
 expect(await resolutionReason(ctx,{...task,worktree:repo})).toBeNull();
 expect(await resolutionReason(ctx,{...task,placement:{requested:"current",mode:"current",why:"agent: x"}})).toBeNull();
});
test("removed worktree and both review verdicts settle attention and roundtrip",async()=>{
 const {ctx,worker,task}=setup();rmSync(worker,{recursive:true});expect((await resolveTask(ctx,task)).resolved).toBe("worktree removed");
 for(const accepted of [true,false]){taskReview(ctx,task.id,accepted);const data=taskData(readTask(ctx,task.id)!);expect(parseOutboxEvent({type:"task",data})?.data).toMatchObject({review:{accepted},resolved:"reviewed"});}
});
test("resolution checks stay in memory and are limited to once per task per minute",async()=>{
 const {ctx,worker,task}=setup();writeFileSync(join(worker,"tracked"),"pending");const checked=await resolveTask(ctx,task);expect(checked.resolved).toBeUndefined();
 expect(readTask(ctx,task.id)?.rev).toBe(task.rev);
 rmSync(worker,{recursive:true});expect((await resolveTask({...ctx,now:ctx.now+59},checked)).resolved).toBeUndefined();expect((await resolveTask({...ctx,now:ctx.now+60},checked)).resolved).toBe("worktree removed");
});

test("pump exposes terminal presence only after a live Orca terminal receipt",async()=>{
 const {updateOrcaState}=await import("../src/exec/orca/state");
 const ctx=fakeCtx({run:realRun}),task=createTask(ctx,{brief:{goal:"g",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 updateOrcaState(ctx,s=>{s.workers.d={dispatchId:"d",taskId:task.id,terminal:"term_worker",executor:"codex",worktree:null,startedAt:0};});
 for(const connected of [true,false]){
  ctx.now+=1; // Session metadata changes are published at most once per second.
  ctx.run=async()=>({code:0,stdout:JSON.stringify({ok:true,result:{terminal:{handle:"term_worker",connected,writable:true}}}),stderr:""});
  const events=await pumpOnce(ctx,{tasks:()=>[task],status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"claude-code",mode:"normal",disabled: false, paused: null, modeHold: null,calendarPace:true,providers:[],executors:{ranked:[],excluded:[]}}),publish:(await import("../src/link/publish")).publish});
  expect(events.find(e=>e.type==="task")?.data).toMatchObject({terminalPresent:connected});
 }
});
test("pump persists and publishes settled attention",async()=>{
 const {ctx,worker,task}=setup();rmSync(worker,{recursive:true});
 const events=await pumpOnce(ctx,{tasks:()=>[task],status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"claude-code",mode:"normal",disabled: false, paused: null, modeHold: null,calendarPace:true,providers:[],executors:{ranked:[],excluded:[]}}),publish:(await import("../src/link/publish")).publish});
 expect(events.find(e=>e.type==="task")?.data).toMatchObject({resolved:"worktree removed"});expect(readTask(ctx,task.id)).toMatchObject({resolved:"worktree removed"});
});
test("subdirectory task worktrees compare paths from the Git root",async()=>{
 const {ctx,repo,worker,git,task}=setup();mkdirSync(join(repo,"sub"));writeFileSync(join(repo,"sub/tracked"),"old\n");git("add",".");git("commit","-m","subdir");
 execFileSync("git",["-C",worker,"merge","--ff-only","main"],{stdio:"pipe"});mkdirSync(join(worker,"sub"),{recursive:true});task.worktree=join(worker,"sub");
 writeFileSync(join(worker,"sub/tracked"),"new\n");writeFileSync(join(worker,"sub/untracked"),"extra\n");expect(await resolutionReason(ctx,task)).toBeNull();
 writeFileSync(join(repo,"sub/tracked"),"new\n");writeFileSync(join(repo,"sub/untracked"),"extra\n");git("add",".");git("commit","-m","land subdir");expect(await resolutionReason(ctx,task)).toBe("already on main");
});


test("binary worktree bytes resolve only when the base contains the same blob", async () => {
 const {ctx,repo,worker,git,task}=setup();
 const bytes=Buffer.from([0,255,254,128,10]);
 writeFileSync(join(worker,"tracked"),bytes);
 expect(await resolutionReason(ctx,task)).toBeNull();
 writeFileSync(join(repo,"tracked"),bytes);git("add",".");git("commit","-m","land binary");
 expect(await resolutionReason(ctx,task)).toBe("already on main");
});

test("a hung git read does not resolve and is retried after the throttle window", async () => {
 const {ctx,worker,task}=setup();
 ctx.run=()=>new Promise(()=>{});
 const checked=await resolveTask(ctx,task);
 expect(checked.resolved).toBeUndefined();
 expect(readTask(ctx,task.id)?.resolutionCheckedAt).toBeUndefined();
 expect(readTask(ctx,task.id)?.rev).toBe(task.rev);
 rmSync(worker,{recursive:true});
 expect((await resolveTask({...ctx,now:ctx.now+59},checked)).resolved).toBeUndefined();
 expect((await resolveTask({...ctx,now:ctx.now+60},checked)).resolved).toBe("worktree removed");
});

test("pump lets a slower healthy comparison finish after publishing", async () => {
 const {ctx,repo,worker,git,task}=setup();
 writeFileSync(join(worker,"tracked"),"landed\n");writeFileSync(join(repo,"tracked"),"landed\n");git("add",".");git("commit","-m","land slow comparison");
 let delayed=false;
 ctx.run=async(...args)=>{
  if(!delayed){delayed=true;await Bun.sleep(350);}
  return realRun(...args);
 };
 const start=performance.now();
 await pumpOnce(ctx,{tasks:()=>[task],status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"claude-code",mode:"normal",disabled:false,calendarPace:true,providers:[],executors:{ranked:[],excluded:[]}}),backfillRepos:async()=>{},publish:(await import("../src/link/publish")).publish});
 expect(performance.now()-start).toBeLessThan(1000);
 const deadline=performance.now()+1500;
 while(!readTask(ctx,task.id)?.resolved&&performance.now()<deadline)await Bun.sleep(20);
 expect(readTask(ctx,task.id)?.resolved).toBe("already on main");
});

test("resolution preserves edits persisted while asynchronous git is pending", async () => {
 const {ctx,task}=setup();
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 let gated=false;
 ctx.run=async(...args)=>{
  if(!gated){gated=true;entered();await gate;}
  return realRun(...args);
 };
 const pending=resolveTask(ctx,task);
 await started;
 updateTask(ctx,task.id,t=>{t.dismissed=true;});
 release();
 expect((await pending).dismissed).toBe(true);
 expect(readTask(ctx,task.id)?.dismissed).toBe(true);
});

test("repeated unchanged resolution checks never advance the revision or rewrite legacy fields", async () => {
 const {ctx,task}=setup();
 const legacy=updateTask(ctx,task.id,t=>{t.resolutionCheckedAt=ctx.now-120;});
 for(const seconds of [0,60,120]) await resolveTask({...ctx,now:ctx.now+seconds},legacy);
 expect(readTask(ctx,task.id)).toEqual(legacy);
});
