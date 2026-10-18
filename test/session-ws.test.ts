import { socketPath } from '../src/session/host';
import { expect, test } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/serve/http';
import { createSession } from '../src/serve/app-auth';
import { createTask, updateTask } from '../src/tasks/store';
import { FrameType, WireDecoder, wire } from '../src/session/framing';
import { upgradeSession, sessionWebSocket, type SessionWS } from '../src/serve/session-ws';
import { Recording } from '../src/session/recording';
import { fakeCtx } from './helpers';
// Match the existing session integration convention: sandboxed runners may forbid listeners.
const canBind=(()=>{try{const probe=Bun.serve({port:0,fetch:()=>new Response('probe')});probe.stop(true);return true;}catch{return false;}})();
async function fixture(){
 const ctx=fakeCtx();const task=createTask(ctx,{brief:{goal:'ws',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:300});
 const dir=join(ctx.pacerHome,'runs',task.id,'1');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'session.log'),'');
 const received:{type:number;data:Buffer}[]=[];let peer:Socket|undefined;
 const unix=createServer(s=>{peer=s;const d=new WireDecoder();s.on('data',b=>{for(const f of d.push(Buffer.from(b))){received.push(f);if(f.type===1){s.write(wire(2,{outputOffset:10,cols:120,rows:40}));s.write(wire(3,Buffer.from([0,255,27])));}}});});
 const path=socketPath(dir);writeFileSync(join(dir,'session.sock.path'),path);
 await new Promise<void>((resolve,reject)=>{unix.once('error',reject);unix.listen(path,resolve);});
 const http=startServer(()=>ctx,{port:0,pumpMs:3600000});const url=`http://127.0.0.1:${http.port}/v2/tasks/${task.id}/session`;
 return {ctx,http,url,received,close(){peer?.destroy();unix.close();http.stop();}};
}
test.skipIf(!canBind)('session upgrades require auth; cookie GET requires trusted Origin and fetch site',async()=>{
 const f=await fixture();try{
 expect((await fetch(f.url)).status).toBe(401);
 const cookie=`pacer_session=${createSession(f.ctx)}`;
 expect((await fetch(f.url,{headers:{cookie,origin:'http://evil.example'}})).status).toBe(403);
 expect((await fetch(f.url,{headers:{cookie,origin:new URL(f.url).origin,'sec-fetch-site':'cross-site'}})).status).toBe(403);
 expect((await fetch(f.url,{headers:{cookie}})).status).toBe(403);
 }finally{f.close();}
});
test.skipIf(!canBind)('bridge preserves binary bytes, JSON controls and from; tags text hello as app',async()=>{
 const f=await fixture();let ws:WebSocket|undefined;try{
 const messages:(string|Buffer)[]=[];
 ws=new WebSocket(f.url.replace('http:','ws:')+'?from=7',{headers:{authorization:`Bearer ${f.http.token}`}} as any);
 ws.binaryType='arraybuffer';
 await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=reject;});
 ws.onmessage=e=>messages.push(typeof e.data==='string'?e.data:Buffer.from(e.data));
 ws.send(JSON.stringify({type:'hello',v:1,client:'cli',label:'browser',cols:80,rows:24}));
 for(let i=0;i<100&&messages.length<2;i++)await Bun.sleep(5);
 expect(JSON.parse(f.received[0].data.toString())).toMatchObject({client:'app',from:7,label:'browser'});
 expect(JSON.parse(messages[0] as string)).toMatchObject({type:'snapshot',outputOffset:10});
 expect(messages[1]).toEqual(wire(3,Buffer.from([0,255,27])));
 ws.send(new Uint8Array(wire(FrameType.hello,{v:1,client:'cli',from:2})));
 for(let i=0;i<100&&f.received.length<2;i++)await Bun.sleep(5);
 expect(JSON.parse(f.received[1].data.toString()).client).toBe('app');
 }finally{ws?.close();f.close();}
});

test.skipIf(!canBind)('same-origin cookie client can upgrade without X-Pacer-Client',async()=>{
 const f=await fixture();let ws:WebSocket|undefined;
 try{
  ws=new WebSocket(f.url.replace('http:','ws:'),{headers:{cookie:`pacer_session=${createSession(f.ctx)}`,origin:new URL(f.url).origin,'sec-fetch-site':'same-origin'}} as any);
  await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=reject;});
  expect(ws.readyState).toBe(WebSocket.OPEN);
 }finally{ws?.close();f.close();}
});

