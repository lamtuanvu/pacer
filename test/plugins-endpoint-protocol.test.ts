import {MAX_LINE_BYTES} from '../src/plugins/lines';
import {expect,test} from 'bun:test';
import {ENDPOINT_METHODS} from '../src/plugins/endpoint-protocol';
const account={name:'acme',baseUrl:'https://endpoint.invalid/v1',keyRef:'endpoint:acme',models:[{id:'model',context:8192,output:1024,tools:true}]};
test('endpoint models accepts references and preserves local discovery budgets',()=>{
  const method=ENDPOINT_METHODS['endpoint.models'];expect(method).toBeDefined();
  expect(method!.params.parse({baseUrl:account.baseUrl,keyRef:account.keyRef,timeoutMs:1000})).toEqual({baseUrl:account.baseUrl,keyRef:account.keyRef,timeoutMs:1000});
  expect(method!.params.safeParse({baseUrl:account.baseUrl,keyRef:'literal-secret'}).success).toBe(false);
  expect(method!.deadlineMs).toBe(12000);
  expect(method!.result.parse({listed:false,error:'invalid_response',detail:'The endpoint returned an invalid model list.'})).toEqual({listed:false,error:'invalid_response',detail:'The endpoint returned an invalid model list.'});
});
test('endpoint launch returns only plain settings and secret references in separate maps',()=>{
  const method=ENDPOINT_METHODS['endpoint.launchEnv'];expect(method).toBeDefined();
  expect(method!.params.safeParse({account,accounts:[account],pacerHome:'/owned'}).success).toBe(true);
  expect(method!.result.safeParse({env:{OPENCODE_CONFIG:'/owned/opencode/opencode.json'},secretEnv:{PACER_KEY_ACME:'endpoint:acme'}}).success).toBe(true);
  expect(method!.result.safeParse({env:{},secretEnv:{PACER_KEY_ACME:'literal-secret'}}).success).toBe(false);
  expect(method!.deadlineMs).toBe(5000);
});
test('endpoint test has its own fixed budget and structured state without changing native runner checks',()=>{
  const method=ENDPOINT_METHODS['endpoint.test'];expect(method).toBeDefined();
  expect(method!.params.safeParse({account,accounts:[account],runner:{id:'opencode#acme',model:'model'},pacerHome:'/owned',repository:'/owned/endpoints/test-owned',env:{},checkedAt:'2026-10-25T00:00:00.000Z'}).success).toBe(true);
  expect(method!.deadlineMs).toBe(130000);
  expect(method!.result.safeParse({state:'ready',checked_at:'2026-10-25T00:00:00.000Z'}).success).toBe(true);
  expect(method!.result.safeParse({state:'made-up'}).success).toBe(false);
});
import {PLUGIN_PROTOCOL_VERSION,EXTENSION_METHODS,EXTENSION_POINTS,CAPABILITY_METHODS,capabilityOf,CAPABILITIES} from '../src/plugins/protocol';
test('protocol 1.4 registers endpoint methods and write authority without changing the transport line cap',()=>{
 expect(MAX_LINE_BYTES).toBe(1048576);expect(PLUGIN_PROTOCOL_VERSION).toBe('1.5.0');expect(EXTENSION_POINTS).toContain('endpoint');expect(CAPABILITIES).toContain('fs.write');
 expect(EXTENSION_METHODS['endpoint.models']).toBe(ENDPOINT_METHODS['endpoint.models']);
 for(const name of ['write','mkdir','remove','beginWrite','writeChunk','commitWrite','releaseWrite']){
  expect(CAPABILITY_METHODS[`capability.fs.${name}`]).toBeDefined();expect(capabilityOf(`capability.fs.${name}`)).toBe('fs.write');
 }
});
test('spawn wire supports only host-matched cwd and literal or reference environment entries',async()=>{
 const {SCOPED_CAPABILITY_METHODS}=await import('../src/plugins/capability-protocol');const method=SCOPED_CAPABILITY_METHODS['capability.process.spawn']!;
 expect(method.params.safeParse({argv:['opencode','run'],timeoutMs:120000,cwd:'/owned/test',env:{PATH:'/owned/bin',PACER_KEY_SELECTED:{secretRef:'endpoint:selected'}}}).success).toBe(true);
 for(const env of [{KEY:{secretRef:'raw-key'}},{KEY:{secretRef:'endpoint:selected',extra:true}},{KEY:12}])expect(method.params.safeParse({argv:['opencode'],timeoutMs:1000,env}).success).toBe(false);
 expect(method.deadlineMs).toBe(130000);
});
