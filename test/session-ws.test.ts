import { socketPath } from '../src/session/host';
import { expect, test } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/serve/http';
import { createSession } from '../src/serve/app-auth';
import { createTask } from '../src/tasks/store';
import { FrameType, WireDecoder, wire } from '../src/session/framing';
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
