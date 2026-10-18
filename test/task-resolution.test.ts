import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolutionReason, resolveTask } from "../src/tasks/resolution";
import { taskReview } from "../src/tasks/api";
import { createTask, updateTask, readTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";
import { taskData, pumpOnce } from "../src/link/pump";
import { emptySnapshot, parseOutboxEvent } from "../src/link/envelope";
import { attentionGroups } from "../orca-plugin/src/panel/model";

function setup(){const ctx=fakeCtx(),repo=tmpDir(),worker=join(ctx.home,"worker");
 const git=(...a:string[])=>execFileSync("git",["-C",repo,...a],{stdio:"pipe"});
 git("init","-b","main");git("config","user.email","test@example.com");git("config","user.name","Test");
 writeFileSync(join(repo,"tracked"),"base\n");git("add",".");git("commit","-m","base");git("worktree","add","-b","worker",worker);
 const t=createTask(ctx,{brief:{goal:"g",repo},kind:null,requestedExecutor:null,timeoutS:60});
 const task=updateTask(ctx,t.id,x=>{x.state="partial";x.worktree=worker;x.baseBranch="main";});return {ctx,repo,worker,git,task};}
test("unlanded diff stays visible; tracked and untracked bytes clear when base contains them",()=>{
 const {ctx,repo,worker,git,task}=setup();writeFileSync(join(worker,"tracked"),"changed\n");writeFileSync(join(worker,"new"),"new\n");
 expect(resolutionReason(ctx,task)).toBeNull();writeFileSync(join(repo,"tracked"),"changed\n");writeFileSync(join(repo,"new"),"new\n");git("add",".");git("commit","-m","landed");
 expect(resolutionReason(ctx,task)).toBe("already on main");const resolved=resolveTask(ctx,task);expect(readTask(ctx,task.id)?.resolved).toBe("already on main");
 const s=emptySnapshot();s.tasks=[taskData(resolved)];expect(attentionGroups(s,ctx.now)).toEqual([]);
});
test("worker commits and deleted files are compared; differing untracked content prevents resolution",()=>{
 const {ctx,repo,worker,git,task}=setup();execFileSync("git",["-C",worker,"rm","tracked"]);execFileSync("git",["-C",worker,"commit","-m","delete"]);
 expect(resolutionReason(ctx,task)).toBeNull();git("rm","tracked");git("commit","-m","delete landed");expect(resolutionReason(ctx,task)).toBe("already on main");
 writeFileSync(join(worker,"extra"),"pending");expect(resolutionReason(ctx,task)).toBeNull();
});
test("an empty worker diff and in-place runs never count as landed",()=>{
 const {ctx,repo,task}=setup();expect(resolutionReason(ctx,task)).toBeNull();
 expect(resolutionReason(ctx,{...task,worktree:repo})).toBeNull();
 expect(resolutionReason(ctx,{...task,placement:{requested:"current",mode:"current",why:"agent: x"}})).toBeNull();
});
test("removed worktree and both review verdicts settle attention and roundtrip",()=>{
 const {ctx,worker,task}=setup();rmSync(worker,{recursive:true});expect(resolveTask(ctx,task).resolved).toBe("worktree removed");
 for(const accepted of [true,false]){taskReview(ctx,task.id,accepted);const data=taskData(readTask(ctx,task.id)!);expect(parseOutboxEvent({type:"task",data})?.data).toMatchObject({review:{accepted},resolved:"reviewed"});}
});
test("resolution checks are persisted and limited to once per task per minute",()=>{
 const {ctx,worker,task}=setup();writeFileSync(join(worker,"tracked"),"pending");const checked=resolveTask(ctx,task);expect(checked.resolved).toBeUndefined();
 rmSync(worker,{recursive:true});expect(resolveTask({...ctx,now:ctx.now+59},checked).resolved).toBeUndefined();expect(resolveTask({...ctx,now:ctx.now+60},checked).resolved).toBe("worktree removed");
});

test("pump exposes terminal presence only after a live Orca terminal receipt",async()=>{
 const {updateOrcaState}=await import("../src/exec/orca/state");
 const ctx=fakeCtx(),task=createTask(ctx,{brief:{goal:"g",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
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
 expect(events.find(e=>e.type==="task")?.data).toMatchObject({resolved:"worktree removed"});expect(readTask(ctx,task.id)).toMatchObject({resolved:"worktree removed",resolutionCheckedAt:ctx.now});
});
test("subdirectory task worktrees compare paths from the Git root",()=>{
 const {ctx,repo,worker,git,task}=setup();mkdirSync(join(repo,"sub"));writeFileSync(join(repo,"sub/tracked"),"old\n");git("add",".");git("commit","-m","subdir");
 execFileSync("git",["-C",worker,"merge","--ff-only","main"],{stdio:"pipe"});mkdirSync(join(worker,"sub"),{recursive:true});task.worktree=join(worker,"sub");
 writeFileSync(join(worker,"sub/tracked"),"new\n");writeFileSync(join(worker,"sub/untracked"),"extra\n");expect(resolutionReason(ctx,task)).toBeNull();
 writeFileSync(join(repo,"sub/tracked"),"new\n");writeFileSync(join(repo,"sub/untracked"),"extra\n");git("add",".");git("commit","-m","land subdir");expect(resolutionReason(ctx,task)).toBe("already on main");
});
