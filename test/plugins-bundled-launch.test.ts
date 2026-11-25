import {expect,test} from 'bun:test';
import {bundledPluginSpawn} from '../src/plugins/index';
import {fakeCtx,tmpDir} from './helpers';
import {childEnv} from './child-env';
import {fileURLToPath} from 'node:url';
const runtime={executable:'/fixture/bin/bun',bunVersion:'1.4.2'};
for (const id of ['pacer-agent-session', 'pacer-usage']) {
 test(`${id}: source front runs the SDK example directly with no selector`,()=>{
  const ctx=fakeCtx({env:{PACER_CORE_ARGV:'["/untrusted/selector","private-marker"]',SECRET:'private-marker'}});
  const spec=bundledPluginSpawn(ctx,id,runtime);
  expect(spec.cwd).toBe(ctx.home);
  expect(spec.argv).toEqual([runtime.executable,fileURLToPath(new URL('../examples/plugins/run.ts',import.meta.url)),id]);
  expect(spec.env).toEqual({});
 });
 test(`${id}: a compiled front door passes no selector`,()=>{
  const ctx=fakeCtx({env:{PACER_BIN:'/fixture/guard',PACER_CORE_ARGV:'["/untrusted"]'}});
  expect(bundledPluginSpawn(ctx,id,runtime).argv).toEqual([runtime.executable,fileURLToPath(new URL('../examples/plugins/run.ts',import.meta.url)),id]);
  const compiled=bundledPluginSpawn(ctx,id,{executable:'/fixture/pacer-core'});
  expect(compiled.argv).toEqual(['/fixture/guard','plugin','run',id]);
  expect(compiled.env).toEqual({});
 });
}

test('bundled plugin runs the SDK example; installed peer keeps its sealed environment', async () => {
 const {spawn}=await import('node:child_process');
 const {PluginRegistry}=await import('../src/plugins/registry');
 const {PLUGIN_PROTOCOL_VERSION}=await import('../src/plugins/protocol');
 const {BUNDLED}=await import('../src/plugins/bundled');
 const {installFixture}=await import('../conformance/install');
 const {mkdirSync,symlinkSync,rmSync,writeFileSync}=await import('node:fs');
 const {join}=await import('node:path');
 const ctx=fakeCtx({env:{PATH:process.env.PATH,PACER_CORE_ARGV:'raw-marker',SECRET:'secret-marker'}});
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  claude-code: {}\n');
 symlinkSync(join(import.meta.dir,'../node_modules'),join(ctx.home,'node_modules'),'dir');
 const captures:Record<string,string|undefined>[]=[];
 const capture=((file:string,args:string[],options:any)=>{captures.push({...options.env});return spawn(file,args,{...options,env:{...options.env,PACER_PORT:ctx.env.PACER_PORT}});}) as typeof spawn;
 const bundled=new PluginRegistry({bundled:BUNDLED,spawn:capture,spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'../examples/plugins/run.ts'),'pacer-agent-session'],cwd:ctx.pacerHome,env:{}})});
 const installed=new PluginRegistry({bundled:[],spawn:capture,spawnBundled:()=>{throw Error('installed invoked bundle launcher');}});
 try {
  expect((await bundled.doctor(ctx,'pacer-agent-session'))[0]?.ok).toBe(true);
  expect(captures[0]).toEqual({PATH:ctx.env.PATH,HOME:ctx.home,PACER_HOME:ctx.pacerHome,PACER_PLUGIN_ID:'pacer-agent-session',PACER_PLUGIN_PROTOCOL:PLUGIN_PROTOCOL_VERSION,BUN_RUNTIME_TRANSPILER_CACHE_PATH:""});
  await bundled.shutdown();
  installFixture('good',join(ctx.pacerHome,'plugins'));
  await installed.enable(ctx,'fx-good',true);
  expect((await installed.doctor(ctx,'fx-good'))[0]?.ok).toBe(true);
  expect(captures[1]).toEqual({PATH:ctx.env.PATH,HOME:ctx.home,PACER_HOME:ctx.pacerHome,PACER_PLUGIN_ID:'fx-good',PACER_PLUGIN_PROTOCOL:PLUGIN_PROTOCOL_VERSION,BUN_RUNTIME_TRANSPILER_CACHE_PATH:""});
 } finally {await bundled.shutdown();await installed.shutdown();rmSync(ctx.home,{recursive:true,force:true});}
});

for (const id of ['pacer-endpoints', 'pacer-notify']) {
 test(`${id} pure metadata matches the original awaited direct entry lifecycle`, async () => {
  const {BUNDLED}=await import('../src/plugins/bundled');
  const {PLUGIN_PROTOCOL_VERSION}=await import('../src/plugins/protocol');
  const bundle=BUNDLED.find(item=>item.manifest.id===id)!;
  const entry=fileURLToPath(new URL(`../examples/plugins/${id}/index.ts`,import.meta.url));
  const child=Bun.spawn([process.execPath,entry],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...childEnv(tmpDir()),BUN_RUNTIME_TRANSPILER_CACHE_PATH:''},timeout:5000});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'plugin.hello',params:{protocol:PLUGIN_PROTOCOL_VERSION,pacer:'0.9.0',manifest:bundle.manifest,config:{},grants:[]}})+'\n');
  child.stdin.end();
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,err}).toEqual({code:0,err:''});
  expect(JSON.parse(out)).toMatchObject({jsonrpc:'2.0',id:1,result:{id,version:bundle.manifest.version,contributes:Object.keys(bundle.manifest.contributes)}});
 });
}
