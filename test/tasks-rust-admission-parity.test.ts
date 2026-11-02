import {expect,test} from "bun:test";
import {existsSync,mkdirSync,writeFileSync,readFileSync,statSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx} from "./helpers";
import {createTask,readTask,updateTask,listTasksWhere} from "../src/tasks/store";
import {registerWork,getWork} from "../src/dispatch/work";
const binary=process.env.PACER_ADMISSION_PROBE_BIN;
const enabled=!!binary&&existsSync(binary);
async function rust(command:string,home:string,...args:string[]) {
 if(!binary)throw Error("PACER_ADMISSION_PROBE_BIN required");
 const child=Bun.spawn([binary,command,home,...args],{stdout:"pipe",stderr:"pipe"});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw Error(err);return JSON.parse(out);
}
function fixture(){const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true,mode:0o700});writeFileSync(join(ctx.pacerHome,".sqlite-proof-home"),"disposable\n");return ctx;}
test.skipIf(!enabled)("Rust and Bun child admission contend on one descendant budget without orphan tasks",async()=>{
 const ctx=fixture(),root=createTask(ctx,{brief:{goal:"root",repo:ctx.pacerHome},kind:null,requestedExecutor:null,timeoutS:60});
 registerWork(ctx,root.id,{allowDelegation:true,maxDescendants:1});updateTask(ctx,root.id,t=>{t.state="running";});
 const script=`import {registerWork} from ${JSON.stringify(new URL("../src/dispatch/work.ts",import.meta.url).href)};import {createTask} from ${JSON.stringify(new URL("../src/tasks/store.ts",import.meta.url).href)};const [home,parent]=process.argv.slice(1);const ctx={pacerHome:home,now:1};try{const task=createTask(ctx,{brief:{goal:"bun child",repo:home},kind:null,requestedExecutor:null,timeoutS:60},t=>registerWork(ctx,t.id,{},parent));console.log(JSON.stringify({ok:true,id:task.id}));}catch(e){console.log(JSON.stringify({error:String(e)}));}`;
 const bun=Bun.spawn([process.execPath,"-e",script,ctx.pacerHome,root.id],{stdout:"pipe",stderr:"pipe"});
 const [native,out,err,code]=await Promise.all([rust("child",ctx.pacerHome,root.id,"t-20261102-000000-0001"),new Response(bun.stdout).text(),new Response(bun.stderr).text(),bun.exited]);
 expect(code,err).toBe(0);const ts=JSON.parse(out);expect([native,ts].filter(r=>r.ok)).toHaveLength(1);
 expect(listTasksWhere(ctx)).toHaveLength(2);
 const child=listTasksWhere(ctx).find(t=>t.id!==root.id)!;expect(getWork(ctx,child.id)?.rootId).toBe(root.id);
 expect(await rust("work",ctx.pacerHome,child.id)).toEqual(getWork(ctx,child.id));
});
test.skipIf(!enabled)("competing Rust drains reserve a single slot, TS observes JSON write-through, reads never drain",async()=>{
 const ctx=fixture();for(let i=0;i<4;i++){const t=createTask(ctx,{brief:{goal:"queued",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});updateTask(ctx,t.id,t=>{t.queue={reason:"no_slot",since:1,position:1};});}
 const tasks=listTasksWhere(ctx);for(const t of tasks){expect((await rust("read",ctx.pacerHome,t.id)).state).toBe("queued");}
 const results=await Promise.all([rust("drain",ctx.pacerHome),rust("drain",ctx.pacerHome)]);expect(results.flat()).toHaveLength(1);
 expect(listTasksWhere(ctx).filter(t=>t.state==="running")).toHaveLength(1);
 for(const t of listTasksWhere(ctx)){
  expect(JSON.parse(readFileSync(join(ctx.pacerHome,"tasks",`${t.id}.json`),"utf8"))).toEqual(readTask(ctx,t.id));
  expect(statSync(join(ctx.pacerHome,"tasks",`${t.id}.json`)).mode&0o777).toBe(0o600);
 }
});
test.skipIf(!enabled)("Bun and Rust admission check the same revision before recording one review verdict",async()=>{
 const {readLabels}=await import("../src/tasks/labels");
 const ctx=fixture(),task=createTask(ctx,{brief:{goal:"review",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 const rev=updateTask(ctx,task.id,t=>{t.state="done";}).rev;
 const release=join(ctx.home,"release"),nativeReady=join(ctx.home,"rust-ready"),bunReady=join(ctx.home,"bun-ready");
 const native=rust("review",ctx.pacerHome,task.id,String(rev),"accept",nativeReady,release);
 const bun=Bun.spawn([process.execPath,new URL("./fixtures/task-admission/review-worker.ts",import.meta.url).pathname,ctx.pacerHome,task.id,String(rev),"reject",bunReady,release],{stdout:"pipe",stderr:"pipe"});
 const until=Date.now()+10_000;while((!existsSync(nativeReady)||!existsSync(bunReady))&&Date.now()<until)await Bun.sleep(5);
 expect(existsSync(nativeReady)&&existsSync(bunReady)).toBe(true);writeFileSync(release,"go");
 const [nativeResult,out,err,code]=await Promise.all([native,new Response(bun.stdout).text(),new Response(bun.stderr).text(),bun.exited]);
 expect(code,err).toBe(0);const outcomes=[nativeResult,JSON.parse(out)];expect(outcomes.filter(r=>r.ok)).toHaveLength(1);
 expect(outcomes.filter(r=>r.code==="conflict")).toEqual([{code:"conflict",rev:rev+1}]);
 expect(readTask(ctx,task.id)?.rev).toBe(rev+1);expect(readLabels(ctx).filter(l=>l.type==="task_review")).toHaveLength(1);
});
