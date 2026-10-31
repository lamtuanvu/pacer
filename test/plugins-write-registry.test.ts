import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,statSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PluginRegistry} from '../src/plugins/registry';
import {manifestSchema} from '../src/plugins/protocol';
import {makeCtx} from '../src/ctx';
import {manifest} from './fixtures/endpoint-write/peer';
async function fixture(run:(value:any)=>Promise<void>){
 const root=mkdtempSync(join(tmpdir(),'pacer-write-registry-')),home=join(root,'home');mkdirSync(home);
 const ctx=makeCtx({home:root,pacerHome:home}),dir=join(home,'opencode'),path=join(dir,'opencode.json');
 const bundle={manifest:manifestSchema.parse(manifest),main:()=>import('./fixtures/endpoint-write/peer')};
 const registry=new PluginRegistry({bundled:[bundle],spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'fixtures/endpoint-write/peer.ts')],cwd:root,env:{}})});
 const call=(name:string)=>registry.call(ctx,manifest.id,'endpoint.launchEnv',{account:{name,baseUrl:'http://endpoint.invalid',keyRef:null,models:[]},accounts:[],pacerHome:home},{resources:{reads:[],commands:[],stores:[],writes:[{path:dir,kind:'directory',operations:['mkdir']},{path,kind:'file',operations:['write']}]},deadlineMs:5000});
 try{await run({ctx,registry,path,call});}finally{await registry.shutdown();rmSync(root,{recursive:true,force:true});}
}
test('registry negotiates file chunks with a real child and issues pinned write authority before dispatch',async()=>{
 await fixture(async({ctx,registry,path,call})=>{
  expect(await call('normal')).toEqual({env:{OPENCODE_CONFIG:path},secretEnv:{}});
  expect(readFileSync(path,'utf8')).toBe('\ufeff'+'界'.repeat(400000));expect(statSync(path).mode&0o777).toBe(0o600);
  expect(registry.list(ctx).find((p:any)=>p.id===manifest.id)).toMatchObject({state:'ready',enabled:true});expect(registry.list(ctx).find((p:any)=>p.id===manifest.id)!.pid).toBeGreaterThan(0);
 });
});
test('a real child cannot reuse a prior outer call’s write handle after registry revocation',async()=>{
 await fixture(async({ctx,registry,path,call})=>{
  await call('reserve');const pid=registry.list(ctx).find((p:any)=>p.id===manifest.id)!.pid;expect(existsSync(path)).toBe(false);
  expect(await call('reuse')).toEqual({env:{DENIED:'capability_denied'},secretEnv:{}});expect(existsSync(path)).toBe(false);expect(registry.list(ctx).find((p:any)=>p.id===manifest.id)!.pid).toBe(pid);
  await call('normal');expect(readFileSync(path,'utf8')).toBe('\ufeff'+'界'.repeat(400000));
 });
});
