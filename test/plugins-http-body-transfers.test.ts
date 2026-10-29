import {test,expect,afterEach} from 'bun:test';
import {createCallAuthority,type CallAuthority} from '../src/plugins/authority';
import {fakeCtx} from './helpers';
import {BodyTransfers} from '../src/plugins/http-body-transfers';
const MAX=4194304,CHUNK=262144, owners:CallAuthority[]=[];
function owner(grants=['net.http']){const a=createCallAuthority(fakeCtx(),{reads:[],commands:[],stores:[]},{deadlineMs:Date.now()+30000,grants});owners.push(a);return a;}
afterEach(async()=>{await Promise.all(owners.splice(0).map(a=>a.revoke()));});
test('exact4MiB UTF8 upload and response preserve BOM, scalar and NUL bytes',async()=>{
 const m=new BodyTransfers(),a=owner();const body='\ufeff'+ '界'.repeat(1398098)+'\0'.repeat(7);expect(Buffer.byteLength(body)).toBe(MAX);
 const bytes=Buffer.from(body),u=await m.begin(a,bytes.length,true);
 for(let p=0;p<bytes.length;p+=CHUNK){const end=Math.min(bytes.length,p+CHUNK);expect(await m.stage(a,u.handle,p,bytes.subarray(p,end).toString('base64'))).toEqual({bytes:end});}
 expect(await m.consume(a,u.handle)).toBe(body);
 const response=await m.publish(a,body,true,()=>true);expect(response.bytes).toBe(MAX);const chunks:Buffer[]=[];
 for(let p=0;p<MAX;p+=CHUNK){chunks.push(Buffer.from((await m.read(a,response.handle,p,CHUNK)).base64,'base64'));}
 expect(Buffer.concat(chunks).equals(bytes)).toBe(true);expect(await m.release(a,response.handle)).toEqual({ok:true});expect(await m.release(a,response.handle)).toEqual({ok:true});
});
test('cross-owner, wrong-direction and consumed handles never attach to successors',async()=>{
 const m=new BodyTransfers(),a=owner(),b=owner(),u=await m.begin(a,1,true);
 await expect(m.stage(b,u.handle,0,'YQ==')).rejects.toMatchObject({code:'capability_denied'});
 await expect(m.read(a,u.handle,0,1)).rejects.toMatchObject({code:'capability_denied'});
 await m.stage(a,u.handle,0,'YQ==');expect(await m.consume(a,u.handle)).toBe('a');
 await expect(m.consume(a,u.handle)).rejects.toMatchObject({code:'capability_denied'});
 const v=await m.begin(a,1,true);expect(v.handle).not.toBe(u.handle);
 await expect(m.stage(a,u.handle,0,'YQ==')).rejects.toMatchObject({code:'capability_denied'});
});
test('upload rejects incomplete, reordered, overflow, invalid UTF8 and noncanonical base64',async()=>{
 const m=new BodyTransfers(),a=owner(),u=await m.begin(a,1,true);
 await expect(m.consume(a,u.handle)).rejects.toMatchObject({code:'invalid_input'});
 for(const [offset,text] of [[1,'YQ=='],[0,'YWI='],[0,'YR==']] as const)await expect(m.stage(a,u.handle,offset,text)).rejects.toMatchObject({code:'invalid_input'});
 await m.stage(a,u.handle,0,'/w==');await expect(m.consume(a,u.handle)).rejects.toMatchObject({code:'invalid_input'});
});
test('feature, grants, bounds and revocation refuse transfer effects',async()=>{
 const m=new BodyTransfers(),a=owner();await expect(m.begin(a,1,false)).rejects.toMatchObject({code:'capability_denied'});
 await expect(m.begin(owner([]),1,true)).rejects.toMatchObject({code:'capability_denied'});
 for(const n of [-1,MAX+1,NaN,1.5])await expect(m.begin(a,n,true)).rejects.toMatchObject({code:'invalid_input'});
 const u=await m.begin(a,0,true);await a.revoke();await expect(m.consume(a,u.handle)).rejects.toMatchObject({code:'capability_denied'});
});
test('undeliverable response descriptor is refused before publishing a handle',async()=>{
 const m=new BodyTransfers(),a=owner();let tried=0;await expect(m.publish(a,'safe',true,()=>{tried++;return false;})).rejects.toMatchObject({code:'invalid_input'});expect(tried).toBe(1);
 const response=await m.publish(a,'safe',true,()=>true);expect(response.bytes).toBe(4);expect(await m.read(a,response.handle,0,4)).toEqual({base64:'c2FmZQ=='});
});

