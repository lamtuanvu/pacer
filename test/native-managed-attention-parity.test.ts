import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { apiTasks } from "../src/api/read-model/tasks";
import { liveSnapshot, liveV2Snapshot } from "../src/api/events";
import { buildRustProbe, closeRustProbe, readModelCtx, rustRequest, rustSnapshot } from "./read-model-rust-helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir,"../src/cli.ts")]);
const status = async (ctx: ReturnType<typeof readModelCtx>) => ({generatedAt:ctx.now,strategy:"default",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}}) as never;
function fixture() {
 const ctx=readModelCtx({which:()=>null,readOnly:true,now:Math.floor(Date.now()/1000)}), ids:Record<string,string>={};
 for(const [name,state,managed] of [["retry","failed",true],["limit","limit",true],["answer","needs_input",true],["ordinary","failed",false]] as const){
  const task=createTask(ctx,{brief:{repo:ctx.home,goal:`${name} parity`},kind:"feature",requestedExecutor:null,timeoutS:60});
  if(managed)registerWork(ctx,task.id); updateTask(ctx,task.id,t=>{t.state=state;t.executor="codex";if(state==="needs_input")t.question={text:"Which?",at:ctx.now-10};});ids[name]=task.id;
 }
 mkdirSync(join(ctx.pacerHome,"state"),{recursive:true});
 writeFileSync(join(ctx.pacerHome,"state","attention.json"),JSON.stringify(Object.fromEntries(Object.entries(ids).map(([name,id])=>[`${name === "answer" ? "question" : name === "limit" ? "limit" : "failed"}:${id}`,{since:ctx.now-30}]))));
 return {ctx,ids,records:Object.values(ids).map(id=>readTask(ctx,id)!)};
}
const selected=(items:any[],ids:Record<string,string>)=>items.filter(item=>Object.values(ids).includes(item.taskId)).sort((a,b)=>a.id.localeCompare(b.id));
const normalizeSnapshot=(value:any)=>{const copy=structuredClone(value);if(copy.snapshot?.service){copy.snapshot.service.pid=0;copy.snapshot.service.startedAt=0;}if(copy.snapshot?.machine){copy.snapshot.machine.os="PLATFORM";copy.snapshot.machine.arch="ARCH";}if(copy.snapshot?.console)copy.snapshot.console.pid=0;return copy;};
const actions=(items:any[],ids:Record<string,string>)=>Object.fromEntries(Object.entries(ids).map(([name,id])=>[name,items.find(item=>item.taskId===id)?.actions[0]]));
beforeAll(buildRustProbe,600_000);afterAll(closeRustProbe);

test("Rust task reads and attention snapshots match TypeScript for managed and ordinary work, including v2 fallback",async()=>{
 const {ctx,ids,records}=fixture(),expectedTasks=apiTasks(ctx,records),actualTasks=await rustRequest(ctx,{op:"tasks",records}) as any[];
 expect(actualTasks).toEqual(expectedTasks);
 const options={status};
 const v3=await liveSnapshot(ctx,options),rust3=await rustSnapshot(ctx,v3,options,3) as typeof v3;
 expect(selected(rust3.snapshot.attention,ids)).toEqual(selected(v3.snapshot.attention,ids));
 const v3actions=actions(v3.snapshot.attention,ids);
 expect(v3actions.retry).toMatchObject({op:"dispatch.retry",params:{id:ids.retry,expect_rev:2,requestId:`${ids.retry}.2.retry`}});
 expect(v3actions.limit).toMatchObject({op:"dispatch.retry",params:{id:ids.limit,expect_rev:2,requestId:`${ids.limit}.2.retry`}});
 expect(v3actions.answer).toMatchObject({op:"dispatch.answer",params:{id:ids.answer,expect_rev:2,requestId:`${ids.answer}.2.answer`}});
 expect(v3actions.ordinary).toMatchObject({op:"task.retry",params:{id:ids.ordinary}});
 const v2=await liveV2Snapshot(ctx,options),rust2=await rustSnapshot(ctx,v2,options,2) as typeof v2;
 expect(normalizeSnapshot(rust2)).toEqual(normalizeSnapshot(v2));
 expect(selected(rust2.snapshot.attention,ids)).toEqual(selected(v2.snapshot.attention,ids));
 expect(actions(v2.snapshot.attention,ids).answer).toMatchObject({op:"ui.open",params:{id:ids.answer,view:"task",tab:"answer"}});
 expect(actions(v2.snapshot.attention,ids).retry).toMatchObject({op:"ui.open",params:{id:ids.retry,view:"task"}});
 expect(actions(v2.snapshot.attention,ids).limit).toMatchObject({op:"ui.open",params:{id:ids.limit,view:"task"}});
 expect(actions(v2.snapshot.attention,ids).ordinary).toMatchObject({op:"task.retry",params:{id:ids.ordinary}});
},120_000);

async function exchange(home:string,forward:boolean){
 const child=Bun.spawn([front!,"api","--stdio"],{env:{HOME:home,PACER_HOME:join(home,".pacer"),PACER_PORT:"1",PATH:`${join(import.meta.dir,"../.work/sandbox-bin")}:/usr/bin:/bin`,PACER_CORE_ARGV:core,PACER_NO_UPDATE_CHECK:"1",PACER_NO_SELF_REPAIR:"1",PACER_DISCOVERY:"off",PACER_DEBUG_NATIVE:"1",...(forward?{PACER_FORWARD_OPS:"snapshot.get"}:{})},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 try{await child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"hello",params:{protocol:3}})+"\n"+JSON.stringify({jsonrpc:"2.0",id:2,method:"snapshot.get",params:{}})+"\n");await child.stdin.end();const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,stderr).toBe(0);expect(stderr.includes("native snapshot.get 2")).toBe(!forward);return JSON.parse(stdout.trim().split("\n")[1]!);}finally{if(child.exitCode===null){child.kill("SIGTERM");await child.exited;}}
}
test.skipIf(!front)("native front-door snapshot emits the same managed attention as forwarded TypeScript",async()=>{
 const {ctx,ids}=fixture(),a=mkdtempSync(join(tmpdir(),"pacer-native-managed-")),b=mkdtempSync(join(tmpdir(),"pacer-forward-managed-"));
 try{cpSync(ctx.home,a,{recursive:true});cpSync(ctx.home,b,{recursive:true});const native=await exchange(a,false),forwarded=await exchange(b,true);expect(selected(native.result.snapshot.attention,ids)).toEqual(selected(forwarded.result.snapshot.attention,ids));expect(actions(native.result.snapshot.attention,ids)).toMatchObject({retry:{op:"dispatch.retry"},limit:{op:"dispatch.retry"},answer:{op:"dispatch.answer"},ordinary:{op:"task.retry"}});}finally{rmSync(a,{recursive:true,force:true});rmSync(b,{recursive:true,force:true});}
},120_000);
