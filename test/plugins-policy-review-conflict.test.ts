import {expect,test} from "bun:test";
import {policyGateFixture} from "./fixtures/policy-host";
import {createTask,readTask,updateTask} from "../src/tasks/store";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/protocol";

test("review task race during actual policy preserves structured current-task conflict",async()=>{
 const f=policyGateFixture({verdict:"allow"},80),task=createTask(f.ctx,{brief:{goal:"review",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60});
 const original=updateTask(f.ctx,task.id,t=>{t.state="failed";}),pending=callOp(f.ctx,"task.review",{id:task.id,verdict:"accept",expect_rev:original.rev}).catch(toApiError);
 const until=Date.now()+2000;while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);expect(f.calls()).toHaveLength(1);
 const current=updateTask(f.ctx,task.id,t=>{t.reviewRequest={note:"changed",at:f.ctx.now};});
 expect(await pending).toMatchObject({code:"conflict",message:"task changed",data:{task:{id:task.id,rev:current.rev,repo:{key:expect.any(String)}}}});
 expect(readTask(f.ctx,task.id)?.review).toBeUndefined();expect(f.launches()).toBe(0);
});

test("review metadata-only conflict stays distinct from a task revision conflict",async()=>{
 const {writeFileSync}=await import("node:fs"),{join}=await import("node:path");
 const f=policyGateFixture({verdict:"allow"},80),task=createTask(f.ctx,{brief:{goal:"review",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60});
 const original=updateTask(f.ctx,task.id,t=>{t.state="failed";}),pending=callOp(f.ctx,"task.review",{id:task.id,verdict:"accept",expect_rev:original.rev}).catch(toApiError);
 const until=Date.now()+2000;while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);expect(f.calls()).toHaveLength(1);
 writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,plugins:{...f.config.plugins,policy:{mode:"open"}}}));
 const error=await pending;expect(error).toMatchObject({code:"conflict",message:"Policy context changed"});expect(error).not.toHaveProperty("data");expect(readTask(f.ctx,task.id)).toEqual(original);expect(f.launches()).toBe(0);
});
