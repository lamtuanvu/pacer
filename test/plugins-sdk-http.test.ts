import { expect, test } from 'bun:test';
import { createHttp } from '../packages/plugin-sdk/src/http';
const LIMIT=4*1024*1024;
function fixture(options: {feature?:boolean; fits?:(method:string,params:unknown)=>boolean; response?:unknown}={}) {
  const calls:{method:string;params:any}[]=[];
  const controller=new AbortController();
  const http=createHttp({signal:controller.signal, negotiated:()=>options.feature??true,
    fits:options.fits??(()=>true),
    call:async(method,params)=>{calls.push({method,params});if(method.endsWith('.begin'))return {handle:'upload'};if(method.endsWith('.stageChunk'))return {bytes:(params as any).offset+Buffer.from((params as any).base64,'base64').length};if(method.endsWith('.release'))return {ok:true};return options.response??{status:200,headers:{},body:'ok'};}});
  return {http,calls,controller};
}
test('inline string public shape and no transport changes',async()=>{const f=fixture();expect(await f.http({url:'https://owned.invalid',method:'POST',body:'hello',timeoutMs:10})).toEqual({status:200,headers:{},body:'ok'});expect(f.calls.map(c=>c.method)).toEqual(['capability.net.http']);});
test('4MiB multibyte stages complete bytes, not truncated codepoints',async()=>{const body='界'.repeat(Math.floor(LIMIT/3));const f=fixture({fits:(m,p)=>m!=='capability.net.http'||typeof (p as any).body!=='string'});await f.http({url:'https://owned.invalid',method:'POST',body,timeoutMs:10});expect(f.calls.filter(c=>c.method.endsWith('.stageChunk')).reduce((n,c)=>n+Buffer.from(c.params.base64,'base64').length,0)).toBe(Buffer.byteLength(body));});
test('NUL JSON expansion uses chunks despite small decoded body',async()=>{const f=fixture({fits:(m,p)=>Buffer.byteLength(JSON.stringify(p))+100<1024*1024});await f.http({url:'https://owned.invalid',method:'POST',body:'\0'.repeat(1024*1024),timeoutMs:10});expect(f.calls.some(c=>c.method.endsWith('.begin'))).toBe(true);});
test('oversized metadata rejected before any call',async()=>{const f=fixture({fits:()=>false});await expect(f.http({url:'x',method:'GET',timeoutMs:10})).rejects.toThrow();expect(f.calls).toHaveLength(0);});
test('feature absence refuses escaped body before begin/network',async()=>{const f=fixture({feature:false,fits:()=>false});await expect(f.http({url:'x',method:'POST',body:'\0'.repeat(300000),timeoutMs:10})).rejects.toThrow();expect(f.calls).toHaveLength(0);});
test('decoded body bound refuses over4MiB before effects',async()=>{const f=fixture();await expect(f.http({url:'x',method:'POST',body:'a'.repeat(LIMIT+1),timeoutMs:10})).rejects.toThrow();expect(f.calls).toHaveLength(0);});
test('already aborted request has no effects',async()=>{const f=fixture();f.controller.abort();await expect(f.http({url:'x',method:'GET',timeoutMs:10})).rejects.toThrow();expect(f.calls).toHaveLength(0);});
test('4MiB response roundtrips multibyte split at arbitrary byte boundary',async()=>{
 const body='界'.repeat(Math.floor(LIMIT/3)), bytes=Buffer.from(body);const released:string[]=[];
 const http=createHttp({negotiated:()=>true,fits:()=>true,call:async(method,p:any)=>{
  if(method==='capability.net.http')return {status:200,headers:{x:'ok'},body:{handle:'down',bytes:bytes.length}};
  if(method.endsWith('.readChunk'))return {base64:bytes.subarray(p.offset,p.offset+p.length).toString('base64')};
  released.push(p.handle);return {ok:true};}});
 expect((await http({url:'x',method:'GET',timeoutMs:10})).body).toBe(body);expect(released).toEqual(['down']);
});
test('invalid UTF8 replacement expansion refuses decoded overlimit and releases',async()=>{
 const bytes=Buffer.alloc(2*1024*1024,255),released:string[]=[];
 const http=createHttp({negotiated:()=>true,fits:()=>true,call:async(m,p:any)=>{
  if(m==='capability.net.http')return {status:200,headers:{},body:{handle:'down',bytes:bytes.length}};
  if(m.endsWith('.readChunk'))return {base64:bytes.subarray(p.offset,p.offset+p.length).toString('base64')};released.push(p.handle);return {ok:true};}});
 await expect(http({url:'x',method:'GET',timeoutMs:10})).rejects.toThrow('decoded');expect(released).toEqual(['down']);
});
test('abort after begin awaits release and never sends HTTP',async()=>{
 const c=new AbortController(),calls:string[]=[];const http=createHttp({signal:c.signal,negotiated:()=>true,fits:(m,p)=>m!=='capability.net.http'||typeof(p as any).body!=='string',call:async(m)=>{calls.push(m);if(m.endsWith('.begin')){queueMicrotask(()=>c.abort());return {handle:'up'};}return {ok:true};}});
 await expect(http({url:'x',method:'POST',body:'abc',timeoutMs:10})).rejects.toThrow();expect(calls).toContain('capability.net.http.body.release');expect(calls).not.toContain('capability.net.http');
});
test('cleanup failure cannot silently return successful reading',async()=>{
 const http=createHttp({negotiated:()=>true,fits:()=>true,call:async(m)=>{if(m==='capability.net.http')return {status:200,headers:{},body:{handle:'d',bytes:0}};throw new Error('cleanup failure');}});
 await expect(http({url:'x',method:'GET',timeoutMs:10})).rejects.toThrow('cleanup failure');
});
test('noncanonical response base64 rejects and releases rather than truncates',async()=>{
 const released:string[]=[];const http=createHttp({negotiated:()=>true,fits:()=>true,call:async(m,p:any)=>{if(m==='capability.net.http')return {status:200,headers:{},body:{handle:'d',bytes:1}};if(m.endsWith('.readChunk'))return {base64:'Zh=='};released.push(p.handle);return {ok:true};}});
 await expect(http({url:'x',method:'GET',timeoutMs:10})).rejects.toThrow('chunk');expect(released).toEqual(['d']);
});
test('owning deadline abort while HTTP pending refuses result and releases response handle',async()=>{
 const c=new AbortController(),released:string[]=[];const http=createHttp({signal:c.signal,negotiated:()=>true,fits:()=>true,call:async(m,p:any)=>{if(m==='capability.net.http'){await new Promise(r=>setTimeout(r,5));c.abort();return {status:200,headers:{},body:{handle:'d',bytes:1}};}if(m.endsWith('.release')){released.push(p.handle);return {ok:true};}throw new Error('read after deadline');}});
 await expect(http({url:'x',method:'GET',timeoutMs:1})).rejects.toThrow('ended');expect(released).toEqual(['d']);
});
test('whole transaction queue advances after first failure and cleanup',async()=>{
 const events:string[]=[];let calls=0;
 const http=createHttp({negotiated:()=>true,fits:()=>true,call:async(m)=>{if(m==='capability.net.http'){const n=++calls;events.push('http'+n);if(n===1)return {status:200,headers:{},body:{handle:'d',bytes:1}};return {status:200,headers:{},body:'second'};}if(m.endsWith('.readChunk'))throw new Error('first failed');if(m.endsWith('.release')){events.push('release');return {ok:true};}throw Error(m);}});
 const both=await Promise.allSettled([http({url:'x',method:'GET',timeoutMs:10}),http({url:'x',method:'GET',timeoutMs:10})]);
 expect(both[0].status).toBe('rejected');expect(both[1].status).toBe('fulfilled');expect(events).toEqual(['http1','release','http2']);
});
test('queued abort rejects promptly with no queued capability effects',async()=>{
 const controller=new AbortController();let release!:()=>void;let count=0;
 const blocker=new Promise<void>(resolve=>{release=resolve;});
 const http=createHttp({signal:controller.signal,negotiated:()=>true,fits:()=>true,call:async()=>{count++;await blocker;return {status:200,headers:{},body:'ok'};}});
 const first=http({url:'x',method:'GET',timeoutMs:10});await Promise.resolve();
 const second=http({url:'x',method:'GET',timeoutMs:10});controller.abort();
 await expect(second).rejects.toThrow('ended');expect(count).toBe(1);release();await expect(first).rejects.toThrow('ended');await Promise.resolve();expect(count).toBe(1);
});
