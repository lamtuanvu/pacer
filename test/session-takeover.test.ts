import { expect, test } from "bun:test";
import { folderKeys } from "../src/exec/claude-trust";
import { launchFor, resumeLaunchFor } from "../src/exec/launch";
import { parseOpencodeSessions, takeoverAvailability } from "../src/session/takeover";
import { parseSessionHeader } from "../src/exec/direct";
import { validateStrategy } from "../src/config/strategy";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { takeoverTask } from "../src/session/takeover";
import { runAttempt, resumeAttempt, progressPoller } from "../src/exec/direct";
import { runTask, type RunnerDeps } from "../src/tasks/runner";
import { verifyRepo } from "../src/exec/verify";
import type { Status } from "../src/engine/status";
import { loadStrategy } from "../src/config/strategy";
import { sessionDirectory, sessionInfo, sessionSocket } from "../src/session/service";
import { attachDirectory, AttachKeys } from "../src/session/attach";
import { FrameType, WireDecoder, wire } from "../src/session/framing";
import { readRun, startRun, stopRun } from "../src/supervisor/run";
import { prepareInteractive, sessionTranscript } from "../src/session/reports";

const providers = validateStrategy({planner:"claude-code",providers:{codex:{},"claude-code":{},cursor:{},agy:{}}},"/x").providers;
const id="12345678-1234-1234-1234-123456789abc";
test("Codex session header requires a UUID",()=>{
 expect(parseSessionHeader(`banner\nsession id: ${id}\n`)).toBe(id);
 expect(parseSessionHeader("session id: nope")).toBeUndefined();
});
test("assigned session ids are passed to headless Claude and Cursor",()=>{
 expect(launchFor(providers["claude-code"],"p","/wt","/run","task",id).argv).toContain("--session-id");
 expect(launchFor(providers.cursor,"p","/wt","/run","task",id).argv).toContain("--resume");
});
test("resume launches preserve working directory, model and correct option order",()=>{
 expect(resumeLaunchFor({...providers.codex,model:"m"},id,"/wt","/run")).toEqual({cwd:"/wt",argv:["codex","-c",'projects={"/wt"={trust_level="trusted"}}',"-c","check_for_update_on_startup=false","resume","--no-daemon","-C","/wt","--dangerously-bypass-approvals-and-sandbox","--add-dir","/run","-m","m",id]});
 expect(resumeLaunchFor(providers["claude-code"],id,"/wt","/run").argv).toEqual(["claude","--dangerously-skip-permissions","--resume",id]);
 expect(resumeLaunchFor(providers.cursor,id,"/wt","/run").argv).toEqual(["cursor-agent","--force","--sandbox","disabled","--workspace","/wt","--resume",id]);
 expect(resumeLaunchFor({...providers.codex,via:"opencode",model:"m"},id,"/wt","/run").argv).toEqual(["opencode","--standalone","--auto","--session",id]);
});
test("OpenCode lookup tolerates wrappers, malformed rows, and selects newest matching title",()=>{
 const rows=[{id:"old",title:"pacer t",time:{updated:10}},{id:"other",title:"pacer other",time:{updated:50}},{id:"new",title:"pacer t",time:{updated:20}},null];
 expect(parseOpencodeSessions(JSON.stringify(rows),"t")).toBe("new");
 expect(parseOpencodeSessions(JSON.stringify({data:{sessions:rows}}),"t")).toBe("new");
 expect(parseOpencodeSessions("garbage","t")).toBeUndefined();
 expect(parseOpencodeSessions('[{"title":"pacer t"}]',"t")).toBeUndefined();
});


