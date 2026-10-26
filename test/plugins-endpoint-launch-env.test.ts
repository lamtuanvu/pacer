import {expect,test} from 'bun:test';
import {launchEnv} from '../plugins/pacer-endpoints/launch-env';
import {renderOpencodeConfig,type EndpointAccount} from '../plugins/pacer-endpoints/opencode-config';
test('launch config contains all managed accounts but only selected credential reference is returned',async()=>{
 const account:EndpointAccount={name:'selected-key',baseUrl:'https://owned.invalid/v1',keyRef:'endpoint:selected-key',models:[]};
 const other={...account,name:'other',keyRef:'endpoint:other'},writes:unknown[][]=[];
 const fs={mkdir:async(path:string)=>{writes.push(['mkdir',path]);},write:async(...args:unknown[])=>{writes.push(['write',...args]);},remove:async()=>{throw Error('unexpected remove');}};
 const input={account,accounts:[account,other],pacerHome:'/fixture/home'};
 expect(await launchEnv({fs},input)).toEqual({env:{OPENCODE_CONFIG:'/fixture/home/opencode/opencode.json'},secretEnv:{PACER_KEY_SELECTED_KEY:'endpoint:selected-key'}});
 expect(writes).toEqual([['mkdir','/fixture/home/opencode'],['write','/fixture/home/opencode/opencode.json',JSON.stringify(renderOpencodeConfig(input.accounts),null,2)+'\n',0o600]]);
 expect(JSON.stringify(writes)).not.toContain('endpoint:');
});
test('keyless launch never requests credential injection and failed file writes propagate',async()=>{
 const account:EndpointAccount={name:'local',baseUrl:'http://localhost:8000',keyRef:null,models:[]};
 const input={account,accounts:[account],pacerHome:'/fixture/home'};
 const fs={mkdir:async()=>{},write:async()=>{},remove:async()=>{}};
 expect((await launchEnv({fs},input)).secretEnv).toEqual({});
 await expect(launchEnv({fs:{...fs,write:async()=>{throw Error('write refused');}}},input)).rejects.toThrow('write refused');
});
