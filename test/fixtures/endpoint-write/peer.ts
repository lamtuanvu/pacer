import {serve,PluginError,type Handler} from '../../../packages/plugin-sdk/src/index';
import {join} from 'node:path';
export const manifest={id:'fx-endpoint-write',version:'1.0.0',publisher:'fixture',host:'^1.6',contributes:{endpoint:{apis:['openai-compatible']}},capabilities:[{name:'fs.write' as const,scopes:['${PACER_HOME}/opencode','${PACER_HOME}/opencode/**']}]};
let previousHandle:string|undefined;
export const handlers:Record<string,Handler>={'endpoint.launchEnv':async(raw,host)=>{
 const params=raw as {pacerHome:string;account:{name:string}},dir=join(params.pacerHome,'opencode'),path=join(dir,'opencode.json');
 await host.fs.mkdir(dir);
 if(params.account.name==='reserve'){
  previousHandle=(await host.call<{handle:string}>('capability.fs.beginWrite',{path,bytes:1})).handle;
  return {env:{OPENCODE_CONFIG:path},secretEnv:{}};
 }
 if(params.account.name==='reuse'){
  try{await host.call('capability.fs.writeChunk',{handle:previousHandle,offset:0,base64:'YQ=='});return {env:{UNEXPECTED:'accepted'},secretEnv:{}};}
  catch(error){return {env:{DENIED:error instanceof PluginError?error.code:'unexpected'},secretEnv:{}};}
 }
 await host.fs.write(path,'\ufeff'+'界'.repeat(400000),0o600);
 return {env:{OPENCODE_CONFIG:path},secretEnv:{}};
}};
if(import.meta.main)await serve({manifest,handlers});