const canInspect=(()=>{try{return Bun.spawnSync(["ps","-p",String(process.pid)]).exitCode===0;}catch{return false;}})();
async function until(f:()=>unknown, timeout=12000) {
 const end=Date.now()+timeout;
 while(Date.now()<end){if(f())return;await Bun.sleep(40);}
 throw Error("Timed out waiting for takeover test condition");
}
function fixture() {
 const repo=gitRepo(), bin=tmpDir();
 symlinkSync(join(import.meta.dir,"fixtures/bin/fake-agent"),join(bin,"codex"));
 symlinkSync(join(import.meta.dir,"fixtures/bin/fake-agent"),join(bin,"cursor-agent"));
 symlinkSync(join(import.meta.dir,"fixtures/bin/fake-agent"),join(bin,"claude"));
 const ctx=fakeCtx({run:realRun,env:{...process.env,PATH:`${bin}:${process.env.PATH}`}});
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders: {claude-code: {}, codex: {}, cursor: {}}\nexecution: {backend: direct, launch_mode: headless}\n");
 const strategy=loadStrategy(ctx);
 const task=createTask(ctx,{brief:{goal:"Take over",repo,acceptance:"test -f takeover-change.txt"},kind:null,requestedExecutor:"codex",timeoutS:60});
 const deps:RunnerDeps={loadStrategy:()=>strategy,runAttempt,verifyRepo,computeStatus:async()=>({generatedAt:0,strategy:"default",planner:"claude-code",mode:"normal",disabled:false,paused:null,modeHold:null,calendarPace:true,providers:Object.keys(strategy.providers).map(id=>({id,usage:"quota",windows:[],binding:null,verdict:"ON_PACE",installed:true,stale:false})),executors:{ranked:[],excluded:[]}} as Status)};
 return {ctx,repo,task,strategy,deps};
}
test("takeover refuses unsupported, missing id, remote, stopped and interactive runs",async()=>{
 const {ctx,task}=fixture(), dir=tmpDir();
 const run={dir,attempt:1,executor:"codex",startedAt:Date.now()/1000,mode:"current" as const,workdir:ctx.home,logFile:join(dir,"log")};
 for(const change of [{state:"queued" as const},{state:"running" as const,run},{state:"running" as const,run:{...run,executor:"agy"}},{state:"running" as const,run:{...run,host:"remote"}},{state:"running" as const,backend:"orca",run}]){
  updateTask(ctx,task.id,t=>{delete t.backend;delete t.run;Object.assign(t,change);});
  expect(takeoverAvailability(readTask(ctx,task.id)!).available).toBe(false);
  await expect(takeoverTask(ctx,task.id)).rejects.toThrow();
 }
 updateTask(ctx,task.id,t=>{delete t.backend;t.state="running";t.run={...run,agentSession:{id,source:"header"}};});
 writeFileSync(join(dir,"interactive.json"),"{}");
 await expect(takeoverTask(ctx,task.id)).rejects.toThrow("already interactive");
});
test.skipIf(!canInspect)("runner takes over in the same worktree, user exit verifies once with no fallback",async()=>{
 const {ctx,task,deps}=fixture();
 const running=runTask(ctx,task.id,deps);
 try {
  await until(()=>readTask(ctx,task.id)?.run?.agentSession);
  const before=readTask(ctx,task.id)!.run!;
  expect(before.agentSession).toEqual({id,source:"header"});
  const reply=await takeoverTask(ctx,task.id);
  expect(reply.state).toBe("driving");
  const now=readTask(ctx,task.id)!;
  expect(now.state).toBe("running");
  expect(now.run?.takeover).toBe(true);
  expect(now.run?.attempt).toBe(1);
  expect(now.run?.workdir).toBe(before.workdir);
  expect(sessionDirectory(ctx,task.id)).toBe(now.run!.dir);
  expect(attachDirectory(ctx,task.id)).toBe(now.run!.dir);
  expect(statSync(join(before.dir,"takeover.json")).mode&0o777).toBe(0o600);
  await until(()=>existsSync(join(now.run!.workdir,"resumed-id.txt")));
  expect(readFileSync(join(now.run!.workdir,"resumed-id.txt"),"utf8")).toBe(id);
  expect(readFileSync(join(now.run!.workdir,"resumed-cwd.txt"),"utf8").trim()).toBe(now.run!.workdir);
  expect(await sessionInfo(ctx,task.id,false,false)).toMatchObject({driving:true,takeover:{available:false}});
  writeFileSync(join(now.run!.workdir,"finish-session"),"");
  const result=await running;
  expect(result.state).toBe("done");
  expect(result.attempts).toHaveLength(1);
  expect(result.takeover?.state).toBe("ended");
  expect(result.result?.files).toContain("takeover-change.txt");
  expect(result.result?.acceptance?.passed).toBe(true);
  expect(result.result?.report).toEndWith("You drove this task; the agent left no summary");
  const log=readFileSync(result.attempts[0].log,"utf8");
  expect(log).toContain("session id:");
  expect(log).toContain("RESUMED CONTEXT");
 }finally{const run=readTask(ctx,task.id)?.run;if(run)await stopRun(run.dir);await running;}
},25000);

