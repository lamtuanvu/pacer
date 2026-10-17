import { expect, test } from "bun:test";
import { main } from "../src/cli";
import { OPS } from "../src/api/ops";
import * as tasks from "../src/core/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runTask } from "../src/tasks/runner";
import { validateStrategy } from "../src/config/strategy";
import { fakeCtx, gitRepo, realRun } from "./helpers";

function setup() {
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief:{goal:"g",repo:gitRepo()},kind:null,requestedExecutor:null,timeoutS:60});
  updateTask(ctx,task.id,t=>{t.state="running";});
  ctx.env = {PACER_ROLE:"executor",PACER_TASK_ID:task.id};
  return {ctx, task};
}
test("ask records text verbatim and refuses a second question", async () => {
  const {ctx,task}=setup();
  const text='which db? $(rm -rf ~)\nsecond line';
  expect(await main(["ask",text],ctx)).toMatchObject({code:0});
  expect(readTask(ctx,task.id)?.question).toEqual({text,at:ctx.now});
  expect(await main(["ask","again"],ctx)).toMatchObject({code:2,err:"already asked; stop and wait for the answer"});
});
test("ask requires executor session and task identity", async () => {
  for (const env of [{}, {PACER_ROLE:"executor"}, {PACER_TASK_ID:"t-20261016-000000-abcd"}]) {
    expect(await main(["ask","which db?"],fakeCtx({env}))).toMatchObject({code:2,err:"pacer ask works only inside a delegated task"});
  }
});
test("task.ask has the same session restrictions and records the question", async () => {
  const {ctx,task}=setup();
  expect(OPS["task.ask"]).toBeDefined();
  await expect(Promise.resolve().then(()=>OPS["task.ask"].handler(fakeCtx(),{id:task.id,text:"q"},{}))).rejects.toThrow("pacer ask works only inside a delegated task");
  await expect(Promise.resolve().then(()=>OPS["task.ask"].handler(ctx,{id:"another",text:"q"},{}))).rejects.toThrow("pacer ask works only inside a delegated task");
  await OPS["task.ask"].handler(ctx,{id:task.id,text:"which db?"},{});
  expect(readTask(ctx,task.id)?.question?.text).toBe("which db?");
});
test("ask rejects empty, oversized and settled questions", async () => {
  const {ctx,task}=setup();
  for (const text of ["","x".repeat(1001)]) expect((await main(["ask",text],ctx)).code).toBe(2);
  updateTask(ctx,task.id,t=>{t.state="done";});
  await expect(tasks.ask(ctx,task.id,"q")).rejects.toThrow();
});
test("a question takes precedence over successful exit and preserves the executor commit", async () => {
  const {ctx,task}=setup();
  ctx.run=realRun;
  updateTask(ctx,task.id,t=>{t.state="queued";});
  const strategy=validateStrategy({planner:"claude-code",providers:{"claude-code":{},codex:{}},pacing:{policy:"priority"}},"/x");
  const result=await runTask(ctx,task.id,{
    loadStrategy:()=>strategy,
    computeStatus:async()=>({generatedAt:0,strategy:"default",planner:"claude-code",mode:"normal",disabled:false,calendarPace:true,providers:[{id:"codex",usage:"quota",windows:[],binding:null,verdict:"ON_PACE",installed:true,stale:false}],executors:{ranked:[],excluded:[]}}),
    runAttempt:async()=>{
      await tasks.ask(ctx,task.id,"which db?");
      const commit=await realRun(["git","-C",task.brief.repo,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","executor change"],10000);
      expect(commit.code).toBe(0);
      return {exec:{code:0,stdout:"done",stderr:"",timedOut:false},report:"done",worktree:task.brief.repo,attempt:{executor:"codex",model:null,startedAt:1,endedAt:20,exitCode:0,timedOut:false,limitHit:false,log:""}};
    },
    verifyRepo:async()=>({files:"(no changes)"}),
  });
  expect(result.state).toBe("needs_input");
  expect(result.result?.status).toBe("needs_input");
  expect((await realRun(["git","-C",task.brief.repo,"log","-1","--format=%s"],10000)).stdout.trim()).toBe("executor change");
});

test("simultaneous asks record exactly one question",async()=>{
 const {ctx,task}=setup();
 const results=await Promise.allSettled([tasks.ask(ctx,task.id,"first"),tasks.ask(ctx,task.id,"second")]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
 expect(["first","second"]).toContain(readTask(ctx,task.id)!.question!.text);
});
