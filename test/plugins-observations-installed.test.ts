import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {installFixture} from '../conformance/install';
import {PluginRegistry} from '../src/plugins/registry';
import {setPluginGrant} from '../src/plugins/config';
import {fakeCtx} from './helpers';

for(const change of ['grant','manifest','remove'] as const)test(`installed observation owner retires synchronously on ${change} change`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'pacer-observation-installed-'));
 symlinkSync(join(import.meta.dir,'..','node_modules'),join(home,'node_modules'),'dir');
 const ctx=fakeCtx({home,pacerHome:join(home,'.pacer'),env:{PATH:`${dirname(process.execPath)}:/usr/bin:/bin`},now:Date.now()/1000});
 mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders: {claude-code: {}}\n');
 const folder=installFixture('observations',join(ctx.pacerHome,'plugins'));
 const registry=new PluginRegistry({bundled:[],spawnBundled:()=>{throw Error('no bundled process');},eventPumpMs:0});
 try{
  expect((await registry.doctor(ctx,'fx-observations'))[0]).toMatchObject({ok:false,state:'needs_grant',pid:null});
  expect((await registry.enable(ctx,'fx-observations',false)).state).toBe('needs_grant');
  await registry.enable(ctx,'fx-observations',true);expect(registry.list(ctx)[0]?.pid).toBeNull();
  expect((await registry.doctor(ctx,'fx-observations'))[0]?.ok).toBe(true);
  const entry=(registry as any).entries.get('fx-observations'),owner=entry.readOwner;
  expect(owner).toBeDefined();owner.assertGranted('tasks.read');
  if(change==='grant')await setPluginGrant(ctx,'fx-observations',null);
  else if(change==='manifest'){
   const manifest=JSON.parse(await Bun.file(join(folder,'pacer-plugin.json')).text());
   manifest.capabilities=manifest.capabilities.filter((c:{name:string})=>c.name!=='tasks.read');writeFileSync(join(folder,'pacer-plugin.json'),JSON.stringify(manifest));
  }else rmSync(folder,{recursive:true});
  registry.refresh(ctx);
  expect(()=>owner.assertActive()).toThrow();expect(entry.readOwner).toBeUndefined();expect((registry as any).eventTimer).toBeUndefined();
 }finally{await registry.shutdown();rmSync(home,{recursive:true,force:true});}
});