test("progress polls discover bounded pipe and derived PTY headers and driving never idles",async()=>{
 for(const pty of [false,true]){
  const ctx=fakeCtx(),dir=tmpDir();
  const task=createTask(ctx,{brief:{goal:"header",repo:dir},kind:null,requestedExecutor:null,timeoutS:60});
  const run: import("../src/tasks/types").RunRef={dir,attempt:1,executor:"codex",startedAt:1,mode:"current",workdir:dir,logFile:join(dir,"log")};
  updateTask(ctx,task.id,t=>{t.state="running";t.run=run;});
  if(pty)writeFileSync(join(dir,"session.json"),"{}");
  const file=join(dir,pty?"stdout":"stderr"),state={pid:null,startedAt:1,exit:null,alive:true,stdoutBytes:0,stderrBytes:0,lastOutputAt:null};
  const poll=progressPoller(ctx,task,run);
  writeFileSync(file,"x".repeat(16*1024)+`\nsession id: ${id}\n`);
  await poll(state);
  expect(readTask(ctx,task.id)?.run?.agentSession).toBeUndefined();
  writeFileSync(file,`header\nsession id: ${id}\n`);
  await poll(state);
  expect(readTask(ctx,task.id)?.run?.agentSession).toEqual({id,source:"header"});
  run.takeover=true;
  expect(await progressPoller(ctx,task,run)(state)).toBe("continue");
  expect(readTask(ctx,task.id)?.progress?.phase).toBe("driving");
 }
});
test("restart during driving keeps user exit successful and skips limit fallback",async()=>{
 const {ctx,task,deps}=fixture(),dir=join(ctx.pacerHome,"runs",task.id,"1-takeover");
 mkdirSync(dir,{recursive:true});
 const startedAt=Date.now()/1000-10;
 const run={dir,attempt:1,executor:"codex",startedAt,mode:"current" as const,workdir:task.brief.repo,logFile:join(ctx.pacerHome,"takeover.log"),takeover:true,agentSession:{id,source:"header" as const}};
 writeFileSync(join(dir,"pid"),"999999999");
 writeFileSync(join(dir,"interactive.json"),"{}");
 writeFileSync(join(dir,"stdout"),"usage limit");writeFileSync(join(dir,"stderr"),"");writeFileSync(join(dir,"exit"),"130");
 writeFileSync(join(dir,"session.ended"),String(startedAt+9));
 writeFileSync(join(dir,"transcript-report.md"),"User completed the diff");
 writeFileSync(join(run.workdir,"takeover-change.txt"),"context");
 updateTask(ctx,task.id,t=>{t.state="running";t.run=run;t.attemptStartedAt=startedAt;t.takeover={state:"driving",at:startedAt,sessionId:id};});
 const result=await runTask(ctx,task.id,deps);
 expect(result.state).toBe("done");
 expect(result.attempts).toHaveLength(1);
 expect(result.attempts[0]).toMatchObject({exitCode:0,limitHit:false});
 expect(result.result?.report).toBe("User completed the diff");
 expect(result.takeover?.state).toBe("ended");
});
test("an early resume failure never marks an executor broken or falls back, even with a diff",async()=>{
 const {ctx,task,deps}=fixture(),dir=join(ctx.pacerHome,"runs",task.id,"1-takeover");
 mkdirSync(dir,{recursive:true});const startedAt=Date.now()/1000-2;
 const run={dir,attempt:1,executor:"codex",startedAt,mode:"current" as const,workdir:task.brief.repo,logFile:join(ctx.pacerHome,"takeover.log"),takeover:true,agentSession:{id,source:"header" as const}};
 for(const [name,value] of Object.entries({pid:"999999999","interactive.json":"{}",stdout:"",stderr:"invalid session id: usage limit",exit:"2","session.ended":String(startedAt+1)}))writeFileSync(join(dir,name),value);
 writeFileSync(join(run.workdir,"takeover-change.txt"),"prior change");
 updateTask(ctx,task.id,t=>{t.state="running";t.run=run;t.attemptStartedAt=startedAt;t.takeover={state:"driving",at:startedAt,sessionId:id};});
 const result=await runTask(ctx,task.id,deps);
 expect(result.state).toBe("failed");
 expect(result.attempts).toHaveLength(1);
 expect(result.attempts[0]).toMatchObject({exitCode:127,limitHit:false});
 expect(result.attempts[0].brokenReason).toBeUndefined();
 expect(result.result?.report).toContain("invalid session id");
 expect(result.takeover?.state).toBe("ended");
});
test("an agent failure report remains authoritative during takeover",async()=>{
 const {ctx,task}=fixture(),dir=tmpDir(),startedAt=Date.now()/1000-10;
 const run={dir,attempt:1,executor:"codex",startedAt,mode:"current" as const,workdir:task.brief.repo,logFile:join(dir,"log"),takeover:true};
 for(const [name,value] of Object.entries({pid:"999999999","interactive.json":"{}",stdout:"",stderr:"",exit:"0","report.json":JSON.stringify({status:"failed",summary:"Agent check failed",source:"agent",at:Date.now()/1000})}))writeFileSync(join(dir,name),value);
 updateTask(ctx,task.id,t=>{t.state="running";t.run=run;t.takeover={state:"driving",at:startedAt,sessionId:id};});
 const out=await resumeAttempt(ctx,providers.codex,readTask(ctx,task.id)!);
 expect(out.exec.code).toBe(1);expect(out.report).toBe("Agent check failed");expect(out.attempt.limitHit).toBe(false);
});
test("takeover release key explains the handback before sending release",()=>{
 const events:string[]=[];
 const keys=new AttachKeys(bytes=>{events.push(new WireDecoder().push(bytes)[0].type===FrameType.release?"release":"input");},message=>events.push(message),true);
 keys.setControl(true);keys.push(Buffer.from([29,114]));
 expect(events).toEqual(["Releasing hands the task back for review.\n","release"]);
});

