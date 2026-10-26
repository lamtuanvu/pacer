import {expect,test} from "bun:test";
import {mkdirSync,renameSync} from "node:fs";
import {policyGateFixture} from "./fixtures/policy-host";
import {prepareDelegate} from "../src/tasks/api";
import {createConversation} from "../src/session/create";
import {createDraft} from "../src/attachments/store";
import {createTask,listTasksWhere,readTask,updateTask} from "../src/tasks/store";
import {callOp} from "../src/api/ops";
import {gitRepo,realRun,withLoginIndicators} from "./helpers";
const replace=(path:string)=>{renameSync(path,`${path}-retired`);mkdirSync(path);};

test("a stored prepared admission rechecks directory identity when consumed",async()=>{
 const f=policyGateFixture({verdict:"allow"});
 const admission=await prepareDelegate(f.ctx,{brief:{goal:"work",repo:f.repo}},f.spawn);
 replace(f.repo);
 await expect(Promise.resolve().then(()=>admission.commit())).rejects.toMatchObject({code:"conflict"});
 expect(listTasksWhere(f.ctx)).toEqual([]);expect(f.launches()).toBe(0);
});

test("repository replacement during post-policy conversation preparation creates no task",async()=>{
 const f=policyGateFixture({verdict:"allow"});const draft=createDraft(f.ctx);let preparations=0;
 const preparation={repo:{key:"local:test",path:f.repo,label:"repo"},branches:["main"],base:"main",checkouts:[{path:f.repo,branch:"main",dirty:false}],executors:[{id:"codex",agent:"codex",account:"default",version:"0.163.0",available:true,capabilities:{interactive:true,resume:true,launchImages:true,liveImages:false,files:true}}]};
 await expect(createConversation(f.ctx,{request_id:"replace",draftId:draft.id,request:"Explain",repo:f.repo,executor:"codex",workspace:{mode:"current",path:f.repo},attachments:[]},{prepare:async()=>{if(++preparations===2)replace(f.repo);return structuredClone(preparation);},spawnRunner:f.spawn})).rejects.toMatchObject({code:"conflict"});
 expect(listTasksWhere(f.ctx)).toEqual([]);expect(f.launches()).toBe(0);
});

test("repository replacement at the end of resume preparation preserves ended state",async()=>{
 const f=policyGateFixture({verdict:"allow"},0,gitRepo());let statuses=0;
 const ctx=withLoginIndicators({...f.ctx,run:async(args,timeout,options)=>{
  if(args[0]==="codex")return {code:0,stdout:args[1]==="--version"?"codex-cli 0.163.0":"--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust",stderr:""};
  const result=await realRun(args,timeout,options);
  if(args[0]==="git"&&args.includes("status")&&++statuses===2)replace(f.repo);
  return result;
 }});
 const task=createTask(ctx,{brief:{goal:"Explain",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:3600,interactionMode:"conversation"});
 updateTask(ctx,task.id,t=>{t.state="stopped";t.conversation={activity:"ended",agentSessionId:"native-id"};});const before=readTask(ctx,task.id)!;
 await expect(callOp(ctx,"session.resume",{id:task.id,expect_rev:before.rev},{spawnRunner:f.spawn})).rejects.toMatchObject({code:"conflict"});
 expect(readTask(ctx,task.id)).toEqual(before);expect(f.launches()).toBe(0);
});

test("cancellation during the final locked probe releases admission without effects",async()=>{
 const {repoFs}=await import("../src/core/path-probe");
 const f=policyGateFixture({verdict:"allow"}),abort=new AbortController();
 const task=createTask(f.ctx,{brief:{goal:"existing",repo:f.repo},kind:null,requestedExecutor:null,timeoutS:60});
 const admission=await prepareDelegate(f.ctx,{brief:{goal:"work",repo:f.repo},admissionSignal:abort.signal,admissionTaskLock:task.id},f.spawn);
 const original=repoFs.stat,stat=await original(f.repo);let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 repoFs.stat=async()=>{entered();await gate;return stat;};
 let effects=0;
 try {
  const pending=admission.consume(()=>{effects++;return updateTask(f.ctx,task.id,t=>{t.kind="tests";});});
  await ready;abort.abort();release();await expect(pending).rejects.toMatchObject({code:"not_allowed"});
 } finally {release?.();repoFs.stat=original;}
 expect(effects).toBe(0);expect(readTask(f.ctx,task.id)?.kind).toBeNull();
 expect(()=>updateTask(f.ctx,task.id,t=>{t.kind="debug";})).not.toThrow();
});

test("consumed admission guards cannot be deferred or reused",async()=>{
 const f=policyGateFixture({verdict:"allow"});
 const admission=await prepareDelegate(f.ctx,{brief:{goal:"work",repo:f.repo}},f.spawn);
 let late:(()=>void)|undefined;
 await admission.consume(({revalidate})=>{late=revalidate;return "observed";});
 expect(()=>late!()).toThrow("no longer active");await expect(admission.commit()).rejects.toMatchObject({code:"conflict"});expect(listTasksWhere(f.ctx)).toEqual([]);
});

test("a repository disappearing before consumption reports conflict without effects",async()=>{
 const f=policyGateFixture({verdict:"allow"});
 const admission=await prepareDelegate(f.ctx,{brief:{goal:"work",repo:f.repo}},f.spawn);
 renameSync(f.repo,`${f.repo}-retired`);
 await expect(admission.commit()).rejects.toMatchObject({code:"conflict"});expect(listTasksWhere(f.ctx)).toEqual([]);expect(f.launches()).toBe(0);
});
