import {expect,test} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx,gitRepo,realRun} from "./helpers";
import {createTask,readTask,updateTask} from "../src/tasks/store";
import {registerWork,issueWorkGrant,workTree} from "../src/dispatch/work";
import {delegateChild,scopedWorkTree,reviewWork} from "../src/core/work";
import {callOp} from "../src/api/ops";

function activeRoot(){
 const ctx=fakeCtx({now:Date.now()/1000,run:realRun}),repo=gitRepo();mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
 const root=createTask(ctx,{brief:{goal:"Root",repo},kind:"feature",requestedExecutor:null,timeoutS:600});registerWork(ctx,root.id,{allowDelegation:true});
 updateTask(ctx,root.id,t=>{t.state="running";});const grant=issueWorkGrant(ctx,root.id,1);
 return{ctx:{...ctx,env:{...ctx.env,PACER_ROLE:"executor",PACER_WORK_GRANT:grant}},root,repo};
}
test("scoped child delegation is idempotent and cannot cross repositories or review self",async()=>{
 const{ctx,root}=activeRoot(),spawn=()=>1234;
 const child=await delegateChild(ctx,{goal:"Child task",requestId:"stable",acceptanceTimeoutMin:25},spawn);
 expect(readTask(ctx,child.id)?.brief.acceptanceTimeoutMin).toBe(25);
 expect(child.id).toMatch(/^t-/);
 expect((await delegateChild(ctx,{goal:"Child task",requestId:"stable",acceptanceTimeoutMin:25},spawn)).id).toBe(child.id);
 await expect(delegateChild(ctx,{goal:"Changed",requestId:"stable"},spawn)).rejects.toMatchObject({code:"conflict"});
 await expect(delegateChild(ctx,{goal:"Escape",repo:"/tmp/other",requestId:"escape"},spawn)).rejects.toMatchObject({code:"not_allowed"});
 expect(scopedWorkTree(ctx,root.id).nodes.map(n=>n.taskId)).toEqual([root.id,child.id]);
 await expect(reviewWork(ctx,root.id,true)).rejects.toMatchObject({code:"not_allowed"});
 expect(workTree(ctx,root.id).nodes).toHaveLength(2);
 expect(readTask(ctx,child.id)?.brief.repo).toBe(root.brief.repo);
 expect(readTask(ctx,child.id)?.brief.worktreeBase).toBe("head");
 expect(readTask(ctx,child.id)?.brief.base).toMatch(/^[0-9a-f]{40,64}$/);
 updateTask(ctx,child.id,t=>{t.state="done";});
 const revision=readTask(ctx,child.id)!.rev;
 await reviewWork(ctx,child.id,true,undefined,revision);
 await expect(reviewWork(ctx,child.id,false,undefined,revision)).rejects.toMatchObject({code:"conflict"});
});

for (const op of ["dispatch.submit", "dispatch.child"] as const) {
 test(`${op} maps public acceptance timeout to the stored camelCase field`, async () => {
  const {ctx,repo}=activeRoot();
  const caller=op==="dispatch.submit" ? {...ctx,env:{...ctx.env,PACER_ROLE:undefined,PACER_WORK_GRANT:undefined}} : ctx;
  const result=await callOp(caller,op,{goal:"Timeout mapping",repo,requestId:"timeout-mapping",acceptance_timeout_min:25},{spawnRunner:()=>1234}) as {task_id:string};
  const brief=readTask(ctx,result.task_id)!.brief;
  expect(brief.acceptanceTimeoutMin).toBe(25);
  expect(brief).not.toHaveProperty("acceptance_timeout_min");
 });
}