test.skipIf(!canInspect)("controller release hands the task to verification; disconnect leaves it driving",async()=>{
 const {ctx,task,deps}=fixture();
 const running=runTask(ctx,task.id,deps);
 let socket:ReturnType<typeof createConnection>|undefined;
 const connect=async(dir:string)=>{
  const peer=createConnection(sessionSocket(dir));peer.on("error",()=>{});
  await new Promise<void>((resolve,reject)=>{peer.once("connect",resolve);peer.once("error",reject);});
  peer.write(wire(FrameType.hello,{v:1,client:"cli",label:"driver",cols:80,rows:24}));
  peer.write(wire(FrameType.take,{}));
  return peer;
 };
 try{
  await until(()=>readTask(ctx,task.id)?.run?.agentSession);
  await takeoverTask(ctx,task.id);
  const dir=readTask(ctx,task.id)!.run!.dir;
  socket=await connect(dir);
  await until(()=>readRun(dir).controller);
  socket.destroy();
  await until(()=>!readRun(dir).controller);
  expect(readTask(ctx,task.id)?.takeover?.state).toBe("driving");
  expect(existsSync(join(dir,"report.json"))).toBe(false);
  socket=await connect(dir);
  await until(()=>readRun(dir).controller);
  socket.write(wire(FrameType.release,{}));
  const result=await running;
  expect(result.state).toBe("done");
  expect(result.takeover?.state).toBe("ended");
  expect(result.attempts).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir,"report.json"),"utf8"))).toMatchObject({status:"done",source:"user",summary:"Handed back by cli:driver"});
 }finally{socket?.destroy();const run=readTask(ctx,task.id)?.run;if(run)await stopRun(run.dir);await running;}
},25000);

