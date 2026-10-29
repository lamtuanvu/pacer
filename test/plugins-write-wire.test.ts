import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,statSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {serve} from '@pacer/plugin';
import {makeCtx} from '../src/ctx';
import {createCallAuthority} from '../src/plugins/authority';
import {prepareWriteAuthority} from '../src/plugins/capability-write';
import {answerCapability} from '../src/plugins/host';
import {pluginRpcError} from '../src/plugins/errors';
import {manifestSchema} from '../src/plugins/protocol';
function channel(){const queue:string[]=[];let wake:(()=>void)|undefined,closed=false;return {send(value:unknown){queue.push(JSON.stringify(value));wake?.();wake=undefined;},close(){closed=true;wake?.();},input:{async *[Symbol.asyncIterator](){for(;;){while(queue.length)yield queue.shift()!;if(closed)return;await new Promise<void>(r=>{wake=r;});}}}};}
async function fixture(protocol:string){
 const root=mkdtempSync(join(tmpdir(),'pacer-write-wire-')),home=join(root,'home');mkdirSync(home);
 const ctx=makeCtx({home:root,pacerHome:home}),dir=join(home,'opencode'),path=join(dir,'opencode.json');
 const owner=createCallAuthority(ctx,{reads:[],commands:[],stores:[],writes:[{path:dir,kind:'directory',operations:['mkdir']},{path,kind:'file',operations:['write']}]},{deadlineMs:Date.now()+5000,grants:['fs.write']});
 const manifest=manifestSchema.parse({id:'fx-writer',version:'1.0.0',publisher:'fixture',host:'^1.5',contributes:{},capabilities:[{name:'fs.write',scopes:['${PACER_HOME}/opencode','${PACER_HOME}/opencode/**']}]});
 const input=channel(),frames:string[]=[],jobs:Promise<void>[]=[];
 let result!:(value:any)=>void;const response=new Promise<any>(resolve=>{result=resolve;});
 const text='\ufeff'+'界'.repeat(400000);
 await prepareWriteAuthority(owner);
 const running=serve({manifest,input:input.input,write:line=>{
  frames.push(line);const packet=JSON.parse(line);
  if(typeof packet.method==='string'){
   const job=answerCapability(ctx,{id:manifest.id,manifest},packet.method,packet.params,owner,undefined,{features:protocol==='1.4.0'?['fileWriteChunks']:[],requestFits:params=>Buffer.byteLength(JSON.stringify({...packet,params})+'\n')<=1048576,resultFits:value=>Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:packet.id,result:value})+'\n')<=1048576})
    .then(value=>{input.send({jsonrpc:'2.0',id:packet.id,result:value});},error=>{input.send({jsonrpc:'2.0',id:packet.id,error:pluginRpcError(error)});});jobs.push(job);
  }else if(packet.id===42)result(packet);
 },handlers:{'diagnostic.ping':async(_params,host)=>{
  if(protocol==='1.4.0')await host.fs.mkdir(dir);
  await host.fs.write(path,text,0o600);await host.fs.write(path,text,0o600);
  return {ok:true,uptimeS:0};
 }}});
 input.send({jsonrpc:'2.0',id:1,method:'plugin.hello',params:{protocol,pacer:'fixture',manifest,config:{},grants:['fs.write'],features:['fileWriteChunks']}});
 input.send({jsonrpc:'2.0',id:42,method:'diagnostic.ping',params:{},_meta:{capabilityCall:owner.token}});
 try{
  const reply=await Promise.race([response,Bun.sleep(3000).then(()=>{throw Error('writer fixture timed out');})]);
  return {reply,frames:frames.map(line=>({bytes:Buffer.byteLength(line),packet:JSON.parse(line)})),text:existsSync(path)?readFileSync(path,'utf8'):null,mode:existsSync(path)?statSync(path).mode&0o777:null,expected:text};
 }finally{await owner.revoke();await Promise.all(jobs);input.close();await running;rmSync(root,{recursive:true,force:true});}
}
test('SDK-to-broker chunks publish exact large UTF8 through actual pinned native writes',async()=>{
 const value=await fixture('1.4.0');expect(value.reply.error).toBeUndefined();expect(value.text).toBe(value.expected);expect(value.mode).toBe(0o600);
 expect(value.frames.every(frame=>frame.bytes<=1048576)).toBe(true);
 expect(value.frames.filter(frame=>frame.packet.method==='capability.fs.commitWrite')).toHaveLength(2);
 expect(value.frames.some(frame=>frame.packet.method==='capability.fs.writeChunk')).toBe(true);
});
test('older negotiated protocol refuses oversized writes before any filesystem request',async()=>{
 const value=await fixture('1.3.0');expect(value.reply.error).toBeDefined();expect(value.text).toBeNull();expect(value.frames.filter(frame=>frame.packet.method)).toHaveLength(0);
});
test('broker rejects request or acknowledgement overflow before filesystem effects',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pacer-write-envelope-')),ctx=makeCtx({home:root,pacerHome:root}),dir=join(root,'opencode');
 const owner=createCallAuthority(ctx,{reads:[],commands:[],stores:[],writes:[{path:dir,kind:'directory',operations:['mkdir']}]},{deadlineMs:Date.now()+5000,grants:['fs.write']});
 const manifest=manifestSchema.parse({id:'fx-writer',version:'1.0.0',publisher:'fixture',host:'^1.5',capabilities:[{name:'fs.write',scopes:['${PACER_HOME}/opencode']}]});
 try{await prepareWriteAuthority(owner);for(const [request,result] of [[false,true],[true,false]]){
 await expect(answerCapability(ctx,{id:manifest.id,manifest},'capability.fs.mkdir',{path:dir},owner,undefined,{features:['fileWriteChunks'],requestFits:()=>request!,resultFits:()=>result!})).rejects.toMatchObject({code:'too_large'});
 expect(existsSync(dir)).toBe(false);
 }}finally{await owner.revoke();rmSync(root,{recursive:true,force:true});}
});
