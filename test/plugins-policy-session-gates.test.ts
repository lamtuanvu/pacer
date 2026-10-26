import {expect,test} from "bun:test";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {policyGateFixture} from "./fixtures/policy-host";
import {callOp} from "../src/api/ops";
import {createConversation} from "../src/session/create";
import {createDraft,storeAttachment,resolveAttachments} from "../src/attachments/store";
import {createTask,listTasksWhere,readTask,updateTask} from "../src/tasks/store";
import {gitRepo,realRun,withLoginIndicators} from "./helpers";
function setup(verdict:unknown,mode:"current"|"new"="current") {
 const f=policyGateFixture(verdict,0,gitRepo());f.ctx.run=realRun;
 const draft=createDraft(f.ctx);
 const preparation={repo:{key:"local:test",path:f.repo,label:"repo"},branches:["main"],base:"main",checkouts:[{path:f.repo,branch:"main",dirty:false}],executors:[{id:"codex",agent:"codex",account:"default",version:"0.163.0",available:true,capabilities:{interactive:true,resume:true,launchImages:true,liveImages:false,files:true}}]};
 const input={request_id:"session",draftId:draft.id,request:"Explain",repo:f.repo,executor:"codex",workspace:mode==="current"?{mode:"current" as const,path:f.repo}:{mode:"new" as const,base:"main"},attachments:[] as string[]};
 const deps={prepare:async()=>structuredClone(preparation),spawnRunner:f.spawn};
 return {...f,input,deps,preparation};
}

test("conversation veto leaves no task or attachment claim and retry remains possible",async()=>{
 const f=setup({verdict:"veto",reason:"blocked"});
 const attachment=await storeAttachment(f.ctx,{draftId:f.input.draftId,batchId:"one",name:"context.txt",mime:"text/plain",body:new Blob(["hello"]).stream()});f.input.attachments=[attachment.id];
 await expect(createConversation(f.ctx,f.input,f.deps)).rejects.toMatchObject({code:"not_allowed"});
 expect(listTasksWhere(f.ctx)).toEqual([]);expect(f.launches()).toBe(0);
 writeFileSync(join(f.dir,"settings.json"),JSON.stringify({verdict:{verdict:"allow"},delay:0}));
 const result=await createConversation(f.ctx,f.input,f.deps);expect(resolveAttachments(f.ctx,result.task_id).map(a=>a.id)).toEqual([attachment.id]);
});

for(const [from,to] of [["new","current"],["current","new"]] as const) {
 test(`conversation maps supported ${from} to ${to} placement amendment`,async()=>{
  const f=setup({verdict:"amend",amend:{placement:to}},from);
  const result=await createConversation(f.ctx,f.input,f.deps);
  const task=listTasksWhere(f.ctx).find(t=>t.id===result.task_id);
  expect(task?.placement?.requested).toBe(to);expect(task?.baseSha!==undefined).toBe(to==="new");
 });
}

test("unsupported conversation kind or auto amendments obey open/closed mode",async()=>{
 for(const amend of [{kind:"tests"},{placement:"auto"}]) {
  const f=setup({verdict:"amend",amend});
  await expect(createConversation(f.ctx,f.input,f.deps)).rejects.toMatchObject({code:"not_allowed"});expect(listTasksWhere(f.ctx)).toEqual([]);
  writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,plugins:{...f.config.plugins,policy:{mode:"open"}}}));
  await createConversation(f.ctx,f.input,f.deps);expect(listTasksWhere(f.ctx)).toHaveLength(1);
 }
});

test("duplicate concurrent session creation invokes policy once before attachment transaction",async()=>{
 const f=setup({verdict:"allow"});
 const [a,b]=await Promise.all([createConversation(f.ctx,f.input,f.deps),createConversation(f.ctx,f.input,f.deps)]);
 expect(a.task_id).toBe(b.task_id);expect(f.calls()).toHaveLength(1);expect(f.launches()).toBe(1);
});


test("conversation resume veto preserves ended identity and task state before reset",async()=>{
 const f=setup({verdict:"veto",reason:"blocked"});
 const ctx=withLoginIndicators({...f.ctx,run:async(args,timeout,options)=>{
  if(args[0]!=="codex")return realRun(args,timeout,options);
  return {code:0,stdout:args[1]==="--version"?"codex-cli 0.163.0":"--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust",stderr:""};
 }});
 const task=createTask(ctx,{brief:{goal:"Explain",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:3600,interactionMode:"conversation"});
 updateTask(ctx,task.id,t=>{t.state="stopped";t.conversation={activity:"ended",agentSessionId:"native-id"};});
 const before=readTask(ctx,task.id)!;
 await expect(callOp(ctx,"session.resume",{id:task.id,expect_rev:before.rev},{spawnRunner:f.spawn})).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
 expect(readTask(ctx,task.id)).toEqual(before);expect(f.launches()).toBe(0);expect(f.calls()).toHaveLength(1);
});

test("open mode ignores a conversation placement amendment into an occupied checkout",async()=>{
 const f=setup({verdict:"amend",amend:{placement:"current"}},"new");
 const owner=createTask(f.ctx,{brief:{goal:"Owner",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60,interactionMode:"conversation",placement:{requested:"current"}});
 writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,plugins:{...f.config.plugins,policy:{mode:"open"}}}));
 const result=await createConversation(f.ctx,f.input,f.deps);
 expect(readTask(f.ctx,result.task_id)?.placement?.requested).toBe("new");expect(readTask(f.ctx,owner.id)?.state).toBe("queued");
});