test.skipIf(!canInspect)("runner restart reattaches to a live driving host without a second executor attempt",async()=>{
 const {ctx,task,deps}=fixture(),dir=join(ctx.pacerHome,"runs",task.id,"1-takeover");
 const startedAt=Date.now()/1000;
 const run={dir,attempt:1,executor:"codex",startedAt,mode:"current" as const,workdir:task.brief.repo,logFile:join(ctx.pacerHome,"driving.log"),takeover:true,agentSession:{id,source:"header" as const}};
 const launch=prepareInteractive("codex",dir,resumeLaunchFor(providers.codex,id,run.workdir,dir));
 writeFileSync(join(dir,"argv"),launch.argv.join(" "));
 const started=startRun({dir,argv:launch.argv,cwd:run.workdir,env:{...ctx.env,PACER_HOME:ctx.pacerHome,PACER_RUN_DIR:dir},session:"interactive",takeover:true});
 expect(started).not.toHaveProperty("error");
 updateTask(ctx,task.id,t=>{t.state="running";t.run=run;t.attemptStartedAt=startedAt;t.takeover={state:"driving",at:startedAt,sessionId:id};});
 try{
  await until(()=>existsSync(sessionSocket(dir)));
  writeFileSync(join(run.workdir,"takeover-change.txt"),"kept context");
  const running=runTask(ctx,task.id,deps);
  await until(()=>readTask(ctx,task.id)?.progress?.phase==="driving");
  writeFileSync(join(run.workdir,"finish-session"),"");
  const result=await running;
  expect(result.state).toBe("done");
  expect(result.attempts).toHaveLength(1);
  expect(result.run?.dir).toBe(dir);
  expect(result.takeover?.state).toBe("ended");
 }finally{await stopRun(dir);}
},25000);

test.skipIf(!canInspect)("runner restart between headless stop and resume starts the requested conversation",async()=>{
 const {ctx,task,deps}=fixture(),dir=join(ctx.pacerHome,"runs",task.id,"1"),startedAt=Date.now()/1000;
 mkdirSync(dir,{recursive:true});
 for(const [name,value] of Object.entries({pid:"999999999",stdout:"headless context",stderr:"",exit:"143","takeover.json":JSON.stringify({at:startedAt,sessionId:id})}))writeFileSync(join(dir,name),value);
 const run={dir,attempt:1,executor:"codex",startedAt,mode:"current" as const,workdir:task.brief.repo,logFile:join(ctx.pacerHome,"starting.log"),agentSession:{id,source:"header" as const}};
 writeFileSync(join(run.workdir,"takeover-change.txt"),"kept context");
 updateTask(ctx,task.id,t=>{t.state="running";t.run=run;t.attemptStartedAt=startedAt;t.takeover={state:"starting",at:startedAt,sessionId:id};});
 const running=runTask(ctx,task.id,deps);
 try{
  await until(()=>readTask(ctx,task.id)?.run?.takeover && existsSync(join(run.workdir,"resumed-id.txt")));
  expect(readFileSync(join(run.workdir,"resumed-id.txt"),"utf8")).toBe(id);
  writeFileSync(join(run.workdir,"finish-session"),"");
  const result=await running;
  expect(result.state).toBe("done");expect(result.attempts).toHaveLength(1);expect(result.takeover?.state).toBe("ended");
 }finally{const current=readTask(ctx,task.id)?.run;if(current)await stopRun(current.dir);await running;}
},25000);