test('pending payload slots refuse replacement and resume after explicit release',async()=>{
 const m=new BodyTransfers(),a=owner();const u=await m.begin(a,1,true);
 await expect(m.begin(a,1,true)).rejects.toMatchObject({code:'conflict'});
 await m.release(a,u.handle);const next=await m.begin(a,0,true);expect(await m.consume(a,next.handle)).toBe('');
 const r=await m.publish(a,'ok',true,()=>true);
 await expect(m.publish(a,'replacement',true,()=>true)).rejects.toMatchObject({code:'conflict'});
 await expect(m.read(a,r.handle,1,1)).rejects.toMatchObject({code:'invalid_input'});
 await expect(m.read(a,r.handle,0,CHUNK+1)).rejects.toMatchObject({code:'invalid_input'});
 expect(await m.read(a,r.handle,0,2)).toEqual({base64:'b2s='});
 await m.release(a,r.handle);expect((await m.publish(a,'next',true,()=>true)).bytes).toBe(4);
 await expect(m.release(owner(),r.handle)).rejects.toMatchObject({code:'capability_denied'});
});
test('descriptor serialization cannot publish after ownership expires',async()=>{
 const m=new BodyTransfers(),a=owner();
 await expect(m.publish(a,'safe',true,()=>{void a.revoke();return true;})).rejects.toMatchObject({code:'capability_denied'});
});

test('response capacity is reserved before network effects and reusable after failure', async()=>{
 const m=new BodyTransfers(),a=owner();let effects=0;
 const first=await m.publish(a,'pending',true,()=>true);
 const attempt=async()=>{const token=await m.reserveResponse(a);try{effects++;}finally{await m.cancelResponse(a,token);}};
 await expect(attempt()).rejects.toMatchObject({code:'conflict'});expect(effects).toBe(0);
 await m.release(a,first.handle);await attempt();expect(effects).toBe(1);
 const token=await m.reserveResponse(a);
 await expect(m.reserveResponse(a)).rejects.toMatchObject({code:'conflict'});
 await expect(m.publish(a,'bypass',true,()=>true)).rejects.toMatchObject({code:'conflict'});
 await expect(m.cancelResponse(owner(),token)).rejects.toMatchObject({code:'capability_denied'});
 const r=await m.publish(a,'safe',true,()=>true,token);
 expect(await m.read(a,r.handle,0,4)).toEqual({base64:'c2FmZQ=='});
 await expect(m.cancelResponse(a,token)).rejects.toMatchObject({code:'capability_denied'});
});

test('reentrant descriptor checks cannot overwrite an admitted response', async()=>{
 const m=new BodyTransfers(),a=owner();let inner:Promise<{handle:string;bytes:number}>|undefined;
 await expect(m.publish(a,'outer',true,()=>{inner=m.publish(a,'inner',true,()=>true);return true;})).rejects.toMatchObject({code:'conflict'});
 const r=await inner!;expect(await m.read(a,r.handle,0,5)).toEqual({base64:'aW5uZXI='});
});

test('an undeliverable chunk does not advance its response cursor', async()=>{
 const m=new BodyTransfers(),a=owner();const r=await m.publish(a,'payload',true,()=>true);
 await expect(m.read(a,r.handle,0,7,()=>false)).rejects.toMatchObject({code:'invalid_input'});
 expect(await m.read(a,r.handle,0,7,()=>true)).toEqual({base64:'cGF5bG9hZA=='});
});
