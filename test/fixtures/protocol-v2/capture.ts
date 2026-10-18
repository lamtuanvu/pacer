// Run BEFORE modifying protocol source: bun test/fixtures/protocol-v2/capture.ts
// A fixed temporary home keeps serialized repo paths deterministic. Never run concurrently.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCtx } from '../../helpers';
import { writeJsonAtomic } from '../../../src/fsutil';
import { handleV2 } from '../../../src/api/http';
import { publish } from '../../../src/link/publish';
import type { TaskRecord, TaskState } from '../../../src/tasks/types';
import type { Status } from '../../../src/engine/status';

export const root = '/tmp/pacer-protocol-v2-golden';
export const taskId = (n: number) => `t-20261010-190000-${String(n).padStart(4, '0')}`;
export async function fixture() {
 rmSync(root,{recursive:true,force:true}); mkdirSync(root,{recursive:true});
 const ctx=fakeCtx({home:root,pacerHome:join(root,'.pacer'),now:1791633600,which:()=>null,
 run:async()=>({code:0,stdout:'',stderr:''})});
 mkdirSync(ctx.pacerHome,{recursive:true});
 await Bun.write(join(ctx.pacerHome,'strategy.yaml'),'name: default\nplanner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\nhosts:\n  build:\n    ssh: builder\n');
 // Pin the persisted RepoRef too: /tmp resolves differently on macOS and Linux.
 const states:TaskState[]=['queued','running','done','partial','failed','limit','stopped','needs_input'];
 states.forEach((state,i)=>{
 const t:TaskRecord={id:taskId(i),rev:1,createdAt:ctx.now-i,brief:{goal:`Fixture ${state}`,repo:root},repo:{key:'local:fa5472fa3a53',label:'pacer-protocol-v2-golden',path:'/private/tmp/pacer-protocol-v2-golden'},kind:null,requestedExecutor:null,timeoutS:60,state,attempts:[]};
 if(state==='needs_input')t.question={text:'Which approach?',at:ctx.now};
 writeJsonAtomic(join(ctx.pacerHome,'tasks',`${t.id}.json`),t);
 });
 await publish(ctx,[{type:'alert',data:{key:'fixture',level:'warn',title:'Fixture attention',body:'Check the build',at:ctx.now}}]);
 const status:Status={generatedAt:ctx.now,strategy:'default',planner:'claude-code',mode:'normal',disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}};
 return {ctx,status};
}
export function normalize(value: any): any {
 // These process properties are the only non-deterministic response fields.
 if(value?.snapshot?.service){value.snapshot.service.pid=0;value.snapshot.service.startedAt=0;}
 return value;
}
export async function capture() {
 const previousTZ=process.env.TZ;process.env.TZ="Asia/Ho_Chi_Minh";
 try {
 const {ctx,status}=await fixture();
 const request=async(path:string,params?:unknown)=>{
 const r=await handleV2(new Request(`http://localhost/v2/${path}`,params===undefined?{}:{method:'POST',body:JSON.stringify(params)}),{getCtx:()=>ctx,status:async()=>status});
 if(r.status!==200)throw new Error(`${path}: ${await r.text()}`);
 return normalize(await r.json());
 };
 const out:Record<string,unknown>={};
 out.hello=await request('hello'); out.snapshot=await request('snapshot');
 out['task-list']=await request('ops/task.list',{});
 out['task-list-filtered']=await request('ops/task.list',{states:['done','failed']});
 out['task-get']=await request('ops/task.get',{id:taskId(2)});
 out['task-diff']=await request('ops/task.diff',{id:taskId(2)});
 const res=await handleV2(new Request('http://localhost/v2/events?since=0'),{getCtx:()=>ctx});
 const reader=res.body!.getReader();let text='';
 // The initial comment and first poll are queued synchronously.
 text+=new TextDecoder().decode((await reader.read()).value);
 const {eventsSince}=await import('../../../src/api/events');
 const count=eventsSince(ctx,0).events.length;
 for(let i=0;i<count;i++)text+=new TextDecoder().decode((await reader.read()).value);
 await reader.cancel();out.events=text;
 out['task-review']=await request('ops/task.review',{id:taskId(2),accepted:true});
 return out;
 } finally { if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ; }
}
if(import.meta.main){for(const [name,data] of Object.entries(await capture()))await Bun.write(join(import.meta.dir,`${name}.json`),JSON.stringify(data,null,2)+'\n');}