test.skipIf(!canInspect)("a Claude takeover resume is pre-trusted and keeps its permission bypass",async()=>{
 const {ctx,task,deps}=fixture(),dir=join(ctx.pacerHome,"runs",task.id,"1"),startedAt=Date.now()/1000;
 mkdirSync(dir,{recursive:true});mkdirSync(ctx.home,{recursive:true});
 writeFileSync(join(ctx.home,".claude.json"),JSON.stringify({oauthAccount:{}}),{mode:0o600});
 for(const [name,value] of Object.entries({pid:"999999999",stdout:"headless context",stderr:"",exit:"143","takeover.json":JSON.stringify({at:startedAt,sessionId:id})}))writeFileSync(join(dir,name),value);
 const run={dir,attempt:1,executor:"claude-code",startedAt,mode:"current" as const,workdir:task.brief.repo,logFile:join(ctx.pacerHome,"starting.log"),agentSession:{id,source:"assigned" as const}};
 writeFileSync(join(run.workdir,"takeover-change.txt"),"kept context");
 updateTask(ctx,task.id,t=>{t.state="running";t.executor="claude-code";t.run=run;t.attemptStartedAt=startedAt;t.takeover={state:"starting",at:startedAt,sessionId:id};});
 const running=runTask(ctx,task.id,deps);
 try{
  await until(()=>readTask(ctx,task.id)?.run?.takeover && existsSync(join(run.workdir,"resumed-id.txt")));
  const takeover=readTask(ctx,task.id)!.run!.dir;
  expect(readFileSync(join(takeover,"argv"),"utf8")).toContain("--dangerously-skip-permissions");
  expect(JSON.parse(readFileSync(join(takeover,"claude-settings.json"),"utf8")).skipDangerousModePermissionPrompt).toBe(true);
  const projects=JSON.parse(readFileSync(join(ctx.home,".claude.json"),"utf8")).projects;
  for(const key of folderKeys(run.workdir))expect(projects[key]).toMatchObject({hasTrustDialogAccepted:true});
  writeFileSync(join(run.workdir,"finish-session"),"");
  expect((await running).state).toBe("done");
 }finally{const current=readTask(ctx,task.id)?.run;if(current)await stopRun(current.dir);await running;}
},25000);

test("headless launches record assigned Claude and Cursor ids, with failed Cursor creation falling back unchanged",async()=>{
 for(const agent of ["claude-code","cursor","cursor-failed"]){
  const bin=tmpDir(),ctx=fakeCtx({env:{...process.env,PATH:`${bin}:${process.env.PATH}`}}),repo=tmpDir();
  const executable=join(bin,agent==="claude-code"?"claude":"cursor-agent");
  writeFileSync(executable,`#!/bin/sh
if [ "$1" = create-chat ]; then
  printf '%s' "$PACER_ROLE" > chat-role
  pwd > chat-cwd
  ${agent==="cursor-failed"?"exit 1":`echo ${id}; exit 0`}
fi
printf '%s\\n' "$@"
`,{mode:0o755});
  const task=createTask(ctx,{brief:{goal:"assignment",repo},kind:null,requestedExecutor:null,timeoutS:20});
  const out=await runAttempt(ctx,{...providers[agent==="claude-code"?"claude-code":"cursor"],session:"headless"},task);
  const run=readTask(ctx,task.id)!.run!;
  const argv=readFileSync(join(run.dir,"argv"),"utf8");
  expect(out.exec.code).toBe(0);
  if(agent==="cursor-failed"){
   expect(run.agentSession).toBeUndefined();expect(argv).not.toContain("--resume");
  }else{
   expect(run.agentSession?.source).toBe("assigned");
   expect(argv).toContain(`${agent==="claude-code"?"--session-id":"--resume"} ${run.agentSession!.id}`);
   if(agent==="claude-code")expect(run.agentSession!.id).toMatch(/^[a-f0-9-]{36}$/);
   else {
    expect(run.agentSession!.id).toBe(id);
    expect(readFileSync(join(repo,"chat-role"),"utf8")).toBe("executor");
    expect(readFileSync(join(repo,"chat-cwd"),"utf8").trim()).toBe(repo);
   }
  }
 }
},15000);

