import {expect,test} from "bun:test";
import {policyGateFixture} from "./fixtures/policy-host";
import {createTask,readTask,updateTask,listTasksWhere} from "../src/tasks/store";
import {registerWork,workEvents} from "../src/dispatch/work";
import {dispatchDatabase} from "../src/dispatch/store";
import {callOp} from "../src/api/ops";
for(const name of ["task.review","dispatch.review"] as const)test(`public managed ${name} veto precedes verdict and learning`,async()=>{
 const f=policyGateFixture({verdict:"veto",reason:"review blocked"});
 const task=createTask(f.ctx,{brief:{goal:"managed",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60});registerWork(f.ctx,task.id,{});updateTask(f.ctx,task.id,t=>{t.state="failed";});
 const before=readTask(f.ctx,task.id)!,events=workEvents(f.ctx,task.id);
 await expect(callOp(f.ctx,name,{id:task.id,expect_rev:before.rev,...(name==="task.review"?{verdict:"accept"}:{accepted:true})},{spawnRunner:f.spawn})).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
 expect(f.calls().map(line=>JSON.parse(line).decision)).toEqual(["review"]);expect(readTask(f.ctx,task.id)).toEqual(before);expect(listTasksWhere(f.ctx)).toHaveLength(1);expect(workEvents(f.ctx,task.id)).toEqual(events);expect(dispatchDatabase(f.ctx).query<{n:number},[]>("SELECT count(*) AS n FROM work_reviews").get()?.n).toBe(0);expect(f.launches()).toBe(0);
});
test("public managed review retains final revision check after transient mutation wrapper",async()=>{
 const f=policyGateFixture({verdict:"allow"},80),task=createTask(f.ctx,{brief:{goal:"managed",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60});registerWork(f.ctx,task.id,{});updateTask(f.ctx,task.id,t=>{t.state="failed";});
 const before=readTask(f.ctx,task.id)!,events=workEvents(f.ctx,task.id),pending=callOp(f.ctx,"task.review",{id:task.id,expect_rev:before.rev,verdict:"accept"},{spawnRunner:f.spawn});
 const until=Date.now()+2000;while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);expect(f.calls()).toHaveLength(1);expect(()=>updateTask(f.ctx,task.id,t=>{t.reviewRequest={note:"changed",at:f.ctx.now};})).not.toThrow();const racedEvents=workEvents(f.ctx,task.id);
 await expect(pending).rejects.toMatchObject({code:"conflict"});expect(readTask(f.ctx,task.id)?.review).toBeUndefined();expect(workEvents(f.ctx,task.id)).toEqual(racedEvents);expect(dispatchDatabase(f.ctx).query<{n:number},[]>("SELECT count(*) AS n FROM work_reviews").get()?.n).toBe(0);
});
test("public scoped review grant expiring during policy records no verdict or learning",async()=>{
 const {issueWorkGrant}=await import("../src/dispatch/work");const {applyPolicy}=await import("../src/plugins/policy");
 const f=policyGateFixture({verdict:"allow"},100);await applyPolicy(f.ctx,"route",{taskId:"warm",candidates:[]},{contextFingerprint:()=>"warm"});
 const parent=createTask(f.ctx,{brief:{goal:"parent",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:0.04});registerWork(f.ctx,parent.id,{allowDelegation:true});updateTask(f.ctx,parent.id,t=>{t.state="running";});
 const child=createTask(f.ctx,{brief:{goal:"child",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60});registerWork(f.ctx,child.id,{},parent.id);updateTask(f.ctx,child.id,t=>{t.state="failed";});
 const current={...f.ctx,now:Date.now()/1000},token=issueWorkGrant(current,parent.id,1),ctx={...current,env:{...current.env,PACER_ROLE:"executor",PACER_WORK_GRANT:token}},before=readTask(ctx,child.id)!,events=workEvents(ctx,child.id);
 await expect(callOp(ctx,"dispatch.review",{id:child.id,expect_rev:before.rev,accepted:true},{spawnRunner:f.spawn})).rejects.toMatchObject({code:"not_allowed"});
 expect(f.calls().map(line=>JSON.parse(line).decision)).toEqual(["route","review"]);expect(readTask(ctx,child.id)).toEqual(before);expect(workEvents(ctx,child.id)).toEqual(events);expect(dispatchDatabase(ctx).query<{n:number},[]>("SELECT count(*) AS n FROM work_reviews").get()?.n).toBe(0);
});
