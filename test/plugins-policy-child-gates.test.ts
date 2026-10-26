import {expect,test} from "bun:test";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {policyGateFixture} from "./fixtures/policy-host";
import {gitRepo,realRun} from "./helpers";
import {createTask,listTasksWhere,readTask,updateTask} from "../src/tasks/store";
import {registerWork,issueWorkGrant} from "../src/dispatch/work";
import {dispatchDatabase} from "../src/dispatch/store";
import {delegateChild} from "../src/core/work";
import {resolvePolicyRepoInput} from "../src/core/project-policy";
import {withLock} from "../src/core/lock";
async function scoped(verdict:unknown,delay=0){
 const f=policyGateFixture(verdict,delay,gitRepo());f.ctx.run=realRun;
 writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,providers:{...f.config.providers,cursor:{}}}));
 const repo=await resolvePolicyRepoInput(f.ctx,f.repo),parent=createTask(f.ctx,{brief:{goal:"parent",repo:repo.path},repo,kind:null,requestedExecutor:"codex",timeoutS:600});registerWork(f.ctx,parent.id,{allowDelegation:true});updateTask(f.ctx,parent.id,t=>{t.state="running";t.executor="codex";t.worktree=repo.path;});
 const current={...f.ctx,now:Date.now()/1000},token=issueWorkGrant(current,parent.id,1),ctx={...current,env:{...current.env,PACER_ROLE:"executor",PACER_WORK_GRANT:token}};
 return {...f,parent:readTask(f.ctx,parent.id)!,ctx,token,input:{goal:"child",requestId:"child",executor:"cursor"}};
}
const noChild=(f:Awaited<ReturnType<typeof scoped>>)=>{expect(listTasksWhere(f.ctx)).toHaveLength(1);expect(f.launches()).toBe(0);expect(dispatchDatabase(f.ctx).query<{n:number},[]>("SELECT count(*) AS n FROM work_requests").get()?.n).toBe(0);};

test("scoped child veto leaves no child or idempotency row",async()=>{
 const f=await scoped({verdict:"veto",reason:"blocked"});await expect(delegateChild(f.ctx,f.input,f.spawn)).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});noChild(f);
});

test("parent HEAD changing during actual child policy cannot create a stale-base child",async()=>{
 const f=await scoped({verdict:"allow"},100),pending=delegateChild(f.ctx,f.input,f.spawn),until=Date.now()+2000;
 while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);expect(f.calls()).toHaveLength(1);
 expect((await realRun(["git","-C",f.repo,"-c","user.name=pacer","-c","user.email=pacer@localhost","-c","commit.gpgsign=false","commit","--allow-empty","-m","Parent advanced"],5000)).code).toBe(0);
 await expect(pending).rejects.toMatchObject({code:"conflict"});noChild(f);
});

test("a work grant expiring during the initial HEAD read cannot admit a child",async()=>{
 const {applyPolicy}=await import("../src/plugins/policy");const f=await scoped({verdict:"allow"});
 await applyPolicy(f.ctx,"route",{taskId:f.parent.id,candidates:[]},{contextFingerprint:()=>"warm"});
 updateTask(f.ctx,f.parent.id,t=>{t.timeoutS=0.08;});const current={...f.ctx,now:Date.now()/1000},token=issueWorkGrant(current,f.parent.id,1);
 let delayed=false;const ctx={...current,env:{...current.env,PACER_WORK_GRANT:token},run:async(args:string[],timeout:number,options?:Parameters<typeof realRun>[2])=>{const result=await realRun(args,timeout,options);if(!delayed&&args.includes("HEAD")){delayed=true;await Bun.sleep(120);}return result;}};
 await expect(delegateChild(ctx,f.input,f.spawn)).rejects.toMatchObject({code:"not_allowed"});noChild(f);
});

test("capacity becoming full while the request lock is pending is checked before child admission",async()=>{
 const f=await scoped({verdict:"allow"}),hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
 let head!:()=>void;const seen=new Promise<void>(r=>{head=r;});const run=f.ctx.run;f.ctx.run=async(...args)=>{const result=await run(...args);if(args[0].includes("HEAD"))head();return result;};
 let pending!:ReturnType<typeof delegateChild>;
 await withLock(f.ctx,`work-request-${hash([f.parent.id,hash(f.input.requestId)])}`,async()=>{
  pending=delegateChild(f.ctx,f.input,f.spawn);await seen;await Bun.sleep(1);
  const sibling=createTask(f.ctx,{brief:{goal:"sibling",repo:f.parent.brief.repo},kind:null,requestedExecutor:"cursor",timeoutS:60});registerWork(f.ctx,sibling.id,{},f.parent.id);updateTask(f.ctx,sibling.id,t=>{t.state="running";t.executor="cursor";});
 });
 await expect(pending).rejects.toMatchObject({code:"not_allowed"});expect(listTasksWhere(f.ctx)).toHaveLength(2);expect(f.launches()).toBe(0);expect(f.calls()).toEqual([]);
});

test("concurrent identical child requests invoke policy once and preserve isolation",async()=>{
 const f=await scoped({verdict:"allow"},30),[a,b]=await Promise.all([delegateChild(f.ctx,f.input,f.spawn),delegateChild(f.ctx,f.input,f.spawn)]);
 expect(a.id).toBe(b.id);expect(f.calls()).toHaveLength(1);expect(a.placement?.requested).toBe("new");expect(a.brief.base).toMatch(/^[0-9a-f]{40}$/);expect(f.launches()).toBe(1);
});
