import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PluginRegistry} from '../src/plugins/registry';
import {manifestSchema} from '../src/plugins/protocol';
import {makeCtx} from '../src/ctx';
import {manifest} from './fixtures/endpoint-write/credential-peer';
import {discoverEndpointModels,endpointLaunchSettings} from '../src/plugins/endpoint-adapter';
test('real endpoint child discovers through an owner-bound credential without ambient fallback',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pacer-credential-child-'));let reads=0,requests=0;const observed:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){requests++;observed.push(request.headers.get('authorization')??'');return Response.json({data:[{id:'owned-model'}]});}});
 const ctx=makeCtx({home:root,pacerHome:root});
 const registry=new PluginRegistry({bundled:[{manifest:manifestSchema.parse(manifest),main:()=>import('./fixtures/endpoint-write/credential-peer')}],spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,'fixtures/endpoint-write/credential-peer.ts')],cwd:root,env:{}})});
 const resources={reads:[],commands:[],stores:[],http:{hosts:['127.0.0.1']}};
 try{
 const params={baseUrl:`http://127.0.0.1:${server.port}/v1`,keyRef:'endpoint:selected'};
 const result=await registry.call(ctx,manifest.id,'endpoint.models',params,{resources,credentialBindings:[{ref:'endpoint:selected',resolve:async()=>{reads++;return 'owned-pending-fixture';}}]});
 expect(result).toEqual({listed:true,models:[{id:'owned-model'}]});expect(reads).toBe(1);expect(observed).toEqual(['Bearer owned-pending-fixture']);expect(JSON.stringify(result)).not.toContain('owned-pending-fixture');
 const refused=await registry.call(ctx,manifest.id,'endpoint.models',params,{resources,credentialBindings:[]});
 expect(refused).toEqual({listed:false,error:'unreachable',detail:'Endpoint unreachable. Check the URL and try again.'});expect(requests).toBe(1);
 const adapted=await discoverEndpointModels(ctx,{baseUrl:params.baseUrl,key:'adapter-owned-fixture'},registry);expect(adapted).toEqual({listed:true,models:[{id:'owned-model'}]});expect(observed).toEqual(['Bearer owned-pending-fixture','Bearer adapter-owned-fixture']);
 const account={name:'selected',connection:{api:'openai-compatible',base_url:params.baseUrl,key:'file',models:[]}};const launch=await endpointLaunchSettings(ctx,{selected:account} as any,'selected',registry);const config=JSON.parse(readFileSync(launch.env.OPENCODE_CONFIG!,'utf8'));expect(config.provider['pacer-selected'].options.apiKey).toBe('{env:PACER_KEY_SELECTED}');expect(launch.secretEnv).toEqual({PACER_KEY_SELECTED:'endpoint:selected'});expect(statSync(launch.env.OPENCODE_CONFIG!).mode&0o777).toBe(0o600);
 }finally{await registry.shutdown();server.stop(true);rmSync(root,{recursive:true,force:true});}
});
