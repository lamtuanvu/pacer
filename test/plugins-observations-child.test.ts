import {expect,test} from 'bun:test';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fakeCtx} from './helpers';
import {PluginRegistry} from '../src/plugins/registry';
import {pluginLogPath} from '../src/plugins/host';
import {createTask} from '../src/tasks/store';
import {taskData} from '../src/link/pump';
import {publish} from '../src/link/publish';
import type {PluginManifest} from '../src/plugins/protocol';
const manifest:PluginManifest={id:'observe-test',version:'1.0.0',publisher:'pacer',host:'^1.5',contributes:{policy:{}},capabilities:[{name:'tasks.read'},{name:'events.subscribe'},{name:'log'},{name:'config.get'}],reentrant:true,tier:'free'};
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('observation deadline');await Bun.sleep(5);}}
function setup(manual=true){const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders: {claude-code: {}}\n');const registry=new PluginRegistry({bundled:[{manifest,main:async()=>({handlers:{}})}],spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'fixtures/policy-observations/sdk.ts')],cwd:ctx.home,env:{}}),...(manual?{eventPumpMs:0}:{})});return {ctx,registry};}
test('real doctor owns task reads/subscription and callbacks retain only generation task authority',async()=>{
 const {ctx,registry}=setup();const task=createTask(ctx,{brief:{goal:'event task',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 try{
  expect(registry.list(ctx)[0]?.pid).toBeNull();await publish(ctx,[{type:'task',data:taskData(task)}]);
  const [doctor]=await registry.doctor(ctx,'observe-test');expect(doctor?.ok).toBe(true);
  await registry.pumpEvents();await Bun.sleep(20);const log=()=>existsSync(pluginLogPath(ctx,'observe-test'))?readFileSync(pluginLogPath(ctx,'observe-test'),'utf8'):'';expect(log()).not.toContain('"event":"task"');
  await publish(ctx,[{type:'mode',data:{mode:'normal',previous:null,strategy:'default',at:ctx.now}},{type:'task',data:taskData(task)}]);
  await registry.pumpEvents();await until(()=>log().includes('"event":"task"'));
  expect(log()).toContain(`"id":"${task.id}"`);expect(log()).toContain('"callbackHasCall":false');expect(log()).toContain('"callbackHasFs":false');expect(log()).not.toContain('"event":"mode"');
  await registry.disable(ctx,'observe-test');expect((registry as any).eventTimer).toBeUndefined();expect((registry as any).entries.get('observe-test').readOwner).toBeUndefined();
 }finally{await registry.shutdown();}
});
test('manifest/config generation retirement revokes old read owner before a fresh process starts',async()=>{
 const {ctx,registry}=setup();
 try{
  expect((await registry.doctor(ctx,'observe-test'))[0]?.ok).toBe(true);
  const entry=(registry as any).entries.get('observe-test'),oldOwner=entry.readOwner,oldPid=entry.process.pid;
  writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders: {claude-code: {}}\nplugins:\n  config:\n    observe-test: {changed: true}\n');registry.refresh(ctx);
  expect(()=>oldOwner.assertActive()).toThrow();expect(entry.readOwner).toBeUndefined();
  expect((await registry.doctor(ctx,'observe-test'))[0]?.ok).toBe(true);expect(entry.process.pid).not.toBe(oldPid);expect(entry.readOwner.token).not.toBe(oldOwner.token);
 }finally{await registry.shutdown();expect((registry as any).eventTimer).toBeUndefined();}
});

test('registry timer delivers without manual pumping and shutdown removes its handle',async()=>{
 const {ctx,registry}=setup(false);const task=createTask(ctx,{brief:{goal:'timer task',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 try{
  expect((await registry.doctor(ctx,'observe-test'))[0]?.ok).toBe(true);
  await publish(ctx,[{type:'task',data:taskData(task)}]);
  const log=()=>existsSync(pluginLogPath(ctx,'observe-test'))?readFileSync(pluginLogPath(ctx,'observe-test'),'utf8'):'';
  await until(()=>log().includes(`"id":"${task.id}"`));expect((registry as any).eventTimer).toBeDefined();
 }finally{await registry.shutdown();expect((registry as any).eventTimer).toBeUndefined();}
});