async function recordedFixture(){
 const ctx=fakeCtx();const task=createTask(ctx,{brief:{goal:'offline ws',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:300});
 const dir=join(ctx.pacerHome,'runs',task.id,'1');mkdirSync(dir,{recursive:true});
 const recording=new Recording(dir);
 await recording.output(Buffer.from('prefix'));recording.checkpoint();
 await recording.output(Buffer.from([0,255,27,65,66]));await recording.close();
 writeFileSync(join(dir,'exit'),'7');
 return {ctx,dir,task};
}
async function offlineFixture(){
 const {ctx,dir,task}=await recordedFixture();
 const http=startServer(()=>ctx,{port:0,pumpMs:3600000});
 const url=`http://127.0.0.1:${http.port}/v2/tasks/${task.id}/session`;
 return {ctx,dir,http,url};
}
async function replayMessages(f:Awaited<ReturnType<typeof offlineFixture>>,query='',commands:(string|Buffer)[]=[]){
 const ws=new WebSocket(f.url.replace('http:','ws:')+query,{headers:{authorization:`Bearer ${f.http.token}`}} as any);
 ws.binaryType='arraybuffer';const frames:{type:string;[key:string]:any}[]=[];
 await new Promise<void>((resolve,reject)=>{
  ws.onmessage=e=>{
   if(typeof e.data==='string')frames.push(JSON.parse(e.data));
   else for(const frame of new WireDecoder().push(Buffer.from(e.data)))frames.push({type:'output',data:frame.data});
  };
  ws.onopen=()=>{for(const command of commands)ws.send(typeof command==='string'?command:new Uint8Array(command));ws.send(JSON.stringify({type:'hello',v:1,client:'app'}));};
  ws.onerror=()=>{ws.close();reject(Error('offline WebSocket failed'));};ws.onclose=()=>resolve();
 });
 return frames;
}
test.skipIf(!canBind)('ended session replays checkpoint, byte-exact suffix and recorded exit over WebSocket',async()=>{
 const f=await offlineFixture();try{
  const frames=await replayMessages(f);
  expect(frames.map(f=>f.type)).toEqual(['snapshot','output','exit']);
  expect(frames[0]).toMatchObject({outputOffset:6,screenAnsi:'prefix',controller:null,viewers:1});
  expect(frames[1].data).toEqual(Buffer.from([0,255,27,65,66]));
  expect(frames[2]).toEqual({type:'exit',code:7});
 }finally{f.http.stop();}
});
test.skipIf(!canBind)('offline from resumes retained bytes, including bytes before the checkpoint',async()=>{
 const f=await offlineFixture();try{
  for(const [offset,bytes] of [[3,[102,105,120,0,255,27,65,66]],[8,[27,65,66]],[11,[]]] as const){
   const frames=await replayMessages(f,`?from=${offset}`);
   expect(frames.some(f=>f.type==='snapshot')).toBe(false);
   expect(Buffer.concat(frames.filter(f=>f.type==='output').map(f=>f.data))).toEqual(Buffer.from(bytes));
   expect(frames.at(-1)).toEqual({type:'exit',code:7});
  }
  expect((await replayMessages(f,'?from=999'))[0].type).toBe('snapshot');
 }finally{f.http.stop();}
});
test.skipIf(!canBind)('offline viewers cannot take control, input or resize',async()=>{
 const f=await offlineFixture();try{
  const frames=await replayMessages(f,'',[
   JSON.stringify({type:'take',force:true}),wire(FrameType.input,Buffer.from('overwrite')),
   JSON.stringify({type:'size',cols:10,rows:10}),
  ]);
  expect(frames.filter(f=>f.type==='control')).toEqual(Array(3).fill({type:'control',controller:null,you:false,reason:'read-only'}));
  expect(frames.find(f=>f.type==='snapshot')).toMatchObject({cols:120,rows:40,screenAnsi:'prefix'});
 }finally{f.http.stop();}
});
test.skipIf(!canBind)('not-live recordings replay without exit or with only checkpoint or rotated log',async()=>{
 const f=await offlineFixture();try{
  rmSync(join(f.dir,'exit'));
  writeFileSync(join(f.dir,'session.sock.path'),join(f.dir,'missing.sock'));
  expect((await replayMessages(f)).at(-1)).toEqual({type:'exit',code:null});
  rmSync(join(f.dir,'session.log'));
  expect((await replayMessages(f)).map(f=>f.type)).toEqual(['snapshot','exit']);
  rmSync(join(f.dir,'session.ckpt'));
  const recording=new Recording(f.dir);await recording.output(Buffer.from('log only'));await recording.close();
  renameSync(join(f.dir,'session.log'),join(f.dir,'session.log.1'));rmSync(join(f.dir,'session.ckpt'));
  const frames=await replayMessages(f);
  expect(frames[0]).toMatchObject({type:'snapshot',outputOffset:0,cols:120,rows:40});
  expect(frames[1].data.toString()).toBe('log only');
 }finally{f.http.stop();}
});
test.skipIf(!canBind)('session without a recording remains unavailable',async()=>{
 const f=await offlineFixture();try{
  rmSync(join(f.dir,'session.log'));rmSync(join(f.dir,'session.ckpt'));
  expect((await fetch(f.url,{headers:{authorization:`Bearer ${f.http.token}`}})).status).toBe(409);
 }finally{f.http.stop();}
});

// Exercise the actual upgrade and handler when the sandbox cannot open listeners.
async function localReplay(f:Awaited<ReturnType<typeof recordedFixture>>,query='',commands:(string|Buffer)[]=[]){
 let data:SessionWS|undefined;
 const response=await upgradeSession(new Request('http://localhost/session'+query),{upgrade:(_req:Request,options:{data:SessionWS})=>{data=options.data;return true;}} as any,f.ctx,f.task.id);
 const messages:any[]=[];let closed=false;
 const ws={data,sendText:(message:string)=>{messages.push(JSON.parse(message));return message.length;},
  sendBinary:(message:Buffer)=>{for(const frame of new WireDecoder().push(message))messages.push({type:'output',data:frame.data});return message.length;},
  close:()=>{closed=true;}} as any;
 if(data){
  sessionWebSocket.open!(ws);
  for(const command of commands)sessionWebSocket.message!(ws,typeof command==='string'?command:Buffer.from(new Uint8Array(command)));
  sessionWebSocket.message!(ws,JSON.stringify({type:'hello',v:1,client:'app'}));
 }
 return {response,messages,closed};
}
test('recorded ended session upgrades and emits checkpoint, suffix and exit without a live socket',async()=>{
 const f=await recordedFixture();const result=await localReplay(f);
 expect(result.response).toBeUndefined();expect(result.closed).toBe(true);
 expect(result.messages.map(f=>f.type)).toEqual(['snapshot','output','exit']);
 expect(result.messages[0]).toMatchObject({outputOffset:6,screenAnsi:'prefix',controller:null,viewers:1});
 expect(result.messages[1].data).toEqual(Buffer.from([0,255,27,65,66]));
 expect(result.messages[2]).toEqual({type:'exit',code:7});
});
test('offline handler resumes before and after checkpoint, falls back for missing offsets, and stays read-only',async()=>{
 const f=await recordedFixture();
 for(const [offset,bytes] of [[3,[102,105,120,0,255,27,65,66]],[8,[27,65,66]],[11,[]]] as const){
  const {messages}=await localReplay(f,`?from=${offset}`);
  expect(messages.some(f=>f.type==='snapshot')).toBe(false);
  expect(Buffer.concat(messages.filter(f=>f.type==='output').map(f=>f.data))).toEqual(Buffer.from(bytes));
  expect(messages.at(-1)).toEqual({type:'exit',code:7});
 }
 expect((await localReplay(f,'?from=999')).messages[0].type).toBe('snapshot');
 const {messages}=await localReplay(f,'',[JSON.stringify({type:'take',force:true}),wire(FrameType.input,Buffer.from('change')),JSON.stringify({type:'size',cols:10,rows:10})]);
 expect(messages.filter(f=>f.type==='control')).toEqual(Array(3).fill({type:'control',controller:null,you:false,reason:'read-only'}));
 expect(messages.find(f=>f.type==='snapshot')).toMatchObject({cols:120,rows:40,screenAnsi:'prefix'});
});
test('offline upgrade handles checkpoint-only, rotated-log-only, dead host and absent recording',async()=>{
 const f=await recordedFixture();rmSync(join(f.dir,'exit'));
 // A stale socket path must fall back after the connection is refused.
 writeFileSync(join(f.dir,'session.sock.path'),join(f.dir,'stale.sock'));writeFileSync(join(f.dir,'stale.sock'),'');
 expect((await localReplay(f)).messages.at(-1)).toEqual({type:'exit',code:null});
 rmSync(join(f.dir,'session.log'));
 expect((await localReplay(f)).messages.map(f=>f.type)).toEqual(['snapshot','exit']);
 expect((await localReplay(f,'?from=6')).messages).toEqual([{type:'exit',code:null}]);
 const recording=new Recording(f.dir);await recording.output(Buffer.from('log only'));await recording.close();
 renameSync(join(f.dir,'session.log'),join(f.dir,'session.log.1'));rmSync(join(f.dir,'session.ckpt'));
 const {messages}=await localReplay(f);
 expect(messages[0]).toMatchObject({type:'snapshot',outputOffset:0,cols:120,rows:40});expect(messages[1].data.toString()).toBe('log only');
 rmSync(join(f.dir,'session.log.1'));
 expect((await localReplay(f)).response?.status).toBe(409);
});

test('ended remote session replays from its local recording mirror',async()=>{
 const f=await recordedFixture();
 updateTask(f.ctx,f.task.id,t=>{t.run={host:'remote-box',attempt:1} as NonNullable<typeof t.run>;});
 writeFileSync(join(f.dir,'session.remote-full'),'remote-box');
 const {messages,response,closed}=await localReplay(f);
 expect(response).toBeUndefined();expect(closed).toBe(true);
 expect(messages.map(f=>f.type)).toEqual(['snapshot','output','exit']);
 expect(messages.at(-1)).toEqual({type:'exit',code:7});
});
