import {expect,test,spyOn} from 'bun:test';
import {serve,PROTOCOL,type ObservationClient} from '@pacer/plugin';
function channel(){const lines:string[]=[];let wake=()=>{};let closed=false;return {input:{async *[Symbol.asyncIterator](){for(;;){while(lines.length)yield lines.shift()!;if(closed)return;await new Promise<void>(resolve=>{wake=resolve;});}}},send:(value:unknown)=>{lines.push(JSON.stringify(value));wake();},close:()=>{closed=true;wake();}};}
const manifest={id:'event-sdk',publisher:'pacer',version:'1.0.0',host:'^1.6',capabilities:[{name:'tasks.read'},{name:'events.subscribe'}],contributes:{policy:{}}};
async function until(check:()=>boolean){const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw Error('event deadline');await Bun.sleep(1);}}
test('events bootstrap only during a real owned method and callbacks use independent readOwner',async()=>{
 const ch=channel(),writes:any[]=[];let callback:ObservationClient|undefined;let task:any;
 const done=serve({manifest,input:ch.input,write:line=>{const r=JSON.parse(line);writes.push(r);if(r.method==='capability.events.subscribe')ch.send({jsonrpc:'2.0',id:r.id,result:{ok:true,readOwner:'generation-owner'}});if(r.method==='capability.tasks.read')ch.send({jsonrpc:'2.0',id:r.id,result:{task:{id:'t-event',state:'queued'}}});},onEvent:async(_event,host)=>{callback=host;task=await host.tasks.read('t-event');}});
 ch.send({jsonrpc:'2.0',id:1,method:'plugin.hello',params:{protocol:PROTOCOL,pacer:'0.9.0',features:['policyObservations'],manifest,config:{},grants:['tasks.read','events.subscribe']}});
 await until(()=>writes.some(r=>r.id===1));expect(writes.some(r=>r.method==='capability.events.subscribe')).toBe(false);
 ch.send({jsonrpc:'2.0',id:2,method:'diagnostic.ping',params:{},_meta:{capabilityCall:'owned-call'}});
 await until(()=>writes.some(r=>r.id===2));expect(writes.find(r=>r.method==='capability.events.subscribe')._meta).toEqual({capabilityCall:'owned-call'});
 ch.send({jsonrpc:'2.0',method:'$/event',params:{seq:1,at:1,type:'task',data:{id:'t-event'}}});await until(()=>task!==undefined);
 expect(task).toEqual({id:'t-event',state:'queued'});expect(writes.find(r=>r.method==='capability.tasks.read')._meta).toEqual({readOwner:'generation-owner'});
 expect(callback).not.toHaveProperty('call');expect(callback).not.toHaveProperty('fs');
 ch.close();await done;await expect(callback!.tasks.read('after-eof')).rejects.toMatchObject({code:'plugin_unavailable'});
});
test('callback failures are contained, mixed metadata refused and fresh process subscribes anew',async()=>{
 const warn=spyOn(console,'error').mockImplementation(()=>{});
 try{for(let generation=0;generation<2;generation++){
  const ch=channel(),writes:any[]=[];let calls=0;
  const done=serve({manifest,input:ch.input,write:line=>{const r=JSON.parse(line);writes.push(r);if(r.method==='capability.events.subscribe')ch.send({jsonrpc:'2.0',id:r.id,result:{ok:true,readOwner:`owner-${generation}`}});},onEvent:()=>{calls++;throw Error('private error must not escape');}});
  ch.send({jsonrpc:'2.0',id:1,method:'plugin.hello',params:{protocol:PROTOCOL,pacer:'0.9.0',features:['policyObservations'],manifest,config:{},grants:['events.subscribe']}});
  ch.send({jsonrpc:'2.0',id:2,method:'diagnostic.ping',params:{},_meta:{capabilityCall:'mixed',readOwner:'foreign'}});await until(()=>writes.some(r=>r.id===2));expect(writes.find(r=>r.id===2)).toMatchObject({error:{data:{code:'capability_denied'}}});
  ch.send({jsonrpc:'2.0',id:3,method:'diagnostic.ping',params:{},_meta:{capabilityCall:`call-${generation}`}});await until(()=>writes.some(r=>r.id===3));
  ch.send({jsonrpc:'2.0',method:'$/event',params:{seq:1,at:1,type:'task',data:{}}});await until(()=>calls===1);ch.close();await done;
  expect(writes.filter(r=>r.method==='capability.events.subscribe')).toHaveLength(1);
 }}finally{expect(warn).toHaveBeenCalled();warn.mockRestore();}
});

test('SDK callback backlog is bounded, resets oversized data and retires on persistent reset blockage',async()=>{
 const {EventCallbacks}=await import('../packages/plugin-sdk/src/event-callbacks');
 let finish!:()=>void;let fatal=0;const received:any[]=[];
 const callbacks=new EventCallbacks(async event=>{received.push(event);await new Promise<void>(resolve=>{finish=resolve;});},()=>{fatal++;});
 callbacks.push({seq:1,at:1,type:'task',data:{}});await until(()=>received.length===1);
 for(let n=2;n<400;n++)callbacks.push({seq:n,at:1,type:'task',data:{}});
 expect(fatal).toBe(1);expect(callbacks.pending).toEqual({count:0,bytes:0});finish();
 const resets:any[]=[];const oversized=new EventCallbacks(event=>{resets.push(event);},()=>{throw Error('unexpected fatal');});
 oversized.push({seq:1,at:1,type:'task',data:{large:'x'.repeat(300*1024)}});await until(()=>resets.length===1);
 expect(resets[0]).toMatchObject({seq:1,type:'reset'});expect(Buffer.byteLength(JSON.stringify(resets[0]))).toBeLessThan(1024);oversized.close();
});

test('persistent callback backpressure closes serve and revokes the isolated callback client',async()=>{
 const ch=channel(),writes:any[]=[];let callback:ObservationClient|undefined;
 const done=serve({manifest,input:ch.input,write:line=>{const r=JSON.parse(line);writes.push(r);if(r.method==='capability.events.subscribe')ch.send({jsonrpc:'2.0',id:r.id,result:{ok:true,readOwner:'blocked-owner'}});},onEvent:async(_event,host)=>{callback=host;await new Promise<void>(()=>{});}});
 const closed=done.then(()=>({ok:true}),error=>({error}));
 ch.send({jsonrpc:'2.0',id:1,method:'plugin.hello',params:{protocol:PROTOCOL,pacer:'0.9.0',features:['policyObservations'],manifest,config:{},grants:['events.subscribe']}});
 ch.send({jsonrpc:'2.0',id:2,method:'diagnostic.ping',params:{},_meta:{capabilityCall:'bootstrap'}});await until(()=>writes.some(r=>r.id===2));
 ch.send({jsonrpc:'2.0',method:'$/event',params:{seq:1,at:1,type:'task',data:{}}});await until(()=>callback!==undefined);
 for(let seq=2;seq<400;seq++)ch.send({jsonrpc:'2.0',method:'$/event',params:{seq,at:1,type:'task',data:{}}});
 try{expect(await closed).toMatchObject({error:{code:'plugin_unavailable',message:'event callback queue cannot deliver reset'}});await expect(callback!.tasks.read('after-retirement')).rejects.toMatchObject({code:'plugin_unavailable'});}finally{ch.close();}
});
