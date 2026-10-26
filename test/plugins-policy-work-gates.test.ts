import {expect,test} from "bun:test";
import {readFileSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx,tmpDir,gitRepo,realRun} from "./helpers";
import {policyGateFixture} from "./fixtures/policy-host";
import {createTask,listTasksWhere,readTask,updateTask} from "../src/tasks/store";
import {dispatchDatabase} from "../src/dispatch/store";
import {getWork,registerWork,workEvents,issueWorkGrant} from "../src/dispatch/work";
import {answerWork,retryWork} from "../src/core/work";
function managed(verdict:unknown,answer=false){
 const f=policyGateFixture(verdict);
 const task=createTask(f.ctx,{brief:{goal:"work",repo:f.repo},kind:"debug",requestedExecutor:"codex",timeoutS:60});
 registerWork(f.ctx,task.id,{kind:"debug"});
 updateTask(f.ctx,task.id,t=>{t.state=answer?"needs_input":"failed";if(answer)t.question={text:"question",at:f.ctx.now};});
 return {...f,task:readTask(f.ctx,task.id)!};
}
for(const answering of [false,true])test(`managed ${answering?"answer":"retry"} veto preserves same-id state and observations`,async()=>{
 const f=managed({verdict:"veto",reason:"blocked"},answering),before=readTask(f.ctx,f.task.id),events=workEvents(f.ctx,f.task.id);
 const pending=answering?answerWork(f.ctx,f.task.id,{expectRev:f.task.rev,requestId:"request",text:"answer"},f.spawn):retryWork(f.ctx,f.task.id,{expectRev:f.task.rev,requestId:"request"},f.spawn);
 await expect(pending).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
 expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(workEvents(f.ctx,f.task.id)).toEqual(events);expect(listTasksWhere(f.ctx)).toHaveLength(1);expect(f.launches()).toBe(0);
});

test("managed restart synchronizes allowed kind amendments with dispatch options",async()=>{
 const f=managed({verdict:"amend",amend:{kind:"tests"}});
 await retryWork(f.ctx,f.task.id,{expectRev:f.task.rev,requestId:"request"},f.spawn);
 expect(readTask(f.ctx,f.task.id)?.kind).toBe("tests");expect(getWork(f.ctx,f.task.id)?.options.kind).toBe("tests");expect(f.launches()).toBe(1);
});

test("managed duplicate restart replays before policy and never starts twice",async()=>{
 const f=managed({verdict:"allow"});
 const input={expectRev:f.task.rev,requestId:"request"};
 await Promise.all([retryWork(f.ctx,f.task.id,input,f.spawn),retryWork(f.ctx,f.task.id,input,f.spawn)]);
 expect(f.calls()).toHaveLength(1);expect(f.launches()).toBe(1);
});


test("no-policy same-id retry preserves intent when strategy was never configured",async()=>{
 const ctx=fakeCtx(),task=createTask(ctx,{brief:{goal:"legacy",repo:tmpDir()},kind:null,requestedExecutor:null,timeoutS:60});registerWork(ctx,task.id,{kind:"custom-dispatch-label"});updateTask(ctx,task.id,t=>{t.state="failed";});let launches=0;
 const result=await retryWork(ctx,task.id,{expectRev:readTask(ctx,task.id)!.rev,requestId:"legacy"},()=>{launches++;return 1;});
 expect(result.id).toBe(task.id);expect(result.state).toBe("queued");expect(getWork(ctx,task.id)?.options.kind).toBe("custom-dispatch-label");expect(launches).toBe(1);
});

test("deleting strategy preserves legacy no-policy managed restart semantics",async()=>{
 const f=managed({verdict:"veto",reason:"would veto only while configured"});rmSync(join(f.ctx.pacerHome,"strategy.yaml"));
 expect((await retryWork(f.ctx,f.task.id,{expectRev:f.task.rev,requestId:"deleted"},f.spawn)).state).toBe("queued");expect(f.launches()).toBe(1);expect(f.calls()).toEqual([]);
});

