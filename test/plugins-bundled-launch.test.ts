import {expect,test} from 'bun:test';
import {bundledPluginSpawn} from '../src/plugins/index';
import {fakeCtx} from './helpers';
import {fileURLToPath} from 'node:url';
const runtime={executable:'/fixture/bin/bun',bunVersion:'1.4.2'};
test('source front door retains wrapper routing but replaces raw selector with this host source',()=>{
 const ctx=fakeCtx({env:{PACER_BIN:'/fixture/guard',PACER_CORE_ARGV:'["/untrusted/selector","private-marker"]',SECRET:'private-marker'}});
 const spec=bundledPluginSpawn(ctx,'pacer-agent-session',runtime);
 expect(spec.cwd).toBe(ctx.pacerHome);
 expect(spec.argv).toEqual(['/fixture/guard','plugin','run','pacer-agent-session']);
 expect(spec.env).toEqual({PACER_CORE_ARGV:JSON.stringify([runtime.executable,fileURLToPath(new URL('../src/cli.ts',import.meta.url))])});
 expect(JSON.stringify(spec.env)).not.toContain('private-marker');
});
test('ordinary guards and compiled core launches do not receive a source selector',()=>{
 const ctx=fakeCtx({env:{PACER_BIN:'/fixture/guard'}});expect(bundledPluginSpawn(ctx,'pacer-agent-session',runtime).env).toEqual({});
 ctx.env.PACER_CORE_ARGV='["/untrusted"]';expect(bundledPluginSpawn(ctx,'pacer-agent-session',{executable:'/fixture/pacer-core',bunVersion:'1.4.2'}).env).toEqual({});
 expect(bundledPluginSpawn(ctx,'pacer-agent-session',{executable:'/fixture/bun'}).env).toEqual({});
});


test('bundled selector crosses the sealed spawn boundary; installed peer keeps five keys', async () => {
 const {spawn}=await import('node:child_process');
 const {PluginRegistry}=await import('../src/plugins/registry');
 const {PLUGIN_PROTOCOL_VERSION}=await import('../src/plugins/protocol');
 const {BUNDLED}=await import('../plugins/bundled');
 const {installFixture}=await import('../conformance/install');
 const {mkdirSync,symlinkSync,rmSync,writeFileSync}=await import('node:fs');
 const {join}=await import('node:path');
 const ctx=fakeCtx({env:{PATH:process.env.PATH,PACER_CORE_ARGV:'raw-marker',SECRET:'secret-marker'}});
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  claude-code: {}\n');
 symlinkSync(join(import.meta.dir,'../node_modules'),join(ctx.home,'node_modules'),'dir');
 const captures:Record<string,string|undefined>[]=[];
 const capture=((file:string,args:string[],options:any)=>{captures.push({...options.env});return spawn(file,args,options);}) as typeof spawn;
 const bundled=new PluginRegistry({bundled:BUNDLED,spawn:capture,spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'../src/cli.ts'),'plugin','run','pacer-agent-session'],cwd:ctx.pacerHome,env:{PACER_CORE_ARGV:'fixed-selector',SECRET:'secret-marker'}})});
 const installed=new PluginRegistry({bundled:[],spawn:capture,spawnBundled:()=>{throw Error('installed invoked bundle launcher');}});
 try {
  expect((await bundled.doctor(ctx,'pacer-agent-session'))[0]?.ok).toBe(true);
  expect(captures[0]).toEqual({PATH:ctx.env.PATH,HOME:ctx.home,PACER_HOME:ctx.pacerHome,PACER_PLUGIN_ID:'pacer-agent-session',PACER_PLUGIN_PROTOCOL:PLUGIN_PROTOCOL_VERSION,PACER_CORE_ARGV:'fixed-selector'});
  await bundled.shutdown();
  installFixture('good',join(ctx.pacerHome,'plugins'));
  await installed.enable(ctx,'fx-good',true);
  expect((await installed.doctor(ctx,'fx-good'))[0]?.ok).toBe(true);
  expect(captures[1]).toEqual({PATH:ctx.env.PATH,HOME:ctx.home,PACER_HOME:ctx.pacerHome,PACER_PLUGIN_ID:'fx-good',PACER_PLUGIN_PROTOCOL:PLUGIN_PROTOCOL_VERSION});
 } finally {await bundled.shutdown();await installed.shutdown();rmSync(ctx.home,{recursive:true,force:true});}
});
