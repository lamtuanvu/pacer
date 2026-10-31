import {serve,type PluginManifest} from '../../../packages/plugin-sdk/src/index';
import {createHash} from 'node:crypto';
const manifest:PluginManifest={id:'http-registry-fixture',publisher:'test',version:'1.0.0',host:'^1',contributes:{diagnostic:{}},capabilities:[{name:'net.http',scopes:['127.0.0.1']}],reentrant:true,tier:'free'};
let handle:string|undefined,finish:(()=>void)|undefined;
await serve({manifest,handlers:{'diagnostic.ping':async(raw,host)=>{
 const p=raw as {mode:string;url:string;kind?:string};
 if(p.mode==='first') {handle=(await host.call<{handle:string}>('capability.net.http.body.begin',{bytes:1})).handle;await new Promise<void>(r=>{finish=r});return {ok:true};}
 if(p.mode==='second') {while(!handle||!finish)await Bun.sleep(1);try{await host.call('capability.net.http.body.stageChunk',{handle,offset:0,base64:'YQ=='});return {wrong:true};}catch(e){return {code:(e as {code?:string}).code};}finally{finish();}}
 const body=p.kind==='nul'?'\0'.repeat(4194304):'界'.repeat(1398101)+'a';
 const result=await host.http({url:p.url,method:'POST',body,timeoutMs:10000});
 return {status:result.status,bytes:Buffer.byteLength(result.body),hash:createHash('sha256').update(result.body).digest('hex')};
}}});
