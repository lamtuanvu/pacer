import {expect,test} from 'bun:test';
import {capture} from './fixtures/protocol-v2/capture';

test('v2 preserves pre-upgrade goldens while allowing additive snapshot fields',async()=>{
 for(const [name,value] of Object.entries(await capture())) {
  const golden = await Bun.file(`${import.meta.dir}/fixtures/protocol-v2/${name}.json`).json();
  if (name === 'snapshot') {
   // service.version is the live pacer version; the golden records pre-upgrade output.
   const live=(value as any).snapshot?.service?.version;
   if (golden.snapshot?.service?.version) { expect(live).toMatch(/^\d+\.\d+\.\d+/); golden.snapshot.service.version=live; }
   // Attention is intentionally re-derived by the new workflow, not frozen data.
   const current=(value as any).snapshot;
   delete golden.snapshot.attention;
   delete golden.snapshot.counts;
   expect(current.attention.some((a:any)=>a.id==='review:t-20261010-190000-0002')).toBe(false);
   expect(current.attention.find((a:any)=>a.taskId==='t-20261010-190000-0003')).toMatchObject({kind:'failed',severity:'problem'});
   expect(current.counts).toMatchObject({review:0,attention:5,problems:5});
   expect(value).toMatchObject(golden);
   expect(value).toMatchObject({snapshot:{machine:{used:1,max:2}}});
  } else if (name === 'hello') {
   const live=value as any;
   expect(live.ops).toContain('task.request_review');
   expect({...live,pacer:golden.pacer,ops:live.ops.filter((op:string)=>op!=='task.request_review')}).toEqual(golden);
  } else {
   // The live pacer version changes every release; the golden records pre-upgrade output.
   const live=value as Record<string,unknown>;
   if (typeof golden?.pacer === 'string') expect(live.pacer).toMatch(/^\d+\.\d+\.\d+/);
   const comparable=typeof golden?.pacer === 'string' ? {...live,pacer:golden.pacer} : live;
   if(golden===null || typeof golden!=='object') expect(comparable).toEqual(golden);
   else expect(comparable).toMatchObject(golden);
  }
 }
});

test('pure snapshot conversion rebuilds legacy fields from a serialized v3 read model',async()=>{
 const {fixture}=await import('./fixtures/protocol-v2/capture');
 const {liveSnapshot}=await import('../src/api/events');
 const {toV2Snapshot}=await import('../src/api/v2-compat');
 const {ctx,status}=await fixture();
 const wire=JSON.parse(JSON.stringify((await liveSnapshot(ctx,{status:async()=>status})).snapshot));
 const before=JSON.stringify(wire),v2=toV2Snapshot(wire);
 expect(JSON.stringify(wire)).toBe(before);
 expect(v2.budget).toMatchObject({planner:wire.planner.runner,mode:wire.planner.mode});
 expect(v2.budget!.providers).toHaveLength(wire.executors.length);
 expect(v2.alerts.map(a=>a.key)).toEqual(wire.attention.map((a:any)=>a.id));
 expect(v2.service.protocol).toBe('2.8.0');expect(v2).toHaveProperty('console',null);
});

test('v2 validates accepted and retains the limit-only bare summary array',async()=>{
 const {fixture,taskId}=await import('./fixtures/protocol-v2/capture');
 const {callV2Op}=await import('../src/api/v2-compat');const {ctx}=await fixture();
 expect(await callV2Op(ctx,'task.list',{limit:1})).toEqual([expect.objectContaining({task_id:taskId(7)})]);
 expect(callV2Op(ctx,'task.review',{id:taskId(2),accepted:'yes'})).rejects.toMatchObject({code:'invalid_input'});
});

test('operations added after 2.8.0 stay out of the frozen 2.x surface',async()=>{
 const {v2Hello,callV2Op,v2OpJsonSchemas}=await import('../src/api/v2-compat');
 const {helloBody}=await import('../src/api/protocol');
 const {fakeCtx}=await import('./helpers');
 expect(helloBody().ops).toContain('task.takeover');
 expect(v2Hello().ops).not.toContain('task.takeover');
 expect(v2OpJsonSchemas()['task.takeover']).toBeUndefined();
 await expect(callV2Op(fakeCtx(),'task.takeover',{id:'t-x'})).rejects.toMatchObject({code:'unknown_op'});
});

test('desktop capture stays on v3 and does not change v2 client registration',async()=>{
 const {v2Hello,callV2Op,v2OpJsonSchemas}=await import('../src/api/v2-compat');
 const {fakeCtx}=await import('./helpers');
 expect(v2Hello().ops).not.toContain('desktop.capture.request');
 expect((v2OpJsonSchemas()['client.register'].params as {properties:Record<string,unknown>}).properties).not.toHaveProperty('capture');
 const registration=await callV2Op(fakeCtx(),'client.register',{kind:'desktop',version:'test',capture:true});
 expect(registration).not.toHaveProperty('capture_worker');
});
