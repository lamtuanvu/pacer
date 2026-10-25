import {serve,type Handler,type PluginManifest} from '@pacer/plugin';
import {discoverModels,type DiscoveryInput} from './models';
import {launchEnv,type LaunchInput} from './launch-env';
import {testTask,type TestInput} from './test-task';
export const manifest:PluginManifest={id:'pacer-endpoints',version:'0.2.0',publisher:'pacer',host:'^1.4',contributes:{endpoint:{apis:['openai-compatible']}},capabilities:[{name:'net.http',scopes:['*']},{name:'fs.write',scopes:['${PACER_HOME}/opencode','${PACER_HOME}/opencode/**']},{name:'fs.read',scopes:['${PACER_HOME}/endpoints/test-*/hello.txt']},{name:'secrets.resolve'},{name:'process.spawn',scopes:['git','opencode']}],reentrant:true,tier:'free'} satisfies PluginManifest;
export const handlers:Record<string,Handler>={
 'endpoint.test':(raw,host)=>testTask(host,raw as TestInput),
 'endpoint.models':(raw,host)=>discoverModels(host,raw as DiscoveryInput),
 'endpoint.launchEnv':(raw,host)=>launchEnv(host,raw as LaunchInput),
};
if(import.meta.main)await serve({manifest,handlers});
