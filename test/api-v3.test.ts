import {expect,test} from 'bun:test';
import {handleV2} from '../src/api/http';
import {fixture,taskId} from './fixtures/protocol-v2/capture';

test('v3 exposes only the read model and advertises the previous protocol',async()=>{
 const {ctx,status}=await fixture();const deps={getCtx:()=>ctx,status:async()=>status};
 const hello=await (await handleV2(new Request('http://localhost/v3/hello'),deps)).json();
 expect(hello).toMatchObject({protocol:'3.0.0',previous:'2.8.0'});
 expect(hello.events).not.toContain('budget');expect(hello.events).not.toContain('alert');expect(hello.events).toContain('planner');
 const r=await (await handleV2(new Request('http://localhost/v3/snapshot'),deps)).json();
 expect(Object.keys(r.snapshot).sort()).toEqual(['seq','at','service','planner','mode','counts','attention','executors','accounts','hosts','repos','tasks','today','setup','pause','strategies'].sort());
});

test('v3 ops always paginate, require verdict and return only patch',async()=>{
 const {ctx}=await fixture();
 const op=async(name:string,params:unknown)=>handleV2(new Request(`http://localhost/v3/ops/${name}`,{method:'POST',body:JSON.stringify(params)}),{getCtx:()=>ctx});
 expect((await (await op('task.list',{})).json()).result).toMatchObject({tasks:expect.any(Array),next:null});
 expect((await op('task.review',{id:taskId(2),accepted:true})).status).toBe(400);
 expect((await op('task.review',{id:taskId(2),verdict:'accept'})).status).toBe(200);
 const diff=(await (await op('task.diff',{id:taskId(2)})).json()).result;
 expect(diff.patch).toBe('');expect(diff).not.toHaveProperty('diff');
});

test('v3 resets a 2.x cursor even when retained history has no gap',async()=>{
 const {ctx}=await fixture();
 const r=await handleV2(new Request('http://localhost/v3/events?since=1'),{getCtx:()=>ctx});
 expect(r.status).toBe(200);const reader=r.body!.getReader();let text='';
 for(let i=0;i<2;i++)text+=new TextDecoder().decode((await reader.read()).value);
 await reader.cancel();expect(text).toContain('event: reset');
});

test('v3 event cursors resume without resetting or replaying and preserve publication time',async()=>{
 const {ctx}=await fixture();
 const {eventsSince}=await import('../src/api/events');
 const first=eventsSince(ctx,0,3);
 expect(first.events.map(e=>e.type)).toEqual(['notify']);
 expect(first.events[0]!.at).toBe(ctx.now);
 expect(eventsSince(ctx,first.last,3)).toEqual({events:[],last:first.last,reset:false});
 const {publish}=await import('../src/link/publish');
 await publish({...ctx,now:ctx.now+5},[{v:1,type:'budget',data:{generatedAt:ctx.now+5,strategy:'default',planner:'claude-code',mode:'normal',providers:[],ranked:[]}}],{bridge:false,channel:false});
 const next=eventsSince({...ctx,now:ctx.now+10},first.last,3);
 expect(next.events).toHaveLength(1);expect(next.events[0]).toMatchObject({type:'planner',at:ctx.now+5,data:{runner:'claude-code'}});
 expect(next.reset).toBe(false);
 const {toV2Event}=await import('../src/api/v2-compat');
 expect(toV2Event(next.events[0] as any)).toMatchObject({type:'budget',seq:2});
});

test('v3 resets old cursors in an empty outbox and preserves retention-gap resets',async()=>{
 const {eventsSince}=await import('../src/api/events');
 const {V3_CURSOR_BASE}=await import('../src/api/v2-compat');
 const {fakeCtx}=await import('./helpers');const ctx=fakeCtx();
 expect(eventsSince(ctx,1,3)).toMatchObject({reset:true,events:[{type:'reset'}]});
 const {appendOutbox}=await import('../src/link/store');
 appendOutbox(ctx,[{seq:50,envelope:{v:1,type:'config',data:{area:'config',at:ctx.now}}}]);
 const batch=eventsSince(ctx,V3_CURSOR_BASE+10,3);
 expect(batch.reset).toBe(true);expect(batch.events.map(e=>e.seq)).toEqual([V3_CURSOR_BASE+49,V3_CURSOR_BASE+50]);
});

