import {expect,test} from 'bun:test';
import {discoverEndpointModels} from '../src/plugins/endpoint-adapter';
import {fakeCtx} from './helpers';
test('host model adapter projects exact destination and owner-private pending key',async()=>{
 const calls:any[]=[];const registry={find:()=> 'owned-endpoint',call:async(...args:any[])=>{calls.push(args);return {listed:true,models:[]};}} as any;
 expect(await discoverEndpointModels(fakeCtx(),{baseUrl:'https://owned.invalid:8443/v1?x=1',key:'private-fixture',timeoutMs:1000},registry)).toEqual({listed:true,models:[]});
 const [,id,method,params,options]=calls[0];expect(id).toBe('owned-endpoint');expect(method).toBe('endpoint.models');expect(params).toEqual({baseUrl:'https://owned.invalid:8443/v1?x=1',keyRef:'endpoint:pending',timeoutMs:1000});
 expect(options.resources.http.hosts).toEqual(['owned.invalid']);expect(options.deadlineMs).toBe(3000);expect(await options.credentialBindings[0].resolve()).toBe('private-fixture');expect(JSON.stringify([params,options.resources])).not.toContain('private-fixture');
});
test('host model adapter has no builtin fallback and rejects malformed plugin results',async()=>{
 await expect(discoverEndpointModels(fakeCtx(),{baseUrl:'https://owned.invalid'},{find:()=>null} as any)).rejects.toMatchObject({code:'plugin_unavailable'});
 await expect(discoverEndpointModels(fakeCtx(),{baseUrl:'https://owned.invalid'},{find:()=> 'owned',call:async()=>({models:[]})} as any)).rejects.toMatchObject({code:'plugin_refused'});
 let called=false;const registry={find:()=> 'owned',call:async()=>{called=true;}} as any;
 expect(await discoverEndpointModels(fakeCtx(),{baseUrl:'https://user:pass@owned.invalid'},registry)).toMatchObject({listed:false,error:'invalid_url'});expect(called).toBe(false);
});
test('account projection excludes native accounts and key source configuration',async()=>{
 const {projectEndpointAccounts}=await import('../src/plugins/endpoint-adapter');
 const account={name:'selected',connection:{api:'openai-compatible',base_url:'https://owned.invalid/v1',key:'env:PRIVATE_ENDPOINT_KEY',models:[{id:'m',context:100,output:10,tools:true}]}};
 const accounts=projectEndpointAccounts({selected:account,native:{name:'native'}} as any);
 expect(accounts).toEqual([{name:'selected',baseUrl:'https://owned.invalid/v1',keyRef:'endpoint:selected',models:account.connection.models}]);
 account.connection.models[0]!.id='changed';expect(accounts[0]!.models[0]!.id).toBe('m');expect(JSON.stringify(accounts)).not.toContain('PRIVATE_ENDPOINT_KEY');
});
test('launch adapter grants exact config paths and refuses unowned env/reference results',async()=>{
 const {endpointLaunchSettings}=await import('../src/plugins/endpoint-adapter');const {join}=await import('node:path');const ctx=fakeCtx();
 const accounts={selected:{name:'selected',connection:{api:'openai-compatible',base_url:'https://owned.invalid',key:'file',models:[]}}} as any;
 const path=join(ctx.pacerHome,'opencode','opencode.json');let options:any;let result:any={env:{OPENCODE_CONFIG:path},secretEnv:{PACER_KEY_SELECTED:'endpoint:selected'}};
 const registry={find:()=> 'owned',call:async(...args:any[])=>{options=args[4];return result;}} as any;
 expect(await endpointLaunchSettings(ctx,accounts,'selected',registry)).toEqual(result);expect(options.credentialBindings).toEqual([]);expect(options.resources.writes).toEqual([{path:join(ctx.pacerHome,'opencode'),kind:'directory',operations:['mkdir']},{path,kind:'file',operations:['write']}]);
 for(const bad of [{env:{OPENCODE_CONFIG:'/outside'},secretEnv:{}},{env:{OPENCODE_CONFIG:path,EXTRA:'value'},secretEnv:{PACER_KEY_SELECTED:'endpoint:selected'}},{env:{OPENCODE_CONFIG:path},secretEnv:{PACER_KEY_SELECTED:'endpoint:other'}}]){result=bad;await expect(endpointLaunchSettings(ctx,accounts,'selected',registry)).rejects.toMatchObject({code:'plugin_refused'});}
});
test('shared config writes serialize snapshots and a failed render releases the next render',async()=>{
 const {endpointLaunchSettings}=await import('../src/plugins/endpoint-adapter');const {join}=await import('node:path');const ctx=fakeCtx();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),seen:string[]=[];let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 const accounts={owned:{name:'owned',connection:{api:'openai-compatible',base_url:'https://owned.invalid',key:'none',models:[{id:'old',context:100,output:10,tools:true}]}}} as any;
 const registry={find:()=> 'owned',call:async(_ctx:any,_id:any,_method:any,params:any)=>{seen.push(params.accounts[0].models[0].id);entered();if(seen.length===1){await gate;throw Error('owned failure');}return {env:{OPENCODE_CONFIG:join(ctx.pacerHome,'opencode/opencode.json')},secretEnv:{}};}} as any;
 const first=endpointLaunchSettings(ctx,accounts,null,registry);const rejected=first.catch(error=>error);accounts.owned.connection.models[0].id='new';const second=endpointLaunchSettings(ctx,accounts,null,registry);await started;expect(seen).toEqual(['old']);release();expect((await rejected).message).toBe('owned failure');await second;expect(seen).toEqual(['old','new']);
});
