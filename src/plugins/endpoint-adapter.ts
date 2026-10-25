import type {Ctx} from '../types';
import type {PluginRegistry} from './registry';
import {CoreError} from '../core/errors';
import {discoveryResult} from './endpoint-protocol';
import {pluginRegistry} from './index';

/** Host owns credential callbacks and exact destinations; wire input contains references only. */
export async function discoverEndpointModels(ctx:Ctx,input:{baseUrl:string;key?:string|null;timeoutMs?:number},registry:Pick<PluginRegistry,'find'|'call'>=pluginRegistry(ctx)){
 const id=registry.find(ctx,'endpoint',value=>Array.isArray(value.apis)&&value.apis.includes('openai-compatible'));
 if(!id)throw new CoreError('plugin_unavailable','no enabled plugin provides OpenAI-compatible endpoints');
 let host:string;
 try{const url=new URL(input.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();host=url.hostname;}
 catch{return {listed:false as const,error:'invalid_url',detail:'Check the URL and try again.'};}
 const key=input.key||null,ref=key?'endpoint:pending':null;
 const result=await registry.call(ctx,id,'endpoint.models',{baseUrl:input.baseUrl,keyRef:ref,...(input.timeoutMs===undefined?{}:{timeoutMs:input.timeoutMs})},{
  resources:{reads:[],commands:[],stores:[],http:{hosts:[host]}},
  credentialBindings:ref?[{ref,resolve:async()=>key}]:[],
  deadlineMs:(input.timeoutMs??10000)+2000,
 });
 const parsed=discoveryResult.safeParse(result);
 if(!parsed.success)throw new CoreError('plugin_refused','endpoint plugin returned an invalid model list');
 return parsed.data;
}

/** Project managed connection metadata without exposing key storage configuration. */
export function projectEndpointAccounts(accounts:Record<string,import('../config/accounts').AccountCfg>){
 return Object.values(accounts).filter(account=>account.connection).map(account=>({
  name:account.name,baseUrl:account.connection!.base_url,keyRef:account.connection!.key==='none'?null:`endpoint:${account.name}`,
  models:structuredClone(account.connection!.models),
 }));
}

/** Grant only the managed config destination; launch references are checked before host injection. */
async function renderLaunchSettings(ctx:Ctx,accounts:Record<string,import('../config/accounts').AccountCfg>,name:string|null,registry:Pick<PluginRegistry,'find'|'call'>=pluginRegistry(ctx)){
 const projected=projectEndpointAccounts(accounts),account=name===null?null:projected.find(value=>value.name===name);
 if(name!==null&&!account)throw new CoreError('invalid_input','configured endpoint connection required');
 const id=registry.find(ctx,'endpoint',value=>Array.isArray(value.apis)&&value.apis.includes('openai-compatible'));
 if(!id)throw new CoreError('plugin_unavailable','no enabled plugin provides OpenAI-compatible endpoints');
 const {join}=await import('node:path');const dir=join(ctx.pacerHome,'opencode'),path=join(dir,'opencode.json');
 const result=await registry.call(ctx,id,'endpoint.launchEnv',{account,accounts:projected,pacerHome:ctx.pacerHome},{resources:{reads:[],commands:[],stores:[],writes:[{path:dir,kind:'directory',operations:['mkdir']},{path,kind:'file',operations:['write']}]},credentialBindings:[]});
 const expectedSecret=!account?.keyRef?{}:{[`PACER_KEY_${name!.toUpperCase().replaceAll('-','_')}`]:account.keyRef};
 const {ENDPOINT_METHODS}=await import('./endpoint-protocol');const parsed=ENDPOINT_METHODS['endpoint.launchEnv']!.result.safeParse(result);
 if(!parsed.success)throw new CoreError('plugin_refused','endpoint plugin returned invalid launch settings');
 const value=parsed.data as {env:Record<string,string>;secretEnv:Record<string,string>};
 if(Object.keys(value.env).length!==1||value.env.OPENCODE_CONFIG!==path||Object.keys(value.secretEnv).length!==Object.keys(expectedSecret).length||Object.entries(expectedSecret).some(([key,ref])=>value.secretEnv[key]!==ref))throw new CoreError('plugin_refused','endpoint plugin returned unowned launch settings');
 return value;
}

/** Render every managed connection, including an empty provider set after removal. */
export async function writeEndpointConfig(ctx:Ctx,accounts:Record<string,import('../config/accounts').AccountCfg>){
 return (await endpointLaunchSettings(ctx,accounts,null)).env.OPENCODE_CONFIG!;
}

const configWrites=new Map<string,Promise<void>>();
/** Serialize the shared config destination, releasing the queue after either outcome. */
export function queueEndpointConfigWrite<T>(ctx:Pick<Ctx,'pacerHome'>,action:()=>Promise<T>):Promise<T>{
 const previous=configWrites.get(ctx.pacerHome)??Promise.resolve();
 const result=previous.then(action),settled=result.then(()=>{},()=>{});
 configWrites.set(ctx.pacerHome,settled);
 void settled.then(()=>{if(configWrites.get(ctx.pacerHome)===settled)configWrites.delete(ctx.pacerHome);});
 return result;
}
export function endpointLaunchSettings(ctx:Ctx,accounts:Record<string,import('../config/accounts').AccountCfg>,name:string|null,registry:Pick<PluginRegistry,'find'|'call'>=pluginRegistry(ctx)){
 const captured=structuredClone(accounts);
 return queueEndpointConfigWrite(ctx,()=>renderLaunchSettings(ctx,captured,name,registry));
}