test('stdio negotiates v3, rejects unsupported protocols and defaults to v2 per connection',async()=>{
 const {runStdio}=await import('../src/api/stdio');
 const {ctx}=await fixture();
 async function rpc(messages:any[]) {
  const out:any[]=[];
  await runStdio(ctx,(async function*(){for(const message of messages)yield JSON.stringify({jsonrpc:'2.0',...message});})(),line=>out.push(JSON.parse(line)));
  return new Map(out.map(message=>[message.id,message]));
 }
 const v3=await rpc([{id:1,method:'hello',params:{protocol:3}},{id:2,method:'snapshot'},{id:3,method:'task.list'},{id:4,method:'task.review',params:{id:taskId(2),accepted:true}}]);
 expect(v3.get(1).result).toMatchObject({protocol:'3.0.0',previous:'2.8.0'});
 expect(v3.get(2).result.snapshot).not.toHaveProperty('budget');
 expect(v3.get(3).result).toMatchObject({tasks:expect.any(Array),next:null});
 expect(v3.get(4).error.data.code).toBe('invalid_input');
 const v2=await rpc([{id:1,method:'hello'},{id:2,method:'task.list'},{id:3,method:'hello',params:{protocol:4}},{id:4,method:'hello',params:{protocol:2}}]);
 expect(v2.get(1).result.protocol).toBe('2.8.0');expect(Array.isArray(v2.get(2).result)).toBe(true);
 expect(v2.get(3).error.data.code).toBe('invalid_input');expect(v2.get(4).result.protocol).toBe('2.8.0');
});

test('durable outbox drops v and reads both old and new entries',async()=>{
 const {fakeCtx}=await import('./helpers');const ctx=fakeCtx();
 const {appendOutbox,readOutboxSince}=await import('../src/link/store');
 const {outboxPath}=await import('../src/link/paths');
 const {appendFileSync}=await import('node:fs');
 const data={area:'config',at:ctx.now};
 appendOutbox(ctx,[{seq:1,envelope:{v:1,type:'config',data}}]);
 expect((await Bun.file(outboxPath(ctx)).json()).envelope).toEqual({type:'config',data});
 appendFileSync(outboxPath(ctx),JSON.stringify({seq:2,envelope:{v:1,type:'config',data}})+'\n');
 expect(readOutboxSince(ctx,0).map(e=>e.envelope)).toEqual([{type:'config',data},{type:'config',data}]);
 const {parseOutboxEvent}=await import('../src/link/envelope');
 expect(parseOutboxEvent({v:2,type:'config',data})).toBeNull();
});

test('stdio v3 subscriptions reset old cursors and deliver only v3 events',async()=>{
 const {runStdio}=await import('../src/api/stdio');const {ctx}=await fixture();const out:any[]=[];
 await runStdio(ctx,(async function*(){
  yield JSON.stringify({jsonrpc:'2.0',id:1,method:'hello',params:{protocol:3}});
  yield JSON.stringify({jsonrpc:'2.0',id:2,method:'subscribe',params:{since:1}});
  const deadline=Date.now()+2000;
  while(!out.some(message=>message.method==='event')) {
   if(Date.now()>deadline)throw new Error('stdio events timed out');
   await Bun.sleep(5);
  }
 })(),line=>out.push(JSON.parse(line)),{pollMs:5});
 const events=out.filter(message=>message.method==='event').map(message=>message.params);
 expect(events.map(event=>event.type)).toEqual(['reset','notify']);
});
