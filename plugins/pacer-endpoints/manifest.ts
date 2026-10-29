import type { PluginManifest } from '@pacer/plugin';

export const manifest: PluginManifest = {id:'pacer-endpoints',version:'0.2.0',publisher:'pacer',host:'^1.5',contributes:{endpoint:{apis:['openai-compatible']}},capabilities:[{name:'net.http',scopes:['*']},{name:'fs.write',scopes:['${PACER_HOME}/opencode','${PACER_HOME}/opencode/**']},{name:'fs.read',scopes:['${PACER_HOME}/endpoints/test-*/hello.txt']},{name:'secrets.resolve'},{name:'process.spawn',scopes:['git','opencode']}],reentrant:true,tier:'free'} satisfies PluginManifest;
