import type {PluginManifest} from '@pacer/plugin';
/** Host materializes configured scopes from the same immutable adapter projection. */
export const manifest={id:'pacer-classify',version:'0.2.0',publisher:'pacer',host:'^1.5',contributes:{classifier:{adapters:['rules','ollama','jev']}},capabilities:[{name:'net.http' as const,scopes:['127.0.0.1','api.typesafe.ai']},{name:'secrets.resolve' as const},{name:'config.get' as const},{name:'log' as const}],reentrant:true,tier:'free' as const} satisfies PluginManifest;
