import {expect,test} from "bun:test";
import {existsSync,mkdirSync,renameSync,statSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx,tmpDir} from "./helpers";
import {createTask,readTask,updateTask,withTaskLock,withTaskLockAsync,withTaskPreparation} from "../src/tasks/store";
import {withLock} from "../src/core/lock";
import {CoreError} from "../src/core/errors";
import {withTimeout} from "../src/core/path-probe";
const fixture=()=>{const ctx=fakeCtx();const task=createTask(ctx,{brief:{goal:"work",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});return {ctx,task,lock:join(ctx.pacerHome,"orca",`task-${task.id}.lock`)};};

test("async task preparation refuses local sync writers without blocking and admits final reentrant commit",async()=>{
 const {ctx,task,lock}=fixture();let release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const pending=withTaskPreparation(ctx,task.id,async()=>{entered();await gate;return "prepared";},value=>updateTask(ctx,task.id,t=>{t.brief.context=value;}));
 await ready;const before=Date.now();expect(()=>updateTask(ctx,task.id,t=>{t.kind="debug";})).toThrow(CoreError);expect(Date.now()-before).toBeLessThan(200);
 const waiter=withTaskLockAsync(ctx,task.id,()=>updateTask(ctx,task.id,t=>{t.kind="tests";}));
 release();expect((await pending).brief.context).toBe("prepared");await waiter;expect(readTask(ctx,task.id)?.kind).toBe("tests");expect(existsSync(lock)).toBe(false);
});

test("preparation timeout, abort and commit failures release file and process markers",async()=>{
 for(const failure of ["timeout","abort","commit"]){
  const {ctx,task,lock}=fixture();let effects=0;
  const pending=withTaskPreparation(ctx,task.id,async()=>{
   if(failure==="timeout")return withTimeout(()=>new Promise<void>(()=>{}),20);
   if(failure==="abort")throw new CoreError("not_allowed","Cancelled");
  },()=>{effects++;throw Error("commit failed");});
  await expect(pending).rejects.toThrow();expect(effects).toBe(failure==="commit"?1:0);expect(existsSync(lock)).toBe(false);
  expect(()=>updateTask(ctx,task.id,t=>{t.kind="tests";})).not.toThrow();
 }
});

test("preparation cannot enter while a synchronous reentrant task marker is held",async()=>{
 const {ctx,task}=fixture();let preparations=0;
 const result=withTaskLock(ctx,task.id,()=>withTaskPreparation(ctx,task.id,async()=>{preparations++;},()=>undefined));
 await expect(result).rejects.toMatchObject({code:"conflict"});expect(preparations).toBe(0);
});

test("an async commit callback is refused before effects begin",async()=>{
 const {ctx,task}=fixture();let effects=0;
 await expect(withTaskPreparation(ctx,task.id,async()=>undefined,(async()=>{effects++;}) as any)).rejects.toMatchObject({code:"invalid_input"});expect(effects).toBe(0);
});

test("a child waiting on the task lock re-probes replaced repository before committing",async()=>{
 const {ctx,task}=fixture(),repo=tmpDir(),original=statSync(repo),script=join(tmpDir(),"prepare.ts");
 writeFileSync(script,`import {stat} from "node:fs/promises";const {withTaskPreparation,updateTask}=await import(${JSON.stringify(new URL("../src/tasks/store.ts",import.meta.url).href)});const input=JSON.parse(process.argv[2]);const ctx={...input.ctx,run:async()=>({code:127,stdout:"",stderr:""}),which:()=>null};console.log("ready");try{await withTaskPreparation(ctx,input.id,async()=>{const s=await stat(input.repo);if(s.dev!==input.dev||s.ino!==input.ino)throw Object.assign(Error("changed"),{code:"conflict"});},()=>updateTask(ctx,input.id,t=>{t.kind="tests";}));console.log("committed");}catch(error){console.log(JSON.stringify({code:error.code}));}`);
 let child:ReturnType<typeof Bun.spawn>|undefined;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 await withLock(ctx,`task-${task.id}`,async()=>{
  child=Bun.spawn([process.execPath,script,JSON.stringify({ctx:{home:ctx.home,pacerHome:ctx.pacerHome,now:ctx.now,env:{}},id:task.id,repo,dev:original.dev,ino:original.ino})],{stdout:"pipe",stderr:"pipe"});
  reader=(child.stdout as ReadableStream<Uint8Array>).getReader();expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
  renameSync(repo,`${repo}-retired`);mkdirSync(repo);
 });
 let output="";for(;;){const part=await reader!.read();if(part.done)break;output+=new TextDecoder().decode(part.value);}
 expect(await child!.exited).toBe(0);expect(output).toContain('"code":"conflict"');expect(output).not.toContain("committed");expect(readTask(ctx,task.id)?.kind).toBeNull();
});
