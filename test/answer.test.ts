import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActivity } from "../src/activity/log";
import { callOp } from "../src/api/ops";
import * as tasks from "../src/core/tasks";
import { cliDeps, main } from "../src/cli";
import { buildPrompt } from "../src/exec/prompt";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";

function setup() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive:true});
  writeFileSync(join(ctx.pacerHome,"strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const t = createTask(ctx,{brief:{goal:"g",repo:gitRepo(),constraints:"keep scope",qa:[{q:"earlier",a:"yes"}]},kind:null,requestedExecutor:"codex",timeoutS:60});
  const text='which db? $(rm -rf ~)\nsecond line';
  const task = updateTask(ctx,t.id,t=>{t.state="needs_input";t.executor="codex";t.question={text,at:ctx.now};});
  const spawned: string[] = [];
  const deps = {spawnRunner: (_: unknown,id: string)=>{spawned.push(id);return 1;}};
  return {ctx,task,text,spawned,deps};
}

test("answer retries on the same executor with verbatim cumulative Q/A and records the answer",async()=>{
  const {ctx,task,text,spawned,deps}=setup();
  const a='use postgres\n  preserve spacing $(echo no)';
  const r = await callOp(ctx,"task.answer",{id:task.id,text:a,expect_rev:task.rev},deps) as any;
  expect(r.task.question).toMatchObject({text,answer:a,answeredAt:ctx.now});
  const next=readTask(ctx,r.retry.id)!;
  expect(next.requestedExecutor).toBe("codex");
  expect(next.retryOf).toBe(task.id);
  expect(next.brief.qa).toEqual([{q:"earlier",a:"yes"},{q:text,a}]);
  const prompt=buildPrompt(next.brief,next.id);
  expect(prompt).toContain(`## Question / Answer\nQ: earlier\nA: yes\n\nQ: ${text}\nA: ${a}`);
  expect(prompt.indexOf("## Question / Answer")).toBeGreaterThan(prompt.indexOf("## Constraints"));
  expect(spawned).toEqual([next.id]);
});

test("concurrent answers create only one retry even after that retry settles",async()=>{
  const {ctx,task,spawned,deps}=setup();
  const results=await Promise.allSettled([1,2].map(()=>callOp(ctx,"task.answer",{id:task.id,text:"use postgres"},deps)));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"conflict"}});
  updateTask(ctx,spawned[0]!,t=>{t.state="done";});
  await expect(callOp(ctx,"task.answer",{id:task.id,text:"again"},deps)).rejects.toMatchObject({code:"conflict"});
  expect(spawned).toHaveLength(1);
});

test("answer rejects stale revisions, non-needs_input tasks, invalid text and executor sessions",async()=>{
  const {ctx,task,spawned,deps}=setup();
  await expect(callOp(ctx,"task.answer",{id:task.id,text:"a",expect_rev:task.rev-1},deps)).rejects.toMatchObject({code:"conflict",data:{task:{rev:task.rev}}});
  for(const text of ["","x".repeat(2001)]) await expect(callOp(ctx,"task.answer",{id:task.id,text},deps)).rejects.toMatchObject({code:"invalid_input"});
  ctx.env.PACER_ROLE="executor";
  await expect(callOp(ctx,"task.answer",{id:task.id,text:"a"},deps)).rejects.toMatchObject({code:"not_allowed"});
  delete ctx.env.PACER_ROLE;
  updateTask(ctx,task.id,t=>{t.state="done";});
  await expect(tasks.answer(ctx,task.id,"a")).rejects.toMatchObject({code:"conflict"});
  expect(spawned).toEqual([]);
});

test("pacer answer passes task and text directly to the answer operation",async()=>{
  const {ctx,task,deps,spawned}=setup();
  const before=cliDeps.spawnRunner;
  try {
    cliDeps.spawnRunner=deps.spawnRunner;
    expect(await main(["answer",task.id,"use postgres"],ctx)).toMatchObject({code:0});
    expect(spawned).toHaveLength(1);
    expect(await main(["answer",task.id],ctx)).toMatchObject({code:2});
  } finally {cliDeps.spawnRunner=before;}
});

