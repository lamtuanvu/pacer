import {expect,test} from 'bun:test';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fakeCtx} from './helpers';
import {PluginRegistry} from '../src/plugins/registry';
import {pluginLogPath} from '../src/plugins/host';
import {publish} from '../src/link/publish';
import type {PluginManifest} from '../src/plugins/protocol';
function setup(kind:'normal'|'eof'|'blocked'='normal',peer?:'old'|'no-feature'){const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders: {claude-code: {}}\n');const manifest:PluginManifest={id:'raw-observer',version:'1.0.0',publisher:'pacer',host:'^1.6',contributes:{policy:{},usage:{providers:['synthetic']}},capabilities:[{name:'tasks.read'},{name:'events.subscribe'},{name:'fs.read',scopes:['*']},{name:'fs.write',scopes:['*']},{name:'process.spawn',scopes:['*']}],reentrant:true,tier:'free'};const registry=new PluginRegistry({bundled:[{manifest,main:async()=>({handlers:{}})}],spawnBundled:()=>({argv:kind!=='normal'?['/bin/sh',join(import.meta.dir,'fixtures/policy-observations/eof.sh'),process.execPath,kind]:[process.execPath,join(import.meta.dir,'fixtures/policy-observations/raw.ts'),peer??'negotiated'],cwd:ctx.home,env:{}}),eventPumpMs:0});return {ctx,registry};}
async function until(check:()=>boolean){const end=Date.now()+3500;while(!check()){if(Date.now()>end)throw Error('retirement deadline');await Bun.sleep(5);}}
test('actual all-grants peer cannot substitute readOwner for effects, mixed or foreign authority',async()=>{
 const {ctx,registry}=setup();writeFileSync(join(ctx.home,'sentinel'),'unchanged');try{
  const result=await registry.call<any>(ctx,'raw-observer','diagnostic.ping',{mode:'effects'});
  expect(result.denials).toEqual(Array(6).fill('capability_denied'));expect(readFileSync(join(ctx.home,'sentinel'),'utf8')).toBe('unchanged');expect(existsSync(join(ctx.home,'effect'))).toBe(false);
 }finally{await registry.shutdown();}
});
test('same stdout batch final result closes bootstrap admission before later capability lines',async()=>{
 const {ctx,registry}=setup();try{
  expect((await registry.call<any>(ctx,'raw-observer','diagnostic.ping',{mode:'late'})).ok).toBe(true);
  const log=()=>existsSync(pluginLogPath(ctx,'raw-observer'))?readFileSync(pluginLogPath(ctx,'raw-observer'),'utf8'):'';await until(()=>log().includes('LATE_DENIED'));
  expect((registry as any).entries.get('raw-observer').readOwner).toBeUndefined();expect((registry as any).eventTimer).toBeUndefined();
 }finally{await registry.shutdown();}
});
test('stdout EOF revokes generation read authority even when the child remains alive',async()=>{
 const {ctx,registry}=setup('eof');let pid:number|undefined;try{
  const result=await registry.call<any>(ctx,'raw-observer','diagnostic.ping',{mode:'eof'});pid=result.pid;
  const entry=(registry as any).entries.get('raw-observer');
  await until(()=>entry.readOwner===undefined);expect((registry as any).eventTimer).toBeUndefined();expect(entry.subscription).toBeUndefined();
 }finally{await registry.shutdown();if(pid)expect(()=>process.kill(pid!,0)).toThrow();}
});
test('real blocked child delivery stays bounded and retires the process with a diagnostic',async()=>{
 const {ctx,registry}=setup('blocked');try{
  await registry.call(ctx,'raw-observer','diagnostic.ping',{});const entry=(registry as any).entries.get('raw-observer');
  let blocked=false;
  for(let n=0;n<12;n++){
   await publish(ctx,[{type:'entity',data:{kind:'repo',id:`large${n}`,value:{payload:'x'.repeat(200*1024)}}}]);
   await registry.pumpEvents();await Bun.sleep(5);
   if(entry.subscription){expect(entry.subscription.pending.bytes).toBeLessThanOrEqual(256*1024);expect(entry.subscription.pending.count).toBeLessThanOrEqual(128);if(entry.subscription.pending.count>0){blocked=true;break;}}
  }
  expect(blocked).toBe(true);await until(()=>entry.readOwner===undefined);
  expect(readFileSync(pluginLogPath(ctx,'raw-observer'),'utf8')).toContain('event notification delivery failed');
 }finally{await registry.shutdown();}
},5000);

test('a genuine live owner from another registry process cannot read through this process',async()=>{
 const first=setup(),second=setup();
 try{
  const foreign=await first.registry.call<any>(first.ctx,'raw-observer','diagnostic.ping',{});
  const local=await second.registry.call<any>(second.ctx,'raw-observer','diagnostic.ping',{mode:'effects',foreign:foreign.readOwner});
  expect(foreign.readOwner).not.toBe(local.readOwner);expect(local.denials).toEqual(Array(6).fill('capability_denied'));
 }finally{await Promise.all([first.registry.shutdown(),second.registry.shutdown()]);}
});


test('an actual usage owner cannot bootstrap a generation subscription',async()=>{
 const {ctx,registry}=setup();try{
  await expect(registry.call(ctx,'raw-observer','usage.read',{provider:'synthetic',usage:'quota',account:null,accountHome:null,model:null,weeklyTokens:null,weeklyUsd:null,quotaSource:null,now:ctx.now,readOnly:true,refresh:false})).rejects.toMatchObject({code:'capability_denied'});
  expect((registry as any).entries.get('raw-observer').readOwner).toBeUndefined();
 }finally{await registry.shutdown();}
});


for(const peer of ['old','no-feature'] as const)test(`actual ${peer} peer cannot use transient-call task reads without observation negotiation`,async()=>{
 const {ctx,registry}=setup('normal',peer);try{
  const result=await registry.call<any>(ctx,'raw-observer','diagnostic.ping',{mode:'reads'});
  const entry=(registry as any).entries.get('raw-observer');
  expect(entry.pluginProtocol).toBe(peer==='old'?'1.4.0':'1.7.0');expect(entry.process.supports('policyObservations')).toBe(false);
  expect(result.codes).toEqual(['capability_denied','capability_denied']);
  expect(entry.readOwner).toBeUndefined();
 }finally{await registry.shutdown();}
});
test('negotiated raw peer retains transient task reads and canonical unknown-task errors',async()=>{
 const {ctx,registry}=setup();try{
  const result=await registry.call<any>(ctx,'raw-observer','diagnostic.ping',{mode:'reads'});
  expect(result.codes).toEqual(['allowed','unknown_task']);
 }finally{await registry.shutdown();}
});
