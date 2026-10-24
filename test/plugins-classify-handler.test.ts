import {expect,test} from 'bun:test';
import {handlers} from '../plugins/pacer-classify/index';
import type {HostClient} from '@pacer/plugin';
const host:HostClient={http:async()=>{throw Error('unexpected HTTP')},secrets:{present:async()=>false},call:async()=>{throw Error('unexpected capability')},log:async()=>{},config:async()=>({})};
const ask={adapter:'rules',config:{},state:'{"goal":"add tests"}',question:{type:'choice',id:'task_kind',instructions:'classify',criteria:{tests:'tests',default:'other'}},timeoutMs:0.5};
const invoke=(p:unknown)=>handlers['classifier.ask']!(p,host,new AbortController().signal);
test('rules dispatch preserves full reading and positive fractional/huge timeout domain',async()=>{for(const timeoutMs of [0.5,120001,9e15])expect(await invoke({...ask,timeoutMs})).toMatchObject({value:'tests',confidence:0.7,latencyMs:0,costUsd:0});});
test('handler refuses missing/wrong adapter snapshot and invalid input before capabilities',async()=>{for(const p of [{...ask,config:undefined},{...ask,config:{key:'value'}},{...ask,adapter:'unknown'},{...ask,state:7},{...ask,timeoutMs:0},{...ask,timeoutMs:Infinity},{...ask,question:{type:'bad'}}])await expect(invoke(p)).rejects.toMatchObject({code:'invalid_input'});});
test('strict provider snapshots refuse raw credential/unknown config keys',async()=>{for(const config of [{baseUrl:'http://localhost',model:'x',maxTokens:1,keyRef:null,apiKey:'secret'},{baseUrl:'http://localhost',model:'x',maxTokens:1,keyRef:'raw-secret'}])await expect(invoke({...ask,adapter:'ollama',config})).rejects.toMatchObject({code:'invalid_input'});});
const projection={adapters:{rules:{},ollama:{baseUrl:'http://localhost:1234/v1',model:'fixture',maxTokens:512,keyRef:null},jev:{baseUrl:'https://api.typesafe.ai',model:'fixture',keyRef:'env:FIXTURE',usdPerMtokIn:null,usdPerMtokOut:null}}};
test('adapter metadata uses configured URL and refuses absent projection',async()=>{
 const call=(config:unknown)=>handlers['classifier.adapters']!({}, {...host,config:async()=>config as Record<string,unknown>},new AbortController().signal);
 expect(await call(projection)).toEqual({adapters:[{id:'rules',external:false},{id:'ollama',external:false},{id:'jev',external:true}]});
 expect(await call({adapters:{...projection.adapters,ollama:{...projection.adapters.ollama,baseUrl:'https://remote.example/v1'}}})).toMatchObject({adapters:[{id:'rules',external:false},{id:'ollama',external:true},{id:'jev',external:true}]});
 await expect(call({})).rejects.toMatchObject({code:'invalid_input'});
});
test('ask uses supplied snapshot without consulting mutable host config',async()=>{
 let called=false;const provider:HostClient={...host,config:async()=>{throw Error('must not read config')},http:async request=>{called=true;expect(request.url).toBe('http://localhost:1234/v1/chat/completions');expect(JSON.parse(request.body!).model).toBe('fixture');return {status:200,headers:{},body:JSON.stringify({choices:[{message:{content:'{"choice":"tests","confidence":0.8}'}}]})};}};
 expect(await handlers['classifier.ask']!({...ask,adapter:'ollama',config:projection.adapters.ollama},provider,new AbortController().signal)).toMatchObject({value:'tests',confidence:0.8,costUsd:0});expect(called).toBe(true);
});