test("an answer starts from the asking executor's committed worktree head",async()=>{
  const {ctx,task,deps}=setup();
  ctx.run=realRun;
  const worktree=join(tmpDir(),"child");
  expect((await realRun(["git","-C",task.brief.repo,"worktree","add","-b","executor-work",worktree],10000)).code).toBe(0);
  expect((await realRun(["git","-C",worktree,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","executor change"],10000)).code).toBe(0);
  const head=(await realRun(["git","-C",worktree,"rev-parse","HEAD"],10000)).stdout.trim();
  updateTask(ctx,task.id,t=>{t.worktree=worktree;t.placement={requested:"auto",mode:"new",why:"test"};});
  const r=await callOp(ctx,"task.answer",{id:task.id,text:"postgres"},deps) as any;
  expect(readTask(ctx,r.retry.id)?.brief.base).toBe(head);
  expect(readTask(ctx,r.retry.id)?.placement?.requested).toBe("new");
});

test("an answer whose asking worktree pacer removed starts from the lane's recorded base and says so",async()=>{
  const {ctx,task,deps}=setup();
  const base="c".repeat(40);
  updateTask(ctx,task.id,t=>{t.baseSha=base;t.worktreeReleased={at:ctx.now,path:join(tmpDir(),"lane")};t.result={status:"needs_input",executor:"codex",model:null,files:"",report:"asked",backend:"orca"};});
  const r=await callOp(ctx,"task.answer",{id:task.id,text:"postgres"},deps) as any;
  expect(readTask(ctx,r.retry.id)?.brief.base).toBe(base);
  expect(readActivity(ctx,{}).entries.find(e=>e.taskId===r.retry.id&&e.kind==="message")?.text)
    .toBe(`The asking worktree was removed; the answer starts from the recorded base ${base.slice(0,12)}`);
});

test("an answer to a remote-host task keeps its brief base and says nothing about a removed worktree",async()=>{
  const {ctx,task,deps}=setup();
  const original=task.brief.base;
  updateTask(ctx,task.id,t=>{
    t.baseSha="c".repeat(40);t.worktree="build-host:/srv/lane";
    t.run={host:"build-host",dir:join(tmpDir(),"run"),attempt:1,executor:"codex",startedAt:ctx.now,mode:"new",workdir:"/srv/lane",logFile:join(tmpDir(),"log")};
    t.result={status:"needs_input",executor:"codex",model:null,files:"",report:"asked",backend:"direct",worktree:"build-host:/srv/lane"};
  });
  const r=await callOp(ctx,"task.answer",{id:task.id,text:"postgres"},deps) as any;
  expect(readTask(ctx,r.retry.id)?.brief.base).toBe(original);
  expect(readActivity(ctx,{}).entries.some(e=>e.taskId===r.retry.id&&e.text?.includes("asking worktree was removed"))).toBe(false);
});

test("an answer whose asking worktree was removed out of band is refused until it is restored",async()=>{
  const {ctx,task,deps}=setup();
  const gone=join(tmpDir(),"removed-lane");
  updateTask(ctx,task.id,t=>{t.worktree=gone;t.baseSha="c".repeat(40);t.result={status:"needs_input",executor:"codex",model:null,files:"",report:"asked",backend:"direct",worktree:gone};});
  await expect(callOp(ctx,"task.answer",{id:task.id,text:"postgres"},deps)).rejects.toMatchObject({code:"conflict",message:expect.stringContaining("restore it before answering")});
  expect(readTask(ctx,task.id)?.question?.answer).toBeUndefined();
  expect(readTask(ctx,task.id)?.retriedBy).toBeUndefined();
});

test("a failed delegation leaves the question unanswered and available to answer",async()=>{
  const {ctx,task}=setup();
  await expect(tasks.answer(ctx,task.id,"postgres",{}, {delegate:()=>{throw new Error("delegate unavailable");}})).rejects.toThrow("delegate unavailable");
  expect(readTask(ctx,task.id)).toMatchObject({rev:task.rev,question:{text:task.question!.text}});
  expect(readTask(ctx,task.id)?.question?.answer).toBeUndefined();
  expect(readTask(ctx,task.id)?.retriedBy).toBeUndefined();
});

test("stopping a waiting question prevents subsequent answers",async()=>{
  const {ctx,task,deps}=setup();
  await callOp(ctx,"task.stop",{id:task.id},deps);
  expect(readTask(ctx,task.id)?.state).toBe("stopped");
  await expect(callOp(ctx,"task.answer",{id:task.id,text:"postgres"},deps)).rejects.toMatchObject({code:"conflict"});
});