test("OpenCode discovery runs in the worktree with runner environment and records a lookup id",async()=>{
 const bin=tmpDir(),ctx=fakeCtx({env:{...process.env,PATH:`${bin}:${process.env.PATH}`}}),repo=tmpDir(),dir=tmpDir();
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"accounts: {plan: {kind: claude}, api: {kind: endpoint, usage: unmetered, model: api/model}}\nplanner: claude-code\nrouting: [{default: [opencode#api]}]\n");
 const task=createTask(ctx,{brief:{goal:"lookup",repo},kind:null,requestedExecutor:null,timeoutS:60});
 writeFileSync(join(bin,"opencode"),`#!/bin/sh
printf '%s\\n' "$@" > lookup-argv
pwd > lookup-cwd
printf '%s' "$PACER_ROLE" > lookup-role
printf '%s' '[{"id":"chat-opencode","title":"pacer ${task.id}","updatedAt":20}]'
`,{mode:0o755});
 const run={dir,attempt:1,executor:"opencode#api",startedAt:Date.now()/1000,mode:"current" as const,workdir:repo,logFile:join(dir,"log")};
 writeFileSync(join(dir,"exit"),"143");
 updateTask(ctx,task.id,t=>{t.state="running";t.backend="direct";t.run=run;});
 expect((await sessionInfo(ctx,task.id,false,false)).takeover).toEqual({available:true});
 expect(existsSync(join(repo,"lookup-argv"))).toBe(false);
 // Stand in for a runner consuming the request; the operation should return immediately when it settles.
 const timer=setInterval(()=>{if(existsSync(join(dir,"takeover.json")))updateTask(ctx,task.id,t=>{t.takeover!.state="ended";});},10);
 try{
  const result=await takeoverTask(ctx,task.id);
  expect(result.state).toBe("ended");
  expect(readTask(ctx,task.id)?.run?.agentSession).toEqual({id:"chat-opencode",source:"lookup"});
  expect(readFileSync(join(repo,"lookup-argv"),"utf8").trim().split("\n")).toEqual(["session","list","--standalone","--format","json","-n","20"]);
  expect(readFileSync(join(repo,"lookup-cwd"),"utf8").trim()).toBe(repo);
  expect(readFileSync(join(repo,"lookup-role"),"utf8")).toBe("executor");
 }finally{clearInterval(timer);}
});
test("missing id refusal uses the specified wording",async()=>{
 const ctx=fakeCtx(),dir=tmpDir(),task=createTask(ctx,{brief:{goal:"missing",repo:dir},kind:null,requestedExecutor:null,timeoutS:60});
 updateTask(ctx,task.id,t=>{t.state="running";t.run={dir,attempt:1,executor:"codex",startedAt:1,mode:"current",workdir:dir,logFile:join(dir,"log")};});
 await expect(takeoverTask(ctx,task.id)).rejects.toThrow("Take over needs the agent's session id; `codex` does not report one. Stop the task and retry it interactively instead.");
});
test("a quick successful exit or a quick user-driven exit counts as success",async()=>{
 for(const [code,input] of [[0,false],[130,true]] as const){
  const ctx=fakeCtx(),dir=tmpDir(),task=createTask(ctx,{brief:{goal:"exit",repo:dir},kind:null,requestedExecutor:null,timeoutS:60}),startedAt=Date.now()/1000;
  const run={dir,attempt:1,executor:"codex",startedAt,mode:"current" as const,workdir:dir,logFile:join(dir,"log"),takeover:true};
  for(const [name,value] of Object.entries({pid:"999999999","interactive.json":"{}",exit:String(code),"session.ended":String(startedAt+1)}))writeFileSync(join(dir,name),value);
  if(input)writeFileSync(join(dir,"session.input"),"");
  updateTask(ctx,task.id,t=>{t.state="running";t.run=run;t.takeover={state:"driving",at:startedAt,sessionId:id};});
  const out=await resumeAttempt(ctx,providers.codex,readTask(ctx,task.id)!);
  expect(out.exec.code).toBe(0);expect(out.report).toBe("You drove this task; the agent left no summary");
 }
});

test("take-over reports fall back to the agent's own session file by id",()=>{
 const home=tmpDir(), codex=join(home,"codex"), claude=join(home,".claude","projects","-repo");
 mkdirSync(join(codex,"sessions","2026","10","18"),{recursive:true});mkdirSync(claude,{recursive:true});
 writeFileSync(join(codex,"sessions","2026","10","18",`rollout-2026-10-18T12-00-00-${id}.jsonl`),[
  JSON.stringify({type:"response_item",payload:{role:"assistant",content:[{type:"output_text",text:"first"}]}}),
  JSON.stringify({type:"response_item",payload:{role:"assistant",content:[{type:"output_text",text:"Wrote step2.txt."}]}}),
 ].join("\n"));
 writeFileSync(join(claude,`${id}.jsonl`),JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Claude done."}]}}));
 expect(sessionTranscript("codex",id,{CODEX_HOME:codex},home)).toBe("Wrote step2.txt.");
 expect(sessionTranscript("claude-code",id,{},home)).toBe("Claude done.");
 expect(sessionTranscript("codex","../x",{CODEX_HOME:codex},home)).toBe("");
 expect(sessionTranscript("cursor",id,{},home)).toBe("");
});