test("malformed strategy never silently disables configured restart policy",async()=>{
 const f=managed({verdict:"veto",reason:"blocked"});writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),"plugins: [invalid]");
 await expect(retryWork(f.ctx,f.task.id,{expectRev:f.task.rev,requestId:"malformed"},f.spawn)).rejects.toThrow();expect(readTask(f.ctx,f.task.id)).toEqual(f.task);expect(f.launches()).toBe(0);
});


test("configured policies receive the real custom managed dispatch kind",async()=>{
 const f=managed({verdict:"allow"}),work=getWork(f.ctx,f.task.id)!;
 dispatchDatabase(f.ctx).query("UPDATE work_nodes SET options=? WHERE task_id=?").run(JSON.stringify({...work.options,kind:"custom-dispatch-label"}),f.task.id);
 const path=join(f.dir,"main.ts");writeFileSync(path,readFileSync(path,"utf8").replace("result=s.verdict;","result=r.params.input.kind==='custom-dispatch-label'?{verdict:'veto',reason:'custom scope blocked'}:{verdict:'allow'};"));
 await expect(retryWork(f.ctx,f.task.id,{expectRev:f.task.rev,requestId:"custom"},f.spawn)).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
 expect(JSON.parse(f.calls()[0]).input.kind).toBe("custom-dispatch-label");expect(readTask(f.ctx,f.task.id)).toEqual(f.task);expect(f.launches()).toBe(0);
});


test("a scoped managed grant expiring during the actual policy wait cannot restart work",async()=>{
 const {applyPolicy}=await import("../src/plugins/policy");
 const f=managed({verdict:"allow"});
 const parent=createTask(f.ctx,{brief:{goal:"parent",repo:f.repo},kind:null,requestedExecutor:null,timeoutS:0.15});registerWork(f.ctx,parent.id,{allowDelegation:true});updateTask(f.ctx,parent.id,t=>{t.state="running";});
 dispatchDatabase(f.ctx).query("UPDATE work_nodes SET parent_id=?,root_id=?,depth=1 WHERE task_id=?").run(parent.id,parent.id,f.task.id);
 await applyPolicy(f.ctx,"route",{taskId:f.task.id,candidates:[]},{contextFingerprint:()=>"warm"});
 writeFileSync(join(f.dir,"settings.json"),JSON.stringify({verdict:{verdict:"allow"},delay:250}));
 const current={...f.ctx,now:Date.now()/1000},token=issueWorkGrant(current,parent.id,1),scoped={...current,env:{...current.env,PACER_WORK_GRANT:token,PACER_ROLE:"executor"}};
 const before=readTask(f.ctx,f.task.id),pending=retryWork(scoped,f.task.id,{expectRev:f.task.rev,requestId:"expires"},f.spawn),until=Date.now()+2000;
 while(!f.calls().some(line=>JSON.parse(line).decision==="delegate")&&Date.now()<until)await Bun.sleep(5);
 expect(f.calls().some(line=>JSON.parse(line).decision==="delegate")).toBe(true);
 await expect(pending).rejects.toMatchObject({code:"not_allowed"});expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(f.launches()).toBe(0);
});

test("answer HEAD changes during actual policy are rejected before resetting the same task",async()=>{
 const f=managed({verdict:"allow"},true),repo=gitRepo();f.ctx.run=realRun;
 updateTask(f.ctx,f.task.id,t=>{t.brief.repo=repo;t.worktree=repo;});const before=readTask(f.ctx,f.task.id)!;
 writeFileSync(join(f.dir,"settings.json"),JSON.stringify({verdict:{verdict:"allow"},delay:100}));
 const pending=answerWork(f.ctx,f.task.id,{expectRev:before.rev,requestId:"head-race",text:"answer"},f.spawn),until=Date.now()+2000;
 while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);expect(f.calls()).toHaveLength(1);
 expect((await realRun(["git","-C",repo,"-c","user.name=pacer","-c","user.email=pacer@localhost","-c","commit.gpgsign=false","commit","--allow-empty","-m","Concurrent commit"],5000)).code).toBe(0);
 await expect(pending).rejects.toMatchObject({code:"conflict"});expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(f.launches()).toBe(0);
});
