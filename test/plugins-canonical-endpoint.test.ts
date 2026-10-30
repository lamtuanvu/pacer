import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BUNDLED} from '../plugins/bundled';
import {PluginRegistry} from '../src/plugins/registry';
import {makeCtx} from '../src/ctx';
import {discoverEndpointModels} from '../src/plugins/endpoint-adapter';
test('canonical endpoint bundle scopes concurrent unsaved destinations and refuses lookalike wildcard authority',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pacer-canonical-endpoint-'));const seen:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){seen.push(request.headers.get('authorization')??'');return Response.json({data:[{id:'owned'}]});}});
 const ctx=makeCtx({home:root,pacerHome:root});const bundle=BUNDLED.find(value=>value.manifest.id==='pacer-endpoints')!;
 const make=(bundled:typeof BUNDLED)=>new PluginRegistry({bundled,spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'../plugins/pacer-endpoints/index.ts')],cwd:root,env:{}})});
 const registry=make([bundle]),lookalike=make([{...bundle}]);
 try{
 const baseUrl=`http://127.0.0.1:${server.port}/v1`;
 expect(await Promise.all(['key-a-owned','key-b-owned'].map(key=>discoverEndpointModels(ctx,{baseUrl,key},registry)))).toEqual([{listed:true,models:[{id:'owned'}]},{listed:true,models:[{id:'owned'}]}]);
 expect(seen.sort()).toEqual(['Bearer key-a-owned','Bearer key-b-owned']);
 expect(await discoverEndpointModels(ctx,{baseUrl,key:'not-admitted'},lookalike)).toMatchObject({listed:false,error:'unreachable'});expect(seen).toHaveLength(2);
 await expect(registry.call(ctx,bundle.manifest.id,'endpoint.models',{baseUrl,keyRef:null},{resources:{reads:[],commands:[],stores:[],http:{hosts:['*']}},credentialBindings:[]})).rejects.toMatchObject({code:'capability_denied'});
 }finally{await Promise.all([registry.shutdown(),lookalike.shutdown()]);server.stop(true);rmSync(root,{recursive:true,force:true});}
});
