import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {PluginRegistry} from '../src/plugins/registry';
import type {PluginManifest} from '../src/plugins/protocol';
import {fakeCtx} from './helpers';
import {join} from 'node:path';
const manifest:PluginManifest={id:'http-registry-fixture',publisher:'test',version:'1.0.0',host:'^1',contributes:{diagnostic:{}},capabilities:[{name:'net.http',scopes:['127.0.0.1']}],reentrant:true,tier:'free'};
function setup(peer="sdk-peer.ts"){const ctx=fakeCtx();ctx.readOnly=true;const registry=new PluginRegistry({bundled:[{manifest,main:async()=>({handlers:{}})}],spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'fixtures/http-registry',peer)],cwd:ctx.home,env:{}})});return {ctx,registry};}
const options={resources:{reads:[],commands:[],stores:[],http:{hosts:['127.0.0.1']}},deadlineMs:30000};
test('actual registry SDK HTTP roundtrips full4MiB escaped and multibyte bodies',async()=>{
 const {ctx,registry}=setup();const received:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,maxRequestBodySize:5*1024*1024,async fetch(r){const body=await r.text();received.push(createHash('sha256').update(body).digest('hex'));return new Response(body);}});
 try{for(const kind of ['nul','multi']){const expected=kind==='nul'?'\0'.repeat(4194304):'界'.repeat(1398101)+'a';const hash=createHash('sha256').update(expected).digest('hex');expect(await registry.call(ctx,manifest.id,'diagnostic.ping',{mode:'http',kind,url:`http://127.0.0.1:${server.port}/echo`},options)).toEqual({status:200,bytes:4194304,hash});expect(received.at(-1)).toBe(hash);}expect(received).toHaveLength(2);}finally{await registry.shutdown();await server.stop(true);}
},30000);
test('actual concurrent registry owners cannot stage another live owners upload',async()=>{
 const {ctx,registry}=setup();try{const first=registry.call(ctx,manifest.id,'diagnostic.ping',{mode:'first'},options);const second=registry.call(ctx,manifest.id,'diagnostic.ping',{mode:'second'},options);expect(await second).toEqual({code:'capability_denied'});expect(await first).toEqual({ok:true});}finally{await registry.shutdown();}
},10000);

test('actual1.1 peer cannot negotiate HTTP body chunks even when it advertises them',async()=>{
 const {ctx,registry}=setup('legacy-peer.ts');try{expect(await registry.call(ctx,manifest.id,'diagnostic.ping',{},options)).toEqual({code:'capability_denied',unexpectedHandle:null});}finally{await registry.shutdown();}
},10000);
